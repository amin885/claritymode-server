jest.mock('../src/skillCredentials', () => ({ decrypt: value => `plain:${value}` }))
const broker = require('../src/skillConnectorBroker')

const manifest = {
  contractVersion: '1', skillId: 'youtube-research', skillVersion: '1.0.0', name: 'YouTube Research',
  inputs: [], outputs: [{ id: 'report', type: 'markdown', label: 'Research report', required: true }], connectors: [{ connector: 'vidiq', operations: ['research_topics'] }],
}

describe('generic Skill connector broker', () => {
  test('executes only declared operations without exposing the credential', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ encrypted_value: 'cipher' }] })) }
    const researchVidiq = jest.fn(async (key, queries) => [{ query: queries[0], evidence: { outliers: [] } }])
    const result = await broker.execute({
      userId: 'user-1', manifest,
      request: { id: 'research-1', connector: 'vidiq', operation: 'research_topics', arguments: { query: 'morning planning' } },
    }, { db, researchVidiq })
    expect(researchVidiq).toHaveBeenCalledWith('plain:cipher', ['morning planning'], undefined)
    expect(result.result).not.toHaveProperty('apiKey')
  })

  test('rejects operations outside the manifest allow-list', async () => {
    await expect(broker.execute({
      userId: 'user-1', manifest,
      request: { id: 'delete-1', connector: 'vidiq', operation: 'delete', arguments: {} },
    })).rejects.toMatchObject({ status: 403 })
  })

  test('returns a connection requirement when the user has no credential', async () => {
    const result = await broker.execute({
      userId: 'user-1', manifest,
      request: { id: 'research-1', connector: 'vidiq', operation: 'research_topics', arguments: { query: 'morning planning' } },
    }, { db: { query: async () => ({ rows: [] }) } })
    expect(result).toEqual({ needsConnection: true, connector: 'vidiq' })
  })
})
