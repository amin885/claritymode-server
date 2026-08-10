const db = require('./db')
const credentials = require('./skillCredentials')
const vidiq = require('./vidiqConnector')

const SKILL_ID = 'claritymode-youtube-script-producer'
const VALID_RESULTS = new Set(['working', 'needs_connector', 'needs_approval', 'needs_input', 'ready_for_review', 'failed'])
const PUBLIC_STATUSES = new Set(['queued', 'working', 'needs_approval', 'needs_input', 'ready_for_review', 'accepted', 'failed', 'cancelled'])
const MAX_INPUT_BYTES = 512 * 1024
const MAX_PROVIDER_BYTES = 2 * 1024 * 1024
const MINDSTUDIO_REMOTE_PREFIX = '@@remote_variable@@'
let timer = null
let running = false

function configured() {
  return Boolean(
    credentials.configured()
    && String(process.env.MINDSTUDIO_API_KEY || '').trim()
    && String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID || '').trim()
  )
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function publicAssignment(row) {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    projectRef: row.project_ref,
    sourceTask: row.source_task,
    status: row.status,
    stage: row.stage,
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
  return {
    status: result.status,
    stage: String(result.stage || result.status).slice(0, 100),
    progress: { label: String(result.progress?.label || 'ClarityMode is working...').slice(0, 300) },
    state: result.state && typeof result.state === 'object' ? result.state : {},
    connectorRequest: result.connectorRequest && typeof result.connectorRequest === 'object' ? result.connectorRequest : null,
    approval: result.approval && typeof result.approval === 'object' ? result.approval : null,
    question: result.question && typeof result.question === 'object' ? result.question : null,
    artifacts: Array.isArray(result.artifacts) ? result.artifacts.slice(0, 20) : [],
    error: result.error && typeof result.error === 'object'
      ? { code: String(result.error.code || 'skill_failed').slice(0, 100), message: String(result.error.message || 'ClarityMode could not finish this assignment.').slice(0, 500) }
      : null,
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
  const appId = String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID || '').trim()
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
    ...(String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_VERSION || '').trim()
      ? { version: String(process.env.MINDSTUDIO_YOUTUBE_PRODUCER_VERSION).trim() }
      : {}),
  })
  const resolvedResponse = await resolveProviderValue(response, deps.fetchImpl || fetch)
  return { result: parseAgentResult(resolvedResponse), threadId: String(response?.threadId || resolvedResponse?.threadId || '') }
}

async function readCredential(userId, connectorId) {
  const result = await db.query(
    'SELECT encrypted_value FROM skill_connector_credentials WHERE user_id = $1 AND connector_id = $2',
    [userId, connectorId],
  )
  return result.rows[0]?.encrypted_value ? credentials.decrypt(result.rows[0].encrypted_value) : ''
}

async function persistResult(row, result, providerThreadId) {
  const status = result.status === 'working' ? 'queued' : result.status
  if (!PUBLIC_STATUSES.has(status)) throw new Error('The Skill returned an unsupported state.')
  await db.query(
    `UPDATE skill_assignments
        SET status = $2, stage = $3, progress_label = $4, workflow_state = $5,
            connector_request = $6, approval = $7, question = $8, artifacts = $9,
            public_error = $10, pending_response = NULL, provider_thread_id = $11,
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
    ],
  )
}

async function processAssignment(row, deps = {}) {
  let current = row
  let connectorResults = {}
  let humanResponse = current.pending_response || {}
  for (let pass = 0; pass < 4; pass += 1) {
    const invocation = await invokeAgent(current, { connectorResults, humanResponse }, deps)
    const result = invocation.result
    if (result.status !== 'needs_connector') {
      await persistResult(current, result, invocation.threadId)
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
    connectorResults = { vidiqEvidence: await vidiq.research(apiKey, result.connectorRequest.queries, deps.fetchImpl) }
    humanResponse = {}
    current = { ...current, workflow_state: result.state, pending_response: null }
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
      console.error('[skill-assignments] Assignment failed', {
        assignmentId: row.id,
        stage: row.stage || null,
        error: error?.message || String(error),
      })
      await db.query(
        `UPDATE skill_assignments
            SET status = 'failed', stage = 'failed', progress_label = 'This assignment needs attention.',
                public_error = $2, run_started_at = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id, { code: 'assignment_failed', message: 'ClarityMode could not finish this assignment. Your work was preserved; try again.' }],
      )
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
  configured,
  invokeAgent,
  normalizeCreate,
  parseAgentResult,
  persistResult,
  publicAssignment,
  resolveProviderValue,
  start,
  stop,
  workOnce,
}
