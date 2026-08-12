jest.mock('../src/mastraSkillProvider', () => ({
  configured: jest.fn(() => true),
  describeSkill: jest.fn(),
  invoke: jest.fn(),
}))

const mastra = require('../src/mastraSkillProvider')
const runner = require('../src/skillRunner')

const manifest = {
  contractVersion: '1', skillId: 'youtube-outline', skillVersion: '1.0.0', name: 'YouTube Outline',
  inputs: [{ id: 'idea', type: 'text', label: 'Idea', required: true }],
  outputs: [{ id: 'outline', type: 'markdown', label: 'Outline', required: true }],
  connectors: [{ connector: 'vidiq', operations: ['research_topics'] }],
}

const envelope = {
  contractVersion: '1', operation: 'start', assignment: { id: 'assignment-1' },
  context: { userInputs: { idea: 'Morning planning' } }, stateToken: null, response: null,
}

describe('provider-neutral Skill runner', () => {
  beforeEach(() => jest.clearAllMocks())

  test('describes Mastra Skills without exposing the private runner secret', async () => {
    mastra.describeSkill.mockResolvedValue(manifest)
    const result = await runner.describeSkill({ provider: 'mastra', appId: 'youtube-outline' })
    expect(result.skillId).toBe('youtube-outline')
    expect(mastra.describeSkill).toHaveBeenCalledWith({ appId: 'youtube-outline', version: '' }, {})
    expect(JSON.stringify(result)).not.toMatch(/secret|bearer/i)
  })

  test('passes the generic envelope and idempotency identity unchanged to Mastra', async () => {
    mastra.invoke.mockResolvedValue({
      result: { contractVersion: '1', status: 'needs_connector', stateToken: 'opaque', connectorRequest: { id: 'r1', connector: 'vidiq', operation: 'research_topics', arguments: { query: 'morning planning' } } },
      threadId: 'run-1',
    })
    const result = await runner.invoke({ provider: 'mastra', appId: 'youtube-outline', envelope, idempotencyKey: 'idem-1' })
    expect(result.result.status).toBe('needs_connector')
    expect(mastra.invoke).toHaveBeenCalledWith(expect.objectContaining({ envelope, idempotencyKey: 'idem-1' }), {})
  })

  test('rejects the retired MindStudio runner', async () => {
    await expect(runner.invoke({ provider: 'mindstudio', appId: 'legacy-agent', envelope, idempotencyKey: 'legacy-1' }))
      .rejects.toMatchObject({ status: 400 })
  })

  test('rejects unknown execution providers', async () => {
    await expect(runner.invoke({ provider: 'arbitrary', appId: 'x', envelope })).rejects.toMatchObject({ status: 400 })
  })
})
