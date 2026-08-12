const mindstudio = require('./skillProvider')
const mastra = require('./mastraSkillProvider')
const { validateManifest, validateProviderResponse } = require('./skillContract')

const runners = { mindstudio, mastra }

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

function mindStudioVariables(envelope) {
  return {
    operation: envelope.operation,
    contractVersion: envelope.contractVersion,
    assignment: JSON.stringify(envelope.assignment || {}),
    context: JSON.stringify(envelope.context || {}),
    stateToken: String(envelope.stateToken || ''),
    response: JSON.stringify(envelope.response || {}),
    connectorResult: JSON.stringify(envelope.connectorResult || {}),
  }
}

async function invoke({ provider, appId, version = '', envelope, idempotencyKey }, deps = {}) {
  const selected = runner(provider)
  if (selected.id === 'mindstudio') {
    const response = await selected.value.runMindStudio({ appId, version, variables: mindStudioVariables(envelope) }, deps)
    let value = response.result
    for (let depth = 0; depth < 8; depth += 1) {
      value = selected.value.parseJsonValue(value)
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.status) break
      if (value.result !== undefined) { value = value.result; continue }
      if (value.finalResponse !== undefined) { value = value.finalResponse; continue }
      break
    }
    return { result: validateProviderResponse(selected.value.parseJsonValue(value)), threadId: response.threadId }
  }
  const response = await selected.value.invoke({ appId, version, envelope, idempotencyKey }, deps)
  return { result: validateProviderResponse(response.result), threadId: response.threadId }
}

module.exports = { configured, describeSkill, invoke, runner }
