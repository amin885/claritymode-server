const assignments = require('../src/skillAssignments')
const db = require('../src/db')

describe('durable ClarityMode Skill assignments', () => {
  test('routes only explicitly listed users to the test workflow', () => {
    const original = {
      agentId: process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID,
      version: process.env.MINDSTUDIO_YOUTUBE_PRODUCER_VERSION,
      testAgentId: process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_AGENT_ID,
      testVersion: process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_VERSION,
      testUserIds: process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_USER_IDS,
    }
    process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID = 'production-agent'
    process.env.MINDSTUDIO_YOUTUBE_PRODUCER_VERSION = 'production-version'
    process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_AGENT_ID = 'test-agent'
    process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_VERSION = 'test-version'
    process.env.MINDSTUDIO_YOUTUBE_PRODUCER_TEST_USER_IDS = 'user-a, user-b'

    try {
      expect(assignments.agentConfigFor({ user_id: 'user-a' })).toEqual({
        appId: 'test-agent',
        version: 'test-version',
      })
      expect(assignments.agentConfigFor({ user_id: 'user-c' })).toEqual({
        appId: 'production-agent',
        version: 'production-version',
      })
      expect(assignments.agentConfigFor({})).toEqual({
        appId: 'production-agent',
        version: 'production-version',
      })
    } finally {
      for (const [key, value] of Object.entries({
        MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID: original.agentId,
        MINDSTUDIO_YOUTUBE_PRODUCER_VERSION: original.version,
        MINDSTUDIO_YOUTUBE_PRODUCER_TEST_AGENT_ID: original.testAgentId,
        MINDSTUDIO_YOUTUBE_PRODUCER_TEST_VERSION: original.testVersion,
        MINDSTUDIO_YOUTUBE_PRODUCER_TEST_USER_IDS: original.testUserIds,
      })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

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

  test('keeps approval, interview, and final-artifact payloads inside their matching states', () => {
    const needsInput = assignments.parseAgentResult({
      status: 'needs_input',
      stage: 'await_interview',
      question: { id: 'q1', prompt: 'What happened?' },
      approval: { data: { angle: 'Stale angle' } },
      artifacts: [{ title: 'Stale outline', content: 'Do not show this yet.' }],
    })
    expect(needsInput.question).toEqual({ id: 'q1', prompt: 'What happened?' })
    expect(needsInput.approval).toBeNull()
    expect(needsInput.artifacts).toEqual([])

    const ready = assignments.parseAgentResult({
      status: 'ready_for_review',
      stage: 'ready_for_review',
      question: { id: 'stale-question' },
      approval: { data: { angle: 'Stale angle' } },
      artifacts: [{ title: 'Outline', content: '# Final outline' }],
    })
    expect(ready.question).toBeNull()
    expect(ready.approval).toBeNull()
    expect(ready.artifacts).toHaveLength(1)
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

  test('ignores expired large-file references in MindStudio thread history', async () => {
    const originalApiKey = process.env.MINDSTUDIO_API_KEY
    const originalAgentId = process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID
    process.env.MINDSTUDIO_API_KEY = 'test-key'
    process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID = 'test-agent'
    const currentResult = JSON.stringify({
      status: 'needs_input',
      stage: 'await_interview',
      progress: { label: 'One more question' },
      state: { stage: 'await_interview' },
      question: { id: 'q2', prompt: 'What happened next?' },
      artifacts: [],
    })
    const runAgent = jest.fn().mockResolvedValue({
      success: true,
      threadId: 'thread-1',
      result: currentResult,
      thread: [{ content: '@@remote_variable@@https://youai-appdata-private.s3.us-west-2.amazonaws.com/lfs/expired.json?signature=expired' }],
    })
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 403 }))

    try {
      const invocation = await assignments.invokeAgent({
        id: 'assignment-1',
        skill_id: assignments.SKILL_ID,
        skill_version: '1.0.0',
        project_context: {},
        source_task: {},
        brief: {},
        workflow_state: {},
      }, {}, {
        MindStudioAgent: class { runAgent = runAgent },
        loadSdk: jest.fn().mockResolvedValue({}),
        fetchImpl,
      })

      expect(invocation.result).toMatchObject({ status: 'needs_input', stage: 'await_interview' })
      expect(invocation.threadId).toBe('thread-1')
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      if (originalApiKey === undefined) delete process.env.MINDSTUDIO_API_KEY
      else process.env.MINDSTUDIO_API_KEY = originalApiKey
      if (originalAgentId === undefined) delete process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID
      else process.env.MINDSTUDIO_YOUTUBE_PRODUCER_AGENT_ID = originalAgentId
    }
  })

  test('does not confuse ordinary workflow nesting with remote-file indirection', async () => {
    const nested = { status: 'needs_input' }
    let cursor = nested
    for (let index = 0; index < 20; index += 1) {
      cursor.state = { step: index }
      cursor = cursor.state
    }

    await expect(assignments.resolveProviderValue(nested, jest.fn())).resolves.toEqual(nested)
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

  test('requires real creator evidence before the first approval gate', () => {
    const result = assignments.enforceYouTubeInterviewGate({ brief: { seedIdea: 'Wake up at 5am' } }, {
      status: 'needs_approval',
      stage: 'await_approval',
      progress: { label: 'Approve' },
      state: { interviewResult: { interview: { answers: [] } } },
      approval: { data: { angle: 'An inferred angle' } },
      artifacts: [],
      error: null,
    })

    expect(result).toMatchObject({
      status: 'needs_input',
      stage: 'await_interview',
      question: { id: 'firsthand-angle', kind: 'creator_interview' },
      approval: null,
    })
  })

  test('allows approval after a substantive creator answer', () => {
    const approval = {
      status: 'needs_approval',
      stage: 'await_approval',
      state: { interviewResult: { interview: { answers: [{ question: 'What happened?', answer: 'I tested this with my own routine for three months.' }] } } },
    }
    expect(assignments.enforceYouTubeInterviewGate({ brief: {} }, approval)).toBe(approval)
  })

  test('consumes the legacy direction gate internally only after VidIQ outliers exist', () => {
    const result = {
      status: 'needs_approval',
      approval: { data: { angle: 'A supported angle' } },
    }
    expect(() => assignments.hiddenDirectionResponse(result, {})).toThrow('outlier evidence')
    expect(assignments.hiddenDirectionResponse(result, {
      vidiq: { results: [{ evidence: { outliers: [{ title: 'Breakout video', outlierScore: 6.2 }] } }] },
    })).toEqual({ approved: true, direction: { angle: 'A supported angle' } })
  })

  test('requires durable VidIQ evidence before an outline can be reviewed', () => {
    const completeOutline = '# Wake up at 5am\n\n## Why this idea can perform\nThe wake up at 5am query has breakout evidence.\n\n## Alternative title ideas\n- A second title\n\n## Three hook options\n- Hook one\n- Hook two\n- Hook three\n\n## Core argument\nUse environmental cues.\n\n## Detailed outline\n- Start here.\n\n## Closing and call to action\nJoin the workshop.'
    const result = {
      status: 'ready_for_review',
      evidenceUsed: { vidiq: { queries: ['wake up at 5am'], summary: 'Low-competition search opportunity.' } },
      artifacts: [{ content: completeOutline }],
    }
    expect(() => assignments.enforceYouTubeVidIQGate({}, result, {})).toThrow('usable VidIQ evidence')
    expect(assignments.enforceYouTubeVidIQGate({}, result, {
      vidiq: { results: [{ query: 'wake up at 5am', evidence: { outliers: [{ title: 'Breakout', outlierScore: 8.4 }], keyword: { searchVolume: 1200, competition: 'low' } } }] },
    })).toBe(result)
  })

  test('distinguishes genuine outlier research from legacy keyword-only evidence', () => {
    expect(assignments.hasOutlierEvidence([
      { query: 'wake up at 5am', evidence: { keyword: { searchVolume: 1200, competition: 'low' } } },
    ])).toBe(false)
    expect(assignments.hasOutlierEvidence([
      { query: 'wake up at 5am', evidence: { outliers: [{ title: 'Breakout', outlierScore: 8.4 }] } },
    ])).toBe(true)
  })

  test('requires the final artifact to explain how VidIQ shaped it', () => {
    const evidence = {
      vidiq: { queries: ['wake up at 5am'], results: [{ query: 'wake up at 5am', evidence: { outliers: [{ title: 'Breakout', outlierScore: 8.4 }], keyword: { searchVolume: 1200 } } }] },
    }
    expect(() => assignments.enforceYouTubeVidIQGate({}, {
      status: 'ready_for_review',
      evidenceUsed: {},
      artifacts: [{ content: '# Outline' }],
    }, evidence)).toThrow('explain how it used')
    expect(() => assignments.enforceYouTubeVidIQGate({}, {
      status: 'ready_for_review',
      evidenceUsed: { vidiq: { queries: ['wake up at 5am'], decisions: ['Use the exact phrase in the title.'] } },
      artifacts: [{ content: '# Outline without the evidence section' }],
    }, evidence)).toThrow('required why this idea can perform section')

    expect(assignments.enforceYouTubeVidIQGate({}, {
      status: 'ready_for_review',
      evidenceUsed: {},
      artifacts: [{ content: '# Wake up at 5am\n\n## Why this idea can perform\nThe wake up at 5am query has an 8.4x breakout.\n\n## Alternative title ideas\n- A second title\n\n## Three hook options\n- Hook one\n- Hook two\n- Hook three\n\n## Core argument\nUse environmental cues.\n\n## Detailed outline\n- Start here.\n\n## Closing and call to action\nJoin the workshop.' }],
    }, evidence)).toMatchObject({ status: 'ready_for_review' })
  })

  test('accepts clear equivalent outline headings without weakening the content gate', () => {
    const evidence = {
      vidiq: { queries: ['morning planning'], results: [{ query: 'morning planning', evidence: { outliers: [{ title: 'Plan Tomorrow Tonight', outlierScore: 7.1 }] } }] },
    }
    const result = {
      status: 'ready_for_review',
      evidenceUsed: { vidiq: { queries: ['morning planning'], decisions: ['Use the breakout framing.'] } },
      artifacts: [{ content: '# Plan Tomorrow Tonight\n\n## Outlier evidence and reach opportunity\nA 7.1x breakout supports this direction.\n\n## Title options\n- Why Morning Planning Is Too Late\n\n## Hooks\n- Hook one\n- Hook two\n- Hook three\n\n## Central argument\nPlan the night before.\n\n## Video outline\n- Opening\n- Main point\n\n## Conclusion and CTA\nTry tonight planning.' }],
    }
    expect(assignments.enforceYouTubeVidIQGate({}, result, evidence)).toBe(result)
  })

  test('retries temporary provider failures without exposing provider details', () => {
    const failure = assignments.assignmentFailure(Object.assign(new Error('MindStudio fetch failed: ECONNRESET'), { code: 'ECONNRESET' }), {
      stage: 'await_interview',
      attempt_count: 0,
    })
    expect(failure).toMatchObject({ transient: true, retry: true, attempt: 1 })
    expect(failure.public.message).not.toMatch(/MindStudio|ECONNRESET/i)
    expect(failure.internal).toMatchObject({ code: 'ECONNRESET', stage: 'await_interview' })
  })

  test('stops retrying temporary failures after the bounded retry window', () => {
    const failure = assignments.assignmentFailure(new Error('Gateway timeout'), { attempt_count: 2 })
    expect(failure).toMatchObject({ transient: true, retry: false, attempt: 3 })
  })

  test('gives malformed results a useful safe message while retaining private diagnostics', () => {
    const failure = assignments.assignmentFailure(new Error('The Skill returned an unreadable result.'), { stage: 'await_outline' })
    expect(failure.public).toEqual({
      code: 'incomplete_result',
      message: 'ClarityMode received an incomplete result. Your work was preserved; try again.',
    })
    expect(failure.internal.message).toContain('unreadable result')
  })

  test('explains missing VidIQ evidence without exposing the provider', () => {
    const failure = assignments.assignmentFailure(new Error('The Skill tried to finish without usable VidIQ evidence.'), { stage: 'await_outline' })
    expect(failure.public).toEqual({
      code: 'vidiq_evidence_missing',
      message: 'VidIQ did not return usable research for this outline. Your work was preserved; try again.',
    })
  })

  test('stops cleanly when VidIQ has no breakout opportunity', () => {
    const failure = assignments.assignmentFailure(new Error('The Skill tried to continue without usable VidIQ outlier evidence.'), { stage: 'await_outline' })
    expect(failure.public).toEqual({
      code: 'vidiq_opportunity_missing',
      message: 'VidIQ did not find enough breakout evidence for this topic. Try a broader or adjacent idea.',
    })
  })

  test('retains the last meaningful stage when a failed assignment is shown publicly', () => {
    expect(assignments.publicAssignment({
      id: 'assignment-1',
      status: 'failed',
      stage: 'failed',
      workflow_state: { stage: 'ready_for_review' },
      artifacts: [],
    }).stage).toBe('ready_for_review')
  })

  test('builds a compact VidIQ recovery request for a pre-migration outline revision', () => {
    const row = {
      source_task: { text: 'Do you have too many productivity tools?' },
      brief: { seedIdea: 'Too many productivity tools' },
      artifacts: [{ title: 'Why productivity tools stop helping' }],
      workflow_state: { stage: 'ready_for_review' },
    }
    expect(assignments.needsRevisionEvidenceRecovery(row, {}, { revisionNotes: 'Make the argument sharper.' })).toBe(true)
    expect(assignments.revisionResearchQueries(row)).toEqual([
      'Too many productivity tools',
      'Do you have too many productivity tools?',
      'Why productivity tools stop helping',
    ])
  })
})
