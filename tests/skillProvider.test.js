const provider = require('../src/skillProvider')

describe('MindStudio Skill provider boundary', () => {
  const previousKey = process.env.MINDSTUDIO_API_KEY
  beforeEach(() => { process.env.MINDSTUDIO_API_KEY = 'server-key' })
  afterAll(() => { process.env.MINDSTUDIO_API_KEY = previousKey })

  test('describes a workflow through the generic contract operation', async () => {
    const runAgent = jest.fn(async input => ({
      result: JSON.stringify({
        manifest: {
          contractVersion: '1',
          skillId: 'meeting-summary',
          skillVersion: '1.0.0',
          name: 'Meeting Summary',
          description: 'Create an actionable meeting summary.',
          inputs: [{ id: 'notes', type: 'long_text', label: 'Meeting notes', required: true }],
          outputs: [{ id: 'summary', type: 'markdown', label: 'Summary', required: true }],
          connectors: [],
        },
      }),
    }))
    const manifest = await provider.describeSkill({ appId: 'agent-123', version: 'published' }, {
      MindStudioAgent: class { runAgent = runAgent },
      loadSdk: async () => ({}),
    })
    expect(manifest.skillId).toBe('meeting-summary')
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'agent-123',
      version: 'published',
      variables: { operation: 'describe', contractVersion: '1' },
    }))
  })

  test('rejects a provider that does not implement the contract', async () => {
    await expect(provider.describeSkill({ appId: 'agent-123' }, {
      MindStudioAgent: class { runAgent = async () => ({ result: 'not a manifest' }) },
      loadSdk: async () => ({}),
    })).rejects.toThrow(/valid ClarityMode Skill manifest/i)
  })
})
