const vidiq = require('./vidiqConnector')

const connectors = Object.freeze({
  vidiq: {
    id: 'vidiq',
    name: 'VidIQ',
    description: 'Uses the user\'s own VidIQ account for YouTube channel, keyword, and outlier research.',
    credentialLabel: 'VidIQ MCP key',
    operations: new Set(['research_topics', 'keyword_research']),
    async validate(secret, deps = {}) {
      const result = await vidiq.validate(secret, deps.fetchImpl)
      return {
        toolCount: result.toolCount,
        channels: result.channels,
        channelsCheckedAt: result.channelsCheckedAt,
      }
    },
    async execute(operation, secret, args, deps = {}) {
      const queries = deps.normalizeQueries(args)
      if (!queries.length) throw Object.assign(new Error('VidIQ research needs at least one query.'), { status: 400 })
      return {
        queries,
        results: await (deps.researchVidiq || vidiq.research)(secret, queries, deps.fetchImpl),
      }
    },
  },
})

function getConnector(id) {
  const connector = connectors[String(id || '').trim().toLowerCase()]
  if (!connector) throw Object.assign(new Error('That Skill connection is not supported yet.'), { status: 400 })
  return connector
}

function publicConnectors(ids = Object.keys(connectors)) {
  return [...new Set(ids.map(id => String(id || '').trim().toLowerCase()).filter(Boolean))]
    .map(id => connectors[id])
    .filter(Boolean)
    .map(({ operations, validate, execute, ...connector }) => ({ ...connector, operations: [...operations] }))
}

module.exports = { connectors, getConnector, publicConnectors }
