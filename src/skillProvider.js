const { validateManifest } = require('./skillContract')

const MAX_PROVIDER_BYTES = 2 * 1024 * 1024
const REMOTE_PREFIX = '@@remote_variable@@'

function configured() {
  return Boolean(String(process.env.MINDSTUDIO_API_KEY || '').trim())
}

function parseJsonValue(value) {
  let parsed = value
  for (let depth = 0; depth < 8 && typeof parsed === 'string'; depth += 1) {
    const clean = parsed.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')
    try { parsed = JSON.parse(clean) } catch { break }
  }
  return parsed
}

function remoteUrl(value) {
  if (typeof value !== 'string' || !value.startsWith(REMOTE_PREFIX)) return null
  let url
  try { url = new URL(value.slice(REMOTE_PREFIX.length).trim()) } catch { throw new Error('The Skill returned an invalid large result reference.') }
  if (url.protocol !== 'https:' || !/^youai-appdata-private\.s3\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname)) {
    throw new Error('The Skill returned an untrusted large result reference.')
  }
  return url.toString()
}

async function resolveValue(value, fetchImpl = fetch, remoteDepth = 0, structuralDepth = 0) {
  if (remoteDepth > 8 || structuralDepth > 64) throw new Error('The Skill returned an overly complex result.')
  const url = remoteUrl(value)
  if (url) {
    const response = await fetchImpl(url, { redirect: 'error' })
    if (!response?.ok) throw new Error('The Skill result could not be downloaded.')
    const declaredSize = Number(response.headers?.get?.('content-length') || 0)
    if (declaredSize > MAX_PROVIDER_BYTES) throw new Error('The Skill returned too much data.')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_PROVIDER_BYTES) throw new Error('The Skill returned too much data.')
    return resolveValue(parseJsonValue(bytes.toString('utf8')), fetchImpl, remoteDepth + 1, 0)
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => resolveValue(item, fetchImpl, remoteDepth, structuralDepth + 1)))
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveValue(item, fetchImpl, remoteDepth, structuralDepth + 1)]))
    return Object.fromEntries(entries)
  }
  return value
}

function unwrapResult(value) {
  let result = value
  for (let depth = 0; depth < 8; depth += 1) {
    result = parseJsonValue(result)
    if (!result || typeof result !== 'object' || Array.isArray(result)) break
    if (result.manifest && typeof result.manifest === 'object') return result.manifest
    if (result.result !== undefined) { result = result.result; continue }
    if (result.finalResponse !== undefined) { result = result.finalResponse; continue }
    break
  }
  return parseJsonValue(result)
}

async function runMindStudio({ appId, version = '', variables, workflow = 'Main.flow' }, deps = {}) {
  const apiKey = String(process.env.MINDSTUDIO_API_KEY || '').trim()
  const normalizedAppId = String(appId || '').trim()
  if (!apiKey) throw Object.assign(new Error('The MindStudio service is not configured.'), { status: 503 })
  if (!normalizedAppId) throw Object.assign(new Error('Enter a MindStudio Agent ID.'), { status: 400 })
  const loadSdk = deps.loadSdk || (() => import('@mindstudio-ai/agent'))
  const sdk = await loadSdk()
  const MindStudioAgent = deps.MindStudioAgent || sdk.MindStudioAgent
  const client = new MindStudioAgent({ apiKey })
  const response = await client.runAgent({
    appId: normalizedAppId,
    workflow,
    variables,
    ...(String(version || '').trim() ? { version: String(version).trim() } : {}),
  })
  const current = response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'result') ? response.result : response
  return { result: await resolveValue(current, deps.fetchImpl || fetch), threadId: String(response?.threadId || '') }
}

async function describeSkill({ appId, version = '' }, deps = {}) {
  const response = await runMindStudio({
    appId,
    version,
    variables: { operation: 'describe', contractVersion: '1' },
  }, deps)
  try {
    return validateManifest(unwrapResult(response.result))
  } catch (error) {
    if (error.status === 400) {
      throw Object.assign(new Error(`That MindStudio workflow does not return a valid ClarityMode Skill manifest: ${error.message}`), { status: 400 })
    }
    throw error
  }
}

module.exports = { configured, describeSkill, parseJsonValue, resolveValue, runMindStudio, unwrapResult }
