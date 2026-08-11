const db = require('./db')
const credentials = require('./skillCredentials')
const vidiq = require('./vidiqConnector')

const SKILL_ID = 'claritymode-youtube-script-producer'
const VALID_RESULTS = new Set(['working', 'needs_connector', 'needs_approval', 'needs_input', 'ready_for_review', 'failed'])
const PUBLIC_STATUSES = new Set(['queued', 'working', 'needs_input', 'ready_for_review', 'accepted', 'failed', 'cancelled'])
const MAX_INPUT_BYTES = 512 * 1024
const MAX_PROVIDER_BYTES = 2 * 1024 * 1024
const MINDSTUDIO_REMOTE_PREFIX = '@@remote_variable@@'
let timer = null
let running = false
const MAX_TRANSIENT_ATTEMPTS = 3

function configured() {
  return Boolean(
    credentials.configured()
    && String(process.env.MINDSTUDIO_API_KEY || '').trim()
    && String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID || '').trim()
  )
}

function commaSeparatedSet(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))
}

function agentConfigFor(row = {}) {
  const testAgentId = String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_AGENT_ID || '').trim()
  const testUserIds = commaSeparatedSet(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_USER_IDS)
  const useTestAgent = Boolean(testAgentId && testUserIds.has(String(row.user_id || '').trim()))
  return {
    appId: useTestAgent
      ? testAgentId
      : String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID || '').trim(),
    version: useTestAgent
      ? String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_VERSION || '').trim()
      : String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_VERSION || '').trim(),
  }
}

function assignmentFailure(error, row = {}) {
  const message = String(error?.message || error || 'Unknown assignment error').slice(0, 2_000)
  const code = String(error?.code || error?.status || '').slice(0, 120)
  const normalized = `${code} ${message}`.toLowerCase()
  const transient = [
    '429', 'rate limit', 'timeout', 'timed out', 'temporarily unavailable',
    'fetch failed', 'econnreset', 'econnrefused', 'socket hang up',
    'bad gateway', 'service unavailable', 'gateway timeout',
  ].some(fragment => normalized.includes(fragment)) || /^5\d\d$/.test(code)
  const unreadable = normalized.includes('unreadable result') || normalized.includes('invalid assignment result')
  const unavailable = normalized.includes('401') || normalized.includes('403')
    || normalized.includes('unauthorized') || normalized.includes('forbidden')
    || normalized.includes('quota') || normalized.includes('insufficient credit')
  const missingOutlier = normalized.includes('vidiq outlier evidence')
    || normalized.includes('no usable outlier evidence')
    || normalized.includes('no relevant outlier evidence')
  const missingVidIQ = normalized.includes('vidiq evidence') || normalized.includes('vidiq direction')
  const attempt = Number(row.attempt_count || 0) + 1

  return {
    transient,
    retry: transient && attempt < MAX_TRANSIENT_ATTEMPTS,
    attempt,
    internal: {
      name: String(error?.name || 'Error').slice(0, 120),
      code: code || null,
      message,
      stage: String(row.stage || '').slice(0, 120) || null,
      attempt,
      recordedAt: new Date().toISOString(),
    },
    public: missingOutlier
      ? { code: 'vidiq_opportunity_missing', message: 'VidIQ did not find enough breakout evidence for this topic. Try a broader or adjacent idea.' }
      : missingVidIQ
      ? { code: 'vidiq_evidence_missing', message: 'VidIQ did not return usable research for this outline. Your work was preserved; try again.' }
      : unreadable
      ? { code: 'incomplete_result', message: 'ClarityMode received an incomplete result. Your work was preserved; try again.' }
      : unavailable
        ? { code: 'skill_service_unavailable', message: 'This ClarityMode Skill needs service attention. Your work was preserved.' }
        : transient
          ? { code: 'temporary_failure', message: 'The Skill service was temporarily unavailable. Your work was preserved; try again.' }
          : { code: 'assignment_failed', message: 'ClarityMode could not finish this assignment. Your work was preserved; try again.' },
  }
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function publicAssignment(row) {
  const workflowStage = String(row.workflow_state?.stage || '').trim()
  return {
    id: row.id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    projectRef: row.project_ref,
    sourceTask: row.source_task,
    status: row.status,
    stage: row.status === 'failed' && workflowStage ? workflowStage : row.stage,
    progressLabel: row.progress_label,
    approval: row.approval,
    question: row.question,
    artifacts: Array.isArray(row.artifacts) ? row.artifacts : [],
    error: row.public_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
  }
}

function normalizeCreate(input = {}) {
  const normalized = {
    id: String(input.id || '').trim().toLowerCase(),
    clientRequestId: String(input.clientRequestId || '').trim().slice(0, 128),
    skillId: String(input.skillId || '').trim(),
    skillVersion: String(input.skillVersion || '1.0.0').trim().slice(0, 40),
    projectRef: input.projectRef && typeof input.projectRef === 'object' ? input.projectRef : {},
    sourceTask: input.sourceTask && typeof input.sourceTask === 'object' ? input.sourceTask : {},
    brief: input.brief && typeof input.brief === 'object' ? input.brief : {},
    projectContext: input.projectContext && typeof input.projectContext === 'object' ? input.projectContext : {},
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(normalized.id)) throw Object.assign(new Error('Invalid assignment identity.'), { status: 400 })
  if (!normalized.clientRequestId) throw Object.assign(new Error('A request identity is required.'), { status: 400 })
  if (normalized.skillId !== SKILL_ID) throw Object.assign(new Error('That ClarityMode Skill is not available.'), { status: 400 })
  if (!String(normalized.projectRef.path || '').trim()) throw Object.assign(new Error('A project is required.'), { status: 400 })
  if (!String(normalized.sourceTask.id || '').trim() || !String(normalized.sourceTask.text || '').trim()) {
    throw Object.assign(new Error('Choose a project task to hand to ClarityMode.'), { status: 400 })
  }
  if (jsonSize(normalized) > MAX_INPUT_BYTES) throw Object.assign(new Error('That assignment contains too much context.'), { status: 413 })
  return normalized
}

function parseAgentResult(value) {
  let result = value
  for (let depth = 0; depth < 6; depth += 1) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (VALID_RESULTS.has(result.status)) break
      if (result.result !== undefined) {
        result = result.result
        continue
      }
      if (result.finalResponse !== undefined) {
        result = result.finalResponse
        continue
      }
      break
    }
    if (typeof result === 'string') {
      const clean = result.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')
      try {
        result = JSON.parse(clean)
        continue
      } catch {
        throw new Error('The Skill returned an unreadable result.')
      }
    }
    break
  }
  if (!result || typeof result !== 'object' || !VALID_RESULTS.has(result.status)) {
    throw new Error('The Skill returned an invalid result.')
  }
  const status = result.status
  return {
    status,
    stage: String(result.stage || result.status).slice(0, 100),
    progress: { label: String(result.progress?.label || 'ClarityMode is working...').slice(0, 300) },
    state: result.state && typeof result.state === 'object' ? result.state : {},
    connectorRequest: result.connectorRequest && typeof result.connectorRequest === 'object' ? result.connectorRequest : null,
    approval: status === 'needs_approval' && result.approval && typeof result.approval === 'object' ? result.approval : null,
    question: status === 'needs_input' && result.question && typeof result.question === 'object' ? result.question : null,
    artifacts: status === 'ready_for_review' && Array.isArray(result.artifacts) ? result.artifacts.slice(0, 20) : [],
    outline: status === 'ready_for_review' && result.outline && typeof result.outline === 'object' && !Array.isArray(result.outline)
      ? result.outline
      : null,
    evidenceUsed: result.evidenceUsed && typeof result.evidenceUsed === 'object' ? result.evidenceUsed : {},
    error: result.error && typeof result.error === 'object'
      ? { code: String(result.error.code || 'skill_failed').slice(0, 100), message: String(result.error.message || 'ClarityMode could not finish this assignment.').slice(0, 500) }
      : null,
  }
}

function usefulEvidence(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'number' || typeof value === 'boolean') return true
  if (typeof value === 'string') {
    const clean = value.trim()
    return clean.length >= 8 && !/^(?:none|null|undefined|no (?:data|results?|metrics?)|not available)$/i.test(clean)
  }
  if (Array.isArray(value)) return value.some(usefulEvidence)
  if (typeof value === 'object') return Object.values(value).some(usefulEvidence)
  return false
}

function validVidIQUsage(value) {
  if (!value || typeof value !== 'object') return false
  if (value.hasUsableOutlierEvidence === false || value.usableOpportunity === false) return false
  const queries = Array.isArray(value.queries) ? value.queries.map(item => String(item || '').trim()).filter(Boolean) : []
  const decisions = Array.isArray(value.decisions) ? value.decisions.map(item => String(item || '').trim()).filter(Boolean) : []
  const summary = String(value.summary || value.primaryKeyword || value.titleDecision || '').trim()
  return queries.length > 0 && (decisions.length > 0 || summary.length >= 12)
}

function declaresNoUsableVidIQOpportunity(value) {
  const fragments = []
  const visit = current => {
    if (current === null || current === undefined) return
    if (typeof current === 'string') {
      fragments.push(current)
      return
    }
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (typeof current === 'object') Object.values(current).forEach(visit)
  }
  visit(value)
  const text = fragments.join(' ').replace(/\s+/g, ' ').toLowerCase()
  return [
    /no (?:usable|relevant|meaningful) (?:vidiq |breakout |outlier |keyword )*(?:evidence|data|signal|results?|opportunit(?:y|ies)|outliers?)/,
    /no .*outliers? relevant to (?:this|the) (?:topic|idea|angle|channel)/,
    /none (?:of (?:the|these) )?(?:results?|outliers?|videos?) (?:were|was|are|is) relevant/,
    /(?:outlier|keyword|vidiq) (?:data|evidence|results?) (?:returned|surfaced|provided|found) no (?:usable|relevant|meaningful)/,
    /no (?:title|hook|positioning|outline|creative) (?:choice|decision|direction).*shaped by vidiq/,
    /proceed(?:s|ed|ing)? (?:without|on .* rather than) (?:usable |relevant )*(?:vidiq|outlier|keyword|external trend) (?:data|evidence|signal)/,
  ].some(pattern => pattern.test(text))
}

function hasOutlierEvidence(results) {
  return Array.isArray(results) && results.some(item => usefulEvidence(item?.evidence?.outliers))
}

function cleanOutlineText(value, maxLength = 5000) {
  return String(value || '').trim().slice(0, maxLength)
}

function outlineList(value, maxItems = 20) {
  return Array.isArray(value)
    ? value.map(item => cleanOutlineText(item, 1000)).filter(Boolean).slice(0, maxItems)
    : []
}

function renderStructuredYouTubeOutline(outline) {
  if (!outline || typeof outline !== 'object') return ''
  const title = cleanOutlineText(outline.title, 300)
  const titles = outlineList(outline.alternativeTitles || outline.titleIdeas, 10)
  const hooks = outlineList(outline.hooks, 10)
  const coreArgument = cleanOutlineText(outline.coreArgument || outline.angle, 3000)
  const sections = Array.isArray(outline.sections) ? outline.sections.slice(0, 30) : []
  const closing = cleanOutlineText(outline.closing, 3000)
  const callToAction = cleanOutlineText(outline.callToAction || outline.cta, 2000)
  if (!title || hooks.length < 1 || !coreArgument || sections.length < 1) return ''

  const lines = [`# ${title}`, '', '## Alternative title ideas']
  lines.push(...(titles.length ? titles : [title]).map(item => `- ${item}`))
  lines.push('', '## Hook options', ...hooks.map(item => `- ${item}`), '', '## Core argument', coreArgument, '', '## Detailed outline')
  for (const [index, section] of sections.entries()) {
    if (typeof section === 'string') {
      lines.push(`- ${cleanOutlineText(section, 2000)}`)
      continue
    }
    const heading = cleanOutlineText(section?.heading || section?.title, 300) || `Section ${index + 1}`
    const bullets = outlineList(section?.bullets || section?.points, 30)
    lines.push(`### ${heading}`)
    lines.push(...bullets.map(item => `- ${item}`))
    if (section?.content) lines.push(cleanOutlineText(section.content, 5000))
    lines.push('')
  }
  lines.push('## Closing and call to action')
  if (closing) lines.push(closing, '')
  if (callToAction) lines.push(`**Call to action:** ${callToAction}`)
  return lines.join('\n').trim()
}

function outlierCandidates(value, results = []) {
  if (!value || results.length >= 5) return results
  if (Array.isArray(value)) {
    for (const item of value) outlierCandidates(item, results)
    return results
  }
  if (typeof value !== 'object') return results
  const title = cleanOutlineText(value.title || value.videoTitle || value.name, 300)
  const score = value.outlierScore ?? value.outlier_score ?? value.multiplier ?? value.score
  const views = value.views ?? value.viewCount ?? value.view_count
  if (title && (score !== undefined || views !== undefined)) results.push({ title, score, views })
  for (const nested of Object.values(value)) outlierCandidates(nested, results)
  return results
}

function renderVidIQPerformanceSection(vidiq, usage) {
  const queries = [
    ...(Array.isArray(usage?.queries) ? usage.queries : []),
    ...(Array.isArray(vidiq?.queries) ? vidiq.queries : []),
    ...(Array.isArray(vidiq?.results) ? vidiq.results.map(item => item?.query) : []),
  ].map(item => cleanOutlineText(item, 300)).filter(Boolean)
  const uniqueQueries = [...new Set(queries)].slice(0, 8)
  const decisions = outlineList(usage?.decisions, 10)
  const summary = cleanOutlineText(usage?.summary || usage?.titleDecision || usage?.primaryKeyword, 2000)
  const candidates = outlierCandidates((vidiq?.results || []).map(item => item?.evidence?.outliers))
  const lines = ['## Why this idea can perform']
  if (summary) lines.push(summary)
  if (uniqueQueries.length) lines.push('', `**VidIQ searches:** ${uniqueQueries.join(', ')}`)
  if (candidates.length) {
    lines.push('', '**Breakout evidence:**')
    for (const candidate of candidates) {
      const details = []
      if (candidate.score !== undefined) details.push(`${candidate.score}x outlier score`)
      if (candidate.views !== undefined) details.push(`${candidate.views} views`)
      lines.push(`- ${candidate.title}${details.length ? ` (${details.join(', ')})` : ''}`)
    }
  }
  if (decisions.length) lines.push('', '**How the evidence shaped this outline:**', ...decisions.map(item => `- ${item}`))
  return lines.join('\n').trim()
}

function canonicalizeYouTubeArtifacts(result, vidiq) {
  const structured = renderStructuredYouTubeOutline(result.outline)
  const existingArtifacts = Array.isArray(result.artifacts) ? result.artifacts : []
  const firstArtifact = existingArtifacts.find(artifact => cleanOutlineText(artifact?.content).length >= 200)
  const body = structured || cleanOutlineText(firstArtifact?.content, 200000)
  if (!body) throw new Error('The Skill returned an incomplete YouTube outline.')

  const performance = renderVidIQPerformanceSection(vidiq, result.evidenceUsed?.vidiq)
  const alreadyHasPerformance = /^#{1,6}\s+.*(?:perform|reach|outlier|breakout|vidiq|opportunity).*$/im.test(body)
  const content = alreadyHasPerformance ? body : `${performance}\n\n${body}`
  const title = cleanOutlineText(firstArtifact?.title || result.outline?.title || 'YouTube outline', 300)
  return [{ ...(firstArtifact || {}), title, content }]
}

function enforceYouTubeVidIQGate(row, result, connectorEvidence = {}) {
  if (result.status !== 'ready_for_review') return result
  const vidiq = connectorEvidence.vidiq || row.connector_evidence?.vidiq
  if (!vidiq || !Array.isArray(vidiq.results) || !vidiq.results.some(item => usefulEvidence(item?.evidence))) {
    throw new Error('The Skill tried to finish without usable VidIQ evidence.')
  }
  if (!hasOutlierEvidence(vidiq.results)) {
    throw new Error('The Skill tried to finish without usable VidIQ outlier evidence.')
  }
  const artifactText = result.artifacts.map(artifact => String(artifact?.content || '')).join('\n')
  if (declaresNoUsableVidIQOpportunity({ evidenceUsed: result.evidenceUsed?.vidiq, artifactText })) {
    throw new Error('The Skill tried to finish after determining that VidIQ had no usable outlier evidence.')
  }
  const mentionsAQuery = (Array.isArray(vidiq.queries) ? vidiq.queries : [])
    .some(query => artifactText.toLowerCase().includes(String(query || '').trim().toLowerCase()))
  if (!validVidIQUsage(result.evidenceUsed?.vidiq) && !mentionsAQuery) {
    throw new Error('The Skill did not explain how it used the VidIQ evidence.')
  }
  return { ...result, artifacts: canonicalizeYouTubeArtifacts(result, vidiq) }
}

function enforceYouTubeInterviewGate(row, result) {
  if (result.status !== 'needs_approval' || result.stage !== 'await_approval') return result
  const brainDump = String(row.brief?.brainDump || '').trim()
  const answers = result.state?.interviewResult?.interview?.answers
  const hasCreatorAnswer = Array.isArray(answers)
    && answers.some(item => String(item?.answer || '').trim().length >= 20)
  if (hasCreatorAnswer || brainDump.length >= 80) return result
  return {
    ...result,
    status: 'needs_input',
    stage: 'await_interview',
    progress: { label: 'ClarityMode needs your point of view before it builds the outline.' },
    state: { ...(result.state || {}), stage: 'await_interview' },
    approval: null,
    question: {
      id: 'firsthand-angle',
      kind: 'creator_interview',
      prompt: 'What have you personally experienced or observed that makes your take on this different from the usual advice?',
    },
    artifacts: [],
    error: null,
  }
}

function hiddenDirectionResponse(result, connectorEvidence = {}) {
  if (result?.status !== 'needs_approval') return null
  if (!hasOutlierEvidence(connectorEvidence.vidiq?.results)) {
    throw new Error('The Skill tried to continue without usable VidIQ outlier evidence.')
  }
  if (declaresNoUsableVidIQOpportunity({ evidenceUsed: result.evidenceUsed?.vidiq, approval: result.approval })) {
    throw new Error('The Skill tried to continue after determining that VidIQ had no usable outlier evidence.')
  }
  return {
    approved: true,
    direction: result.approval?.data || result.approval || {},
  }
}

function parseJsonValue(value) {
  let parsed = value
  for (let depth = 0; depth < 6 && typeof parsed === 'string'; depth += 1) {
    const clean = parsed.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')
    try {
      parsed = JSON.parse(clean)
    } catch {
      break
    }
  }
  return parsed
}

function mindStudioRemoteUrl(value) {
  if (typeof value !== 'string' || !value.startsWith(MINDSTUDIO_REMOTE_PREFIX)) return null
  const raw = value.slice(MINDSTUDIO_REMOTE_PREFIX.length).trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('The Skill returned an invalid large result reference.')
  }
  if (url.protocol !== 'https:' || !/^youai-appdata-private\.s3\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname)) {
    throw new Error('The Skill returned an untrusted large result reference.')
  }
  return url.toString()
}

async function resolveProviderValue(value, fetchImpl = fetch, remoteDepth = 0, structuralDepth = 0) {
  if (remoteDepth > 8) throw new Error('The Skill returned a result with too many nested references.')
  if (structuralDepth > 64) throw new Error('The Skill returned a result that is too deeply structured.')
  const remoteUrl = mindStudioRemoteUrl(value)
  if (remoteUrl) {
    const response = await fetchImpl(remoteUrl, { redirect: 'error' })
    if (!response?.ok) throw new Error('The Skill finished, but its result could not be downloaded.')
    const declaredSize = Number(response.headers?.get?.('content-length') || 0)
    if (declaredSize > MAX_PROVIDER_BYTES) throw new Error('The Skill returned a result that is too large.')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_PROVIDER_BYTES) throw new Error('The Skill returned a result that is too large.')
    return resolveProviderValue(parseJsonValue(bytes.toString('utf8')), fetchImpl, remoteDepth + 1, 0)
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(item => resolveProviderValue(item, fetchImpl, remoteDepth, structuralDepth + 1)))
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveProviderValue(item, fetchImpl, remoteDepth, structuralDepth + 1)]))
    return Object.fromEntries(entries)
  }
  return value
}

async function invokeAgent(row, { connectorResults = {}, humanResponse = {} } = {}, deps = {}) {
  const apiKey = String(process.env.MINDSTUDIO_API_KEY || '').trim()
  const { appId, version } = agentConfigFor(row)
  if (!apiKey || !appId) throw new Error('This ClarityMode Skill is temporarily unavailable.')
  const loadSdk = deps.loadSdk || (() => import('@mindstudio-ai/agent'))
  const sdk = await loadSdk()
  const MindStudioAgent = deps.MindStudioAgent || sdk.MindStudioAgent
  const client = new MindStudioAgent({ apiKey })
  const operation = Object.keys(row.workflow_state || {}).length ? 'resume' : 'start'
  const response = await client.runAgent({
    appId,
    workflow: 'Main.flow',
    variables: {
      operation,
      assignmentId: row.id,
      skillId: row.skill_id,
      skillVersion: row.skill_version,
      projectContext: JSON.stringify(row.project_context || {}),
      sourceTask: JSON.stringify(row.source_task || {}),
      brief: JSON.stringify(row.brief || {}),
      state: JSON.stringify(row.workflow_state || {}),
      connectorResults: JSON.stringify(connectorResults || {}),
      humanResponse: JSON.stringify(humanResponse || {}),
    },
    ...(version ? { version } : {}),
  })
  // MindStudio may include older thread messages alongside the current result.
  // Those messages can contain expired private large-file references. They are
  // history, not the assignment result, and must not be dereferenced here.
  const currentResult = response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'result')
    ? response.result
    : response
  const resolvedResult = await resolveProviderValue(currentResult, deps.fetchImpl || fetch)
  return { result: parseAgentResult(resolvedResult), threadId: String(response?.threadId || '') }
}

async function readCredential(userId, connectorId) {
  const result = await db.query(
    'SELECT encrypted_value FROM skill_connector_credentials WHERE user_id = $1 AND connector_id = $2',
    [userId, connectorId],
  )
  return result.rows[0]?.encrypted_value ? credentials.decrypt(result.rows[0].encrypted_value) : ''
}

async function persistResult(row, result, providerThreadId, connectorEvidence = row.connector_evidence || {}) {
  const status = result.status === 'working' ? 'queued' : result.status
  if (!PUBLIC_STATUSES.has(status)) throw new Error('The Skill returned an unsupported state.')
  await db.query(
    `UPDATE skill_assignments
        SET status = $2, stage = $3, progress_label = $4, workflow_state = $5,
            connector_request = $6, approval = $7, question = $8, artifacts = $9,
            public_error = $10, internal_error = NULL, pending_response = NULL, provider_thread_id = $11,
            connector_evidence = $12,
            run_started_at = NULL, updated_at = now()
      WHERE id = $1`,
    [
      row.id,
      status,
      result.stage,
      result.progress.label,
      result.state,
      result.connectorRequest,
      result.approval,
      result.question,
      JSON.stringify(result.artifacts),
      result.error,
      providerThreadId,
      connectorEvidence,
    ],
  )
}

function sameQueries(left, right) {
  const normalize = value => [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim().toLowerCase()).filter(Boolean))].sort()
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function revisionResearchQueries(row) {
  const candidates = [
    row.brief?.seedIdea,
    row.source_task?.text,
    ...(Array.isArray(row.artifacts) ? row.artifacts.map(artifact => artifact?.title) : []),
  ]
  const seen = new Set()
  return candidates
    .map(value => String(value || '').trim())
    .filter(value => {
      if (!value) return false
      const key = value.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 3)
}

function needsRevisionEvidenceRecovery(row, connectorEvidence = {}, humanResponse = {}) {
  const workflowStage = String(row.workflow_state?.stage || '')
  const isRevisionResume = workflowStage === 'ready_for_review'
    && (Boolean(String(humanResponse?.revisionNotes || '').trim()) || humanResponse?.retry === true)
  return isRevisionResume
    && !hasOutlierEvidence(connectorEvidence.vidiq?.results)
    && revisionResearchQueries(row).length > 0
}

async function processAssignment(row, deps = {}) {
  let current = row
  let connectorEvidence = current.connector_evidence && typeof current.connector_evidence === 'object' ? current.connector_evidence : {}
  let connectorResults = connectorEvidence.vidiq?.results
    ? { vidiqEvidence: connectorEvidence.vidiq.results }
    : {}
  let humanResponse = current.pending_response || {}
  if (needsRevisionEvidenceRecovery(current, connectorEvidence, humanResponse)) {
    const apiKey = await readCredential(current.user_id, 'vidiq')
    if (!apiKey) throw new Error('VidIQ evidence is required before this outline can be revised.')
    const queries = revisionResearchQueries(current)
    const results = await (deps.researchVidiq || vidiq.research)(apiKey, queries, deps.fetchImpl)
    connectorEvidence = {
      ...connectorEvidence,
      vidiq: { queries, retrievedAt: new Date().toISOString(), results },
    }
    connectorResults = { vidiqEvidence: results }
    await db.query(
      `UPDATE skill_assignments
          SET connector_evidence = $2,
              progress_label = 'VidIQ research received; revising the outline...', updated_at = now()
        WHERE id = $1`,
      [current.id, connectorEvidence],
    )
    current = { ...current, connector_evidence: connectorEvidence }
  }
  for (let pass = 0; pass < 6; pass += 1) {
    const invocation = await invokeAgent(current, { connectorResults, humanResponse }, deps)
    const result = enforceYouTubeInterviewGate(current, invocation.result)
    // Older workflow revisions paused for a separate direction approval. That
    // gate is intentionally internal now: VidIQ evidence and the interview
    // shape the outline, while the user reviews only the finished deliverable.
    if (result.status === 'needs_approval') {
      const response = hiddenDirectionResponse(result, connectorEvidence)
      current = {
        ...current,
        workflow_state: result.state,
        connector_evidence: connectorEvidence,
        pending_response: null,
      }
      connectorResults = { vidiqEvidence: connectorEvidence.vidiq.results }
      humanResponse = response
      continue
    }
    if (result.status !== 'needs_connector') {
      const enforced = enforceYouTubeVidIQGate(current, result, connectorEvidence)
      await persistResult(current, enforced, invocation.threadId, connectorEvidence)
      return
    }
    if (result.connectorRequest?.connector !== 'vidiq' || result.connectorRequest?.operation !== 'keyword_research') {
      throw new Error('That Skill requested an unsupported connection.')
    }
    const apiKey = await readCredential(current.user_id, 'vidiq')
    if (!apiKey) {
      await persistResult(current, {
        ...result,
        status: 'needs_input',
        stage: 'connect_vidiq',
        progress: { label: 'Connect VidIQ to continue this assignment.' },
        question: { id: 'connect-vidiq', kind: 'connector_required', connector: 'vidiq', prompt: 'Connect VidIQ to continue.' },
        connectorRequest: null,
      }, invocation.threadId)
      return
    }
    const requestedQueries = result.connectorRequest.queries
    const cached = connectorEvidence.vidiq
    const canReuseCachedOpportunity = cached
      && sameQueries(cached.queries, requestedQueries)
      && hasOutlierEvidence(cached.results)
    if (!canReuseCachedOpportunity) {
      await db.query(
        `UPDATE skill_assignments
            SET progress_label = 'Finding VidIQ outliers and keyword opportunities...', updated_at = now()
          WHERE id = $1`,
        [current.id],
      )
    }
    const results = canReuseCachedOpportunity
      ? cached.results
      : await vidiq.research(apiKey, requestedQueries, deps.fetchImpl)
    connectorEvidence = {
      ...connectorEvidence,
      vidiq: {
        queries: Array.isArray(requestedQueries) ? requestedQueries : [],
        retrievedAt: cached && results === cached.results ? cached.retrievedAt : new Date().toISOString(),
        results,
      },
    }
    await db.query(
      `UPDATE skill_assignments
          SET workflow_state = $2, connector_evidence = $3, provider_thread_id = $4,
              progress_label = 'VidIQ research received; building the outline...', updated_at = now()
        WHERE id = $1`,
      [current.id, result.state, connectorEvidence, invocation.threadId],
    )
    connectorResults = { vidiqEvidence: results }
    humanResponse = {}
    current = { ...current, workflow_state: result.state, connector_evidence: connectorEvidence, pending_response: null }
  }
  throw new Error('The Skill could not finish its connector work.')
}

async function claimNext() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT * FROM skill_assignments
        WHERE status = 'queued'
           OR (status = 'working' AND run_started_at < now() - interval '10 minutes')
        ORDER BY updated_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    )
    const row = result.rows[0]
    if (!row) {
      await client.query('COMMIT')
      return null
    }
    await client.query(
      `UPDATE skill_assignments
          SET status = 'working', progress_label = 'ClarityMode is working...',
              run_started_at = now(), attempt_count = attempt_count + 1, updated_at = now()
        WHERE id = $1`,
      [row.id],
    )
    await client.query('COMMIT')
    return { ...row, status: 'working' }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function workOnce(deps = {}) {
  if (running || !configured()) return false
  running = true
  try {
    const row = await claimNext()
    if (!row) return false
    try {
      await processAssignment(row, deps)
    } catch (error) {
      const failure = assignmentFailure(error, row)
      console.error('[skill-assignments] Assignment failed', {
        assignmentId: row.id,
        stage: row.stage || null,
        attempt: failure.attempt,
        retrying: failure.retry,
        error: failure.internal.message,
      })
      if (failure.retry) {
        await db.query(
          `UPDATE skill_assignments
              SET status = 'queued', progress_label = 'The Skill service paused; retrying safely...',
                  public_error = NULL, internal_error = $2, run_started_at = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id, failure.internal],
        )
      } else {
        await db.query(
          `UPDATE skill_assignments
              SET status = 'failed', progress_label = 'This assignment needs attention.',
                  public_error = $2, internal_error = $3, run_started_at = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id, failure.public, failure.internal],
        )
      }
    }
    return true
  } finally {
    running = false
  }
}

function start() {
  if (timer) return
  timer = setInterval(() => workOnce().catch(() => {}), 3_000)
  timer.unref?.()
  workOnce().catch(() => {})
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  SKILL_ID,
  agentConfigFor,
  configured,
  assignmentFailure,
  enforceYouTubeInterviewGate,
  enforceYouTubeVidIQGate,
  hasOutlierEvidence,
  hiddenDirectionResponse,
  invokeAgent,
  normalizeCreate,
  parseAgentResult,
  persistResult,
  publicAssignment,
  needsRevisionEvidenceRecovery,
  revisionResearchQueries,
  resolveProviderValue,
  start,
  stop,
  workOnce,
}
