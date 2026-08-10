const assignments = require('../src/skillAssignments')

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
})
