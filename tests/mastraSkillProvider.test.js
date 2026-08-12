const provider = require('../src/mastraSkillProvider')

describe('private Mastra runner boundary', () => {
  const previousUrl = process.env.MASTRA_SKILL_RUNNER_URL
  const previousSecret = process.env.MASTRA_SKILL_RUNNER_SECRET
  beforeEach(() => {
    process.env.MASTRA_SKILL_RUNNER_URL = 'https://skills.internal.example'
    process.env.MASTRA_SKILL_RUNNER_SECRET = 'private-runner-secret'
  })
  afterAll(() => {
    process.env.MASTRA_SKILL_RUNNER_URL = previousUrl
    process.env.MASTRA_SKILL_RUNNER_SECRET = previousSecret
  })

  function response(payload, status = 200) {
    const bytes = Buffer.from(JSON.stringify(payload))
    return { ok: status >= 200 && status < 300, status, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes }
  }

  test('authenticates privately and sends only the generic workflow envelope', async () => {
    const fetchImpl = jest.fn(async () => response({ result: { contractVersion: '1', status: 'cancelled', artifacts: [] }, runId: 'run-1' }))
    const envelope = { contractVersion: '1', operation: 'cancel', assignment: { id: 'a1' }, stateToken: 'opaque' }
    const result = await provider.invoke({ appId: 'youtube-outline', envelope, idempotencyKey: 'idem-1' }, { fetchImpl })
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://skills.internal.example/v1/skills/youtube-outline/invoke')
    expect(options.headers.Authorization).toBe('Bearer private-runner-secret')
    expect(JSON.parse(options.body)).toEqual({ version: '', envelope, idempotencyKey: 'idem-1' })
    expect(result.threadId).toBe('run-1')
    expect(JSON.stringify(result)).not.toContain('private-runner-secret')
  })

  test('does not forward remote provider errors verbatim when no safe message exists', async () => {
    const fetchImpl = jest.fn(async () => response({ error: 'Runner unavailable' }, 503))
    await expect(provider.describeSkill({ appId: 'youtube-outline' }, { fetchImpl })).rejects.toMatchObject({ status: 503 })
  })
})
