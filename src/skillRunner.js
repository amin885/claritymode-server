const mastra = require('./mastraSkillProvider')
const { validateManifest, validateProviderResponse } = require('./skillContract')

const runners = { mastra }

function runner(provider) {
  const id = String(provider || '').trim().toLowerCase()
  const value = runners[id]
  if (!value) throw Object.assign(new Error(`Unsupported Skill runner: ${id || 'missing'}.`), { status: 400 })
  return { id, value }
}

function configured(provider) {
  try { return Boolean(runner(provider).value.configured()) } catch { return false }
}

async function describeSkill({ provider, appId, version = '' }, deps = {}) {
  const selected = runner(provider)
  const manifest = await selected.value.describeSkill({ appId, version }, deps)
  return validateManifest(manifest)
}

async function invoke({ provider, appId, version = '', envelope, idempotencyKey }, deps = {}) {
  const selected = runner(provider)
  const response = await selected.value.invoke({ appId, version, envelope, idempotencyKey }, deps)
  return { result: validateProviderResponse(response.result), threadId: response.threadId }
}

module.exports = { configured, describeSkill, invoke, runner }
