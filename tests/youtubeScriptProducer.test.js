const producer = require('../src/youtubeScriptProducer')

const VALID_CONTEXT = {
  businessOffer: 'ClarityMode planning software',
  idealAudience: 'Busy knowledge workers',
  audienceProblems: 'Too many disconnected priorities',
  channelName: 'ClarityMode Podcast',
}

describe('YouTube Script Producer service', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('requires the approved channel and audience context', () => {
    expect(() => producer.normalizeInput({ operation: 'generate_candidates' }))
      .toThrow('Channel and audience context are required.')
  })

  test('requires VidIQ evidence before evaluating topics', () => {
    expect(() => producer.normalizeInput({ ...VALID_CONTEXT, operation: 'evaluate_topics' }))
      .toThrow('VidIQ evidence is required')
  })

  test('calls the configured MindStudio worker without exposing its credential', async () => {
    process.env.MINDSTUDIO_API_KEY = 'server-secret'
    process.env.MINDSTUDIO_YOUTUBE_AGENT_ID = 'agent-123'
    process.env.MINDSTUDIO_YOUTUBE_AGENT_VERSION = 'draft'
    const runAgent = jest.fn().mockResolvedValue({
      result: JSON.stringify({ operation: 'generate_candidates', candidates: [] }),
      threadId: 'thread-1',
      billingCost: 1,
    })
    const MindStudioAgent = jest.fn().mockImplementation(({ apiKey }) => {
      expect(apiKey).toBe('server-secret')
      return { runAgent }
    })

    const output = await producer.run(
      { ...VALID_CONTEXT, operation: 'generate_candidates' },
      { MindStudioAgent, loadSdk: async () => ({ MindStudioAgent }) },
    )

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'agent-123',
      workflow: 'Main.flow',
      version: 'draft',
      variables: expect.objectContaining({ operation: 'generate_candidates' }),
    }))
    expect(output).toEqual(expect.objectContaining({
      result: { operation: 'generate_candidates', candidates: [] },
      threadId: 'thread-1',
    }))
  })

  test('rejects a result for a different operation', async () => {
    process.env.MINDSTUDIO_API_KEY = 'server-secret'
    process.env.MINDSTUDIO_YOUTUBE_AGENT_ID = 'agent-123'
    const MindStudioAgent = jest.fn().mockImplementation(() => ({
      runAgent: async () => ({ result: JSON.stringify({ operation: 'validate_topic' }) }),
    }))
    await expect(producer.run(
      { ...VALID_CONTEXT, operation: 'generate_candidates' },
      { MindStudioAgent, loadSdk: async () => ({ MindStudioAgent }) },
    )).rejects.toThrow('wrong operation')
  })
})
