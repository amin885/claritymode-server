const assignments = require('../src/skillAssignmentEngine')
const db = require('../src/db')
const skillRunner = require('../src/skillRunner')

const manifest = {
  contractVersion: '1',
  skillId: 'company-research',
  skillVersion: '1.0.0',
  name: 'Company Research',
  description: 'Prepare a company brief.',
  inputs: [{ id: 'companyName', type: 'text', label: 'Company', required: true }],
  outputs: [{ id: 'brief', type: 'markdown', label: 'Company brief', required: true }],
  connectors: [],
  completion: { requiresAcceptance: true },
}

function row(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: 'user-1',
    skill_id: 'company-research',
    skill_version: '1.0.0',
    contract_version: '1',
    provider: 'mastra',
    provider_app_id: 'company-research',
    provider_version: '1.0.0',
    manifest,
    project_ref: { path: 'Projects/Acme', title: 'Acme' },
    project_context: { overview: 'Prepare for a sales meeting.' },
    source_task: { id: 'task-1', text: 'Research Acme' },
    brief: { companyName: 'Acme' },
    workflow_state: {},
    connector_evidence: {},
    pending_response: null,
    artifacts: [],
    ...overrides,
  }
}

describe('generic durable Skill assignments', () => {
  afterEach(() => jest.restoreAllMocks())

  test('starts a registered workflow using only the generic envelope', async () => {
    const invoke = jest.spyOn(skillRunner, 'invoke').mockResolvedValue({
      result: {
        contractVersion: '1',
        status: 'needs_input',
        stateToken: 'state-1',
        progress: { label: 'One detail is needed.' },
        inputRequest: { id: 'meetingGoal', type: 'long_text', label: 'What is the meeting goal?', required: true },
        connectorRequest: null, review: null, artifacts: [], error: null,
      },
      threadId: 'thread-1',
    })
    const invocation = await assignments.invokeContractAgent(row())
    expect(invocation.result.status).toBe('needs_input')
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'mastra', appId: 'company-research', version: '1.0.0',
      envelope: expect.objectContaining({ operation: 'start', contractVersion: '1' }),
    }), {})
    const envelope = invoke.mock.calls[0][0].envelope
    expect(envelope.context.userInputs).toEqual({ companyName: 'Acme' })
  })

  test('persists a provider input request without Skill-specific parsing', async () => {
    const query = jest.spyOn(db, 'query').mockResolvedValue({ rows: [] })
    await assignments.persistContractResult(row(), {
      contractVersion: '1',
      status: 'needs_input',
      stateToken: 'state-1',
      progress: { label: 'Waiting for an answer.' },
      inputRequest: { id: 'goal', type: 'long_text', label: 'What should this accomplish?', required: true },
      connectorRequest: null,
      review: null,
      artifacts: [],
      error: null,
    }, 'thread-1')
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE skill_assignments'), expect.arrayContaining([
      row().id,
      'needs_input',
    ]))
    const values = query.mock.calls[0][1]
    expect(values[7]).toMatchObject({ id: 'goal', kind: 'long_text', prompt: 'What should this accomplish?' })
  })

  test('turns provider completion into review when the manifest requires acceptance', async () => {
    const query = jest.spyOn(db, 'query').mockResolvedValue({ rows: [] })
    await assignments.persistContractResult(row(), {
      contractVersion: '1', status: 'completed', stateToken: 'done', progress: { label: 'Complete' },
      inputRequest: null, connectorRequest: null, review: null,
      artifacts: [{ id: 'brief', title: 'Acme brief', type: 'markdown', content: '# Acme' }], error: null,
    }, 'thread-1')
    expect(query.mock.calls[0][1][1]).toBe('ready_for_review')
  })

  test('claims only the assignment row when optional profile data is left joined', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: jest.fn(),
    }
    jest.spyOn(db, 'connect').mockResolvedValue(client)

    await expect(assignments.claimNext()).resolves.toBeNull()

    expect(client.query.mock.calls[1][0]).toContain('LEFT JOIN skill_user_profiles')
    expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE OF a SKIP LOCKED')
    expect(client.query.mock.calls[1][0]).not.toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(client.release).toHaveBeenCalled()
  })
})
