const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
// A runner invocation may include one structured model generation. The runner's
// OpenAI client allows one retry with a 120-second attempt timeout, so this
// boundary must outlive both attempts instead of abandoning valid work halfway.
const RUNNER_REQUEST_TIMEOUT_MS = 5 * 60_000

function configured() {
  return Boolean(String(process.env.MASTRA_SKILL_RUNNER_URL || '').trim()
    && String(process.env.MASTRA_SKILL_RUNNER_SECRET || '').trim())
}

function baseUrl() {
  const value = String(process.env.MASTRA_SKILL_RUNNER_URL || '').trim().replace(/\/+$/, '')
  if (!value) throw Object.assign(new Error('The Mastra Skill runner is not configured.'), { status: 503 })
  return value
}

function secret() {
  const value = String(process.env.MASTRA_SKILL_RUNNER_SECRET || '').trim()
  if (!value) throw Object.assign(new Error('The Mastra Skill runner is not configured.'), { status: 503 })
  return value
}

async function request(path, body, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(deps.timeoutMs) || RUNNER_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
      redirect: 'error',
    })
    const declaredSize = Number(response.headers?.get?.('content-length') || 0)
    if (declaredSize > MAX_RESPONSE_BYTES) throw new Error('The Skill runner returned too much data.')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('The Skill runner returned too much data.')
    const payload = JSON.parse(bytes.toString('utf8') || '{}')
    if (!response.ok) {
      throw Object.assign(new Error(String(payload.error || 'The Mastra Skill runner could not complete that request.')), { status: response.status })
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('The Mastra Skill runner took too long to respond.'), { status: 504 })
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function describeSkill({ appId, version = '' }, deps = {}) {
  const id = String(appId || '').trim()
  if (!id) throw Object.assign(new Error('Enter a Mastra workflow ID.'), { status: 400 })
  const result = await request(`/v1/skills/${encodeURIComponent(id)}/describe`, { version: String(version || '').trim() }, deps)
  return result.manifest || result
}

async function invoke({ appId, version = '', envelope, idempotencyKey }, deps = {}) {
  const id = String(appId || '').trim()
  if (!id) throw Object.assign(new Error('The Skill has no Mastra workflow ID.'), { status: 400 })
  const result = await request(`/v1/skills/${encodeURIComponent(id)}/invoke`, {
    version: String(version || '').trim(),
    envelope,
    idempotencyKey: String(idempotencyKey || '').trim(),
  }, deps)
  return { result: result.result || result, threadId: String(result.runId || result.threadId || '') }
}

module.exports = { RUNNER_REQUEST_TIMEOUT_MS, configured, describeSkill, invoke, request }
