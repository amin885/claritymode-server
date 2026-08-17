const crypto = require('crypto')
const db = require('./db')
const skillRunner = require('./skillRunner')
const connectorBroker = require('./skillConnectorBroker')
const { validateArtifacts, validateManifest } = require('./skillContract')

const SKILL_ID = 'claritymode-youtube-script-producer'
const PUBLIC_STATUSES = new Set(['queued', 'working', 'needs_input', 'ready_for_review', 'accepted', 'failed', 'cancelled'])
const MAX_INPUT_BYTES = 512 * 1024
const MAX_TRANSIENT_ATTEMPTS = 3
let timer = null
let running = false

function configured() {
  return skillRunner.configured('mastra')
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
  const unavailable = normalized.includes('401') || normalized.includes('403')
    || normalized.includes('unauthorized') || normalized.includes('forbidden')
    || normalized.includes('quota') || normalized.includes('insufficient credit')
  const connectorCreditsExhausted = normalized.includes('vidiq_credits_exhausted')
    || normalized.includes('not enough credits') || normalized.includes('credits remaining')
    || normalized.includes('credit balance')
  const attempt = Number(row.attempt_count || 0) + 1
  return {
    transient,
    retry: transient && attempt < MAX_TRANSIENT_ATTEMPTS,
    attempt,
    internal: {
      name: String(error?.name || 'Error').slice(0, 120), code: code || null, message,
      stage: String(row.stage || '').slice(0, 120) || null, attempt, recordedAt: new Date().toISOString(),
    },
    public: connectorCreditsExhausted
      ? { code: 'connector_credits_exhausted', message: 'Your connected VidIQ account has no credits remaining. Add VidIQ credits, then try again.' }
      : unavailable
      ? { code: 'skill_service_unavailable', message: 'This ClarityMode Skill needs service attention. Your work was preserved.' }
      : transient
        ? { code: 'temporary_failure', message: 'The Skill service was temporarily unavailable. Your work was preserved; try again.' }
        : { code: 'assignment_failed', message: 'ClarityMode could not finish this assignment. Your work was preserved; try again.' },
  }
}

function publicAssignment(row) {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    contractVersion: String(row.contract_version || row.workflow_state?.contractVersion || ''),
    projectRef: row.project_ref,
    sourceTask: row.source_task,
    status: PUBLIC_STATUSES.has(row.status) ? row.status : 'failed',
    stage: row.stage,
    progressLabel: row.progress_label,
    progress: row.workflow_state?.progress || { label: row.progress_label, currentStepId: '', completedStepIds: [] },
    approval: row.approval,
    question: row.question,
    artifacts: Array.isArray(row.artifacts) ? row.artifacts : [],
    taskProposals: Array.isArray(row.workflow_state?.taskProposals) ? row.workflow_state.taskProposals : [],
    acceptedTaskProposals: Array.isArray(row.workflow_state?.acceptedTaskProposals) ? row.workflow_state.acceptedTaskProposals : [],
    workPlan: Array.isArray(row.workflow_state?.workPlan) ? row.workflow_state.workPlan : [],
    error: row.public_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
  }
}

function assignmentManifest(row) {
  return row.workflow_state?.manifest || row.manifest
}

function preservedWorkflowState(row, changes = {}) {
  return {
    ...(row.workflow_state && typeof row.workflow_state === 'object' ? row.workflow_state : {}),
    contractVersion: '1',
    ...changes,
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
  if (!/^[a-z][a-z0-9_-]{1,99}$/i.test(normalized.skillId)) throw Object.assign(new Error('That ClarityMode Skill is not available.'), { status: 400 })
  if (!String(normalized.projectRef.path || '').trim()) throw Object.assign(new Error('A project is required.'), { status: 400 })
  if (!String(normalized.sourceTask.id || '').trim() || !String(normalized.sourceTask.text || '').trim()) {
    throw Object.assign(new Error('Choose a project task to hand to ClarityMode.'), { status: 400 })
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_INPUT_BYTES) throw Object.assign(new Error('That assignment contains too much context.'), { status: 413 })
  return normalized
}

function stateToken(row) {
  return String(row.workflow_state?.stateToken || '')
}

async function invokeContractAgent(row, { humanResponse = {}, connectorResult = null } = {}, deps = {}) {
  const operation = humanResponse?.kind === 'cancel' ? 'cancel' : stateToken(row) ? 'resume' : 'start'
  const envelope = {
    operation,
    contractVersion: '1',
    assignment: { id: row.id, skillId: row.skill_id, skillVersion: row.skill_version },
    context: {
      project: row.project_ref || {},
      projectArea: row.project_context?.projectArea || {},
      sourceTask: row.source_task || {},
      projectContext: row.project_context || {},
      userProfile: row.skill_profile || {},
      userInputs: row.brief || {},
      currentUser: { name: row.user_name || '', email: row.user_email || '' },
    },
    stateToken: stateToken(row),
    response: humanResponse || {},
    connectorResult: connectorResult || {},
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    operation, stateToken: envelope.stateToken, response: envelope.response, connectorResult: envelope.connectorResult,
  })).digest('hex').slice(0, 24)
  return skillRunner.invoke({
    provider: row.provider,
    appId: row.provider_app_id,
    version: row.provider_version || '',
    envelope,
    idempotencyKey: `${row.id}:${fingerprint}`,
  }, deps)
}

async function persistContractResult(row, result, providerThreadId, connectorEvidence = row.connector_evidence || {}) {
  const manifest = validateManifest(assignmentManifest(row), row.skill_id)
  let status = result.status
  const artifacts = validateArtifacts(manifest, result.artifacts, {
    requireOutputs: status === 'ready_for_review' || status === 'completed',
  })
  if (status === 'completed') {
    status = row.pending_response?.kind === 'accept'
      ? 'accepted'
      : manifest.completion.requiresAcceptance || artifacts.length ? 'ready_for_review' : 'accepted'
  }
  if (!PUBLIC_STATUSES.has(status) && status !== 'needs_connector') throw new Error(`The Skill returned unsupported status ${status}.`)
  const question = result.inputRequest
    ? { id: result.inputRequest.id, kind: result.inputRequest.type, prompt: result.inputRequest.label, field: result.inputRequest }
    : null
  const approval = result.review
    ? { kind: 'generic_review', title: result.review.title, message: result.review.message, allowRequestChanges: result.review.allowRequestChanges }
    : null
  await db.query(
    `UPDATE skill_assignments
        SET status = $2, stage = $3, progress_label = $4,
            workflow_state = $5, connector_request = $6, approval = $7, question = $8,
            artifacts = $9, public_error = $10, internal_error = NULL,
            pending_response = NULL, provider_thread_id = $11, connector_evidence = $12,
            run_started_at = NULL, accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE accepted_at END,
            updated_at = now()
      WHERE id = $1 AND status <> 'cancelled'`,
    [
      row.id, status === 'working' ? 'queued' : status, result.status,
      String(result.progress?.label || 'ClarityMode is working...').slice(0, 500),
      preservedWorkflowState(row, {
        stateToken: result.stateToken || '',
        progress: result.progress || {},
        taskProposals: result.taskProposals || [],
        acceptedTaskProposals: Array.isArray(row.workflow_state?.acceptedTaskProposals) ? row.workflow_state.acceptedTaskProposals : [],
      }), result.connectorRequest,
      approval, question, JSON.stringify(artifacts), result.error, providerThreadId, connectorEvidence,
    ],
  )
}

async function processContractAssignment(row, deps = {}) {
  const manifest = validateManifest(assignmentManifest(row), row.skill_id)
  let current = row
  let humanResponse = current.pending_response || {}
  let connectorResult = null
  let evidence = current.connector_evidence && typeof current.connector_evidence === 'object' ? current.connector_evidence : {}
  for (let pass = 0; pass < 8; pass += 1) {
    const invocation = await invokeContractAgent(current, { humanResponse, connectorResult }, deps)
    const result = invocation.result
    if (result.status !== 'needs_connector') {
      await persistContractResult(current, result, invocation.threadId, evidence)
      return
    }
    const request = result.connectorRequest
    const cached = evidence.contractRequests?.[request.id]
    const brokered = cached
      ? { needsConnection: false, result: cached }
      : await connectorBroker.execute({ userId: current.user_id, manifest, request }, { ...deps, db })
    if (brokered.needsConnection) {
      await persistContractResult(current, {
        ...result,
        status: 'needs_input',
        inputRequest: { id: `connect_${brokered.connector}`, type: 'text', label: `Connect ${brokered.connector} in ClarityMode Skills settings, then retry.`, required: false },
        connectorRequest: null,
      }, invocation.threadId, evidence)
      return
    }
    evidence = { ...evidence, contractRequests: { ...(evidence.contractRequests || {}), [request.id]: brokered.result } }
    await db.query(
      `UPDATE skill_assignments
          SET workflow_state = $2, connector_evidence = $3, provider_thread_id = $4,
              progress_label = 'Connected research received; continuing...', updated_at = now()
        WHERE id = $1 AND status <> 'cancelled'`,
      [current.id, preservedWorkflowState(current, { stateToken: result.stateToken || '', progress: result.progress || {} }), evidence, invocation.threadId],
    )
    current = { ...current, workflow_state: preservedWorkflowState(current, { stateToken: result.stateToken || '', progress: result.progress || {} }), connector_evidence: evidence, pending_response: null }
    connectorResult = brokered.result
    humanResponse = {}
  }
  throw new Error('The Skill requested too many connector steps in one run.')
}

async function claimNext() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT a.*, s.contract_version, s.provider, s.provider_app_id, s.provider_version, s.manifest,
              u.email AS user_name, u.email AS user_email,
              COALESCE(p.profile, '{}'::jsonb) AS skill_profile
         FROM skill_assignments a
         JOIN v2_skills s ON s.id = a.skill_id
         JOIN users u ON u.id = a.user_id
         LEFT JOIN skill_user_profiles p ON p.user_id = a.user_id
          AND p.skill_id = COALESCE(NULLIF(s.manifest->>'profileSourceSkillId', ''), a.skill_id)
        WHERE (a.status = 'queued' OR (a.status = 'working' AND a.run_started_at < now() - interval '10 minutes'))
          AND s.status = 'active' AND s.contract_version = '1'
       ORDER BY a.updated_at ASC
       LIMIT 1
       FOR UPDATE OF a SKIP LOCKED`,
    )
    const row = result.rows[0]
    if (!row) { await client.query('COMMIT'); return null }
    await client.query(
      `UPDATE skill_assignments SET status = 'working', progress_label = 'ClarityMode is working...',
          run_started_at = now(), attempt_count = attempt_count + 1, updated_at = now() WHERE id = $1`,
      [row.id],
    )
    await client.query('COMMIT')
    return { ...row, status: 'working' }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function workOnce(deps = {}) {
  if (running) return false
  running = true
  try {
    const row = await claimNext()
    if (!row) return false
    try {
      if (!skillRunner.configured(row.provider)) throw Object.assign(new Error('The Skill runner is not configured.'), { status: 503 })
      await processContractAssignment(row, deps)
    } catch (error) {
      const failure = assignmentFailure(error, row)
      console.error('[skill-assignments] Assignment failed', JSON.stringify({
        assignmentId: row.id,
        attempt: failure.attempt,
        retrying: failure.retry,
        stage: failure.internal.stage,
        code: failure.internal.code,
        error: failure.internal.message,
      }))
      if (failure.retry) {
        await db.query(
          `UPDATE skill_assignments SET status = 'queued', progress_label = 'The Skill service paused; retrying safely...',
              public_error = NULL, internal_error = $2, run_started_at = NULL, updated_at = now()
            WHERE id = $1 AND status <> 'cancelled'`,
          [row.id, failure.internal],
        )
      } else {
        await db.query(
          `UPDATE skill_assignments SET status = 'failed', progress_label = 'This assignment needs attention.',
              public_error = $2, internal_error = $3, run_started_at = NULL, updated_at = now()
            WHERE id = $1 AND status <> 'cancelled'`,
          [row.id, failure.public, failure.internal],
        )
      }
    }
    return true
  } finally { running = false }
}

async function cancelRunnerState(id, userId, deps = {}) {
  const result = await db.query(
    `SELECT a.*, s.contract_version, s.provider, s.provider_app_id, s.provider_version, s.manifest,
            u.email AS user_name, u.email AS user_email,
            COALESCE(p.profile, '{}'::jsonb) AS skill_profile
       FROM skill_assignments a
       JOIN v2_skills s ON s.id = a.skill_id
       JOIN users u ON u.id = a.user_id
       LEFT JOIN skill_user_profiles p ON p.user_id = a.user_id
        AND p.skill_id = COALESCE(NULLIF(s.manifest->>'profileSourceSkillId', ''), a.skill_id)
      WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'cancelled'`,
    [id, userId],
  )
  const row = result.rows[0]
  if (!row || !stateToken(row) || !skillRunner.configured(row.provider)) return false
  await invokeContractAgent(row, { humanResponse: { kind: 'cancel' } }, deps)
  return true
}

function start() {
  if (timer) return
  const report = error => console.error('[skill-assignments] Worker loop failed', { error: String(error?.message || error || 'Unknown worker error').slice(0, 2_000) })
  timer = setInterval(() => workOnce().catch(report), 3_000)
  timer.unref?.()
  workOnce().catch(report)
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  SKILL_ID, assignmentFailure, cancelRunnerState, claimNext, configured, invokeContractAgent,
  normalizeCreate, persistContractResult, processContractAssignment,
  publicAssignment, start, stop, workOnce,
}
