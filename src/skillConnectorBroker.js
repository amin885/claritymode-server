const credentials = require('./skillCredentials')
const { connectorAllowed, validateManifest } = require('./skillContract')
const { getConnector } = require('./skillConnectors')

function supportsDeclaration(entry) {
  try {
    const connector = getConnector(entry?.connector)
    return Boolean(Array.isArray(entry?.operations) && entry.operations.every(operation => connector.operations.has(operation)))
  } catch { return false }
}

async function readCredential(userId, connectorId, deps = {}) {
  const db = deps.db || require('./db')
  const result = await db.query(
    'SELECT encrypted_value FROM skill_connector_credentials WHERE user_id = $1 AND connector_id = $2',
    [userId, connectorId],
  )
  return result.rows[0]?.encrypted_value ? credentials.decrypt(result.rows[0].encrypted_value) : ''
}

function normalizeQueries(args = {}) {
  const values = Array.isArray(args.queries) ? args.queries : [args.query]
  const seen = new Set()
  return values.map(value => String(value || '').trim().slice(0, 300)).filter(value => {
    const key = value.toLowerCase()
    if (!value || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 10)
}

async function execute({ userId, manifest, request }, deps = {}) {
  const normalizedManifest = validateManifest(manifest)
  if (!request || typeof request !== 'object') throw Object.assign(new Error('The Skill requested an invalid connection.'), { status: 400 })
  const connector = String(request.connector || '').trim()
  const operation = String(request.operation || '').trim()
  if (!connectorAllowed(normalizedManifest, connector, operation)) {
    throw Object.assign(new Error('That connector operation is not allowed for this Skill.'), { status: 403 })
  }
  const adapter = getConnector(connector)
  if (!adapter.operations.has(operation)) {
    throw Object.assign(new Error('That connector operation is not supported yet.'), { status: 400 })
  }
  const apiKey = await readCredential(userId, connector, deps)
  if (!apiKey) return { needsConnection: true, connector }
  const operationResult = await adapter.execute(operation, apiKey, request.arguments || {}, { ...deps, normalizeQueries })
  return {
    needsConnection: false,
    result: {
      requestId: request.id,
      connector,
      operation,
      ...operationResult,
      retrievedAt: new Date().toISOString(),
    },
  }
}

module.exports = { execute, normalizeQueries, readCredential, supportsDeclaration }
