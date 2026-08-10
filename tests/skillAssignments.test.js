const assignments = require('../src/skillAssignments')
const db = require('../src/db')

describe('durable ClarityMode Skill assignments', () => {
  test('normalizes a task-backed assignment without provider details', () => {
    const input = assignments.normalizeCreate({
      id: '123e4567-e89b-12d3-a456-426614174000',
      clientRequestId: 'device-1:request-1',
      skillId: assignments.SKILL_ID,
      projectRef: { path: 'Projects/YouTube', title: 'YouTube' },
      sourceTask: { id: 'task-123456', text: 'Create today’s video' },
      brief: { seedIdea: 'Why task lists fail' },
      projectContext: { overview: 'A channel about clear work.' },
    })
    expect(input.skillId).toBe(assignments.SKILL_ID)
    expect(input.sourceTask.id).toBe('task-123456')
  })

  test('rejects assignments without a stable source task', () => {
    expect(() => assignments.normalizeCreate({
      id: '123e4567-e89b-12d3-a456-426614174000',
      clientRequestId: 'request-1',
      skillId: assignments.SKILL_ID,
      projectRef: { path: 'Projects/YouTube' },
      sourceTask: { text: 'Missing identity' },
    })).toThrow('Choose a project task')
  })

  test('parses the standard hidden-provider result contract', () => {
    const result = assignments.parseAgentResult({
      result: JSON.stringify({
        schemaVersion: 1,
        status: 'needs_approval',
        stage: 'await_approval',
        progress: { label: 'Creative direction is ready.' },
        state: { stage: 'await_approval' },
        approval: { kind: 'creative_direction', data: { hooks: [] } },
        artifacts: [],
      }),
    })
    expect(result.status).toBe('needs_approval')
    expect(result.approval.kind).toBe('creative_direction')
  })

  test('parses MindStudio final responses that are wrapped and JSON encoded more than once', () => {
    const contract = {
      schemaVersion: 1,
      status: 'needs_connector',
      stage: 'await_vidiq_seed',
      progress: { label: 'Gathering keyword research dataâ€¦' },
      state: { stage: 'await_vidiq_seed' },
      connectorRequest: { connector: 'vidiq', operation: 'keyword_research', queries: ['wake up at 5am'] },
      artifacts: [],
    }
    const result = assignments.parseAgentResult({
      result: JSON.stringify({ finalResponse: JSON.stringify(JSON.stringify(contract)) }),
    })
    expect(result.status).toBe('needs_connector')
    expect(result.connectorRequest.queries).toEqual(['wake up at 5am'])
  })

  test('rejects malformed provider responses before they reach users', () => {
    expect(() => assignments.parseAgentResult({ result: 'not-json' })).toThrow('unreadable')
  })

  test('normalizes legacy non-list artifacts before returning an assignment', () => {
    expect(assignments.publicAssignment({ artifacts: {} }).artifacts).toEqual([])
    expect(assignments.publicAssignment({ artifacts: [{ title: 'Script' }] }).artifacts).toEqual([{ title: 'Script' }])
  })

  test('resolves nested MindStudio large-file results before validating the assignment contract', async () => {
    const remoteUrl = 'https://youai-appdata-private.s3.us-west-2.amazonaws.com/lfs/final.json?signature=test'
    const artifactUrl = 'https://youai-appdata-private.s3.us-west-2.amazonaws.com/lfs/outline.json?signature=test'
    const fetchImpl = jest.fn(async url => {
      const bytes = Buffer.from(url === remoteUrl
        ? JSON.stringify({ result: { status: 'ready_for_review', artifacts: `@@remote_variable@@${artifactUrl}` } })
        : JSON.stringify([{ title: 'Outline', content: '# Finished outline' }]))
      return {
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }
    })

    const resolved = await assignments.resolveProviderValue({ result: `@@remote_variable@@${remoteUrl}` }, fetchImpl)
    const parsed = assignments.parseAgentResult(resolved)

    expect(parsed.status).toBe('ready_for_review')
    expect(parsed.artifacts).toEqual([{ title: 'Outline', content: '# Finished outline' }])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('rejects large-file references outside MindStudio private storage', async () => {
    await expect(assignments.resolveProviderValue('@@remote_variable@@https://example.com/result.json', jest.fn()))
      .rejects.toThrow('untrusted')
  })

  test('persists a non-empty artifact list as JSONB instead of a PostgreSQL array', async () => {
    const query = jest.spyOn(db, 'query').mockResolvedValue({ rows: [] })
    const artifacts = [{ id: 'outline-1', title: 'YouTube outline', content: '# Finished outline' }]

    await assignments.persistResult({ id: 'assignment-1' }, {
      status: 'ready_for_review',
      stage: 'ready_for_review',
      progress: { label: 'Outline ready' },
      state: { stage: 'ready_for_review' },
      connectorRequest: null,
      approval: null,
      question: null,
      artifacts,
      error: null,
    }, 'provider-thread-1')

    const parameters = query.mock.calls[0][1]
    expect(typeof parameters[8]).toBe('string')
    expect(JSON.parse(parameters[8])).toEqual(artifacts)
    query.mockRestore()
  })
})
