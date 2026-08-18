process.env.JWT_SECRET = 'test-secret-for-jest-only'
process.env.CLARITYMODE_SKILL_CATALOG = JSON.stringify({
  skills: [
    {
      id: 'v2-test-skill',
      name: 'V2 Test Skill',
      description: 'Used by tests only.',
      version: '1.0.0',
      appliesTo: ['skill'],
      content: '# V2 Test Skill\n\nUse only in v2 skill tests.',
    },
  ],
})
jest.mock('../src/db')
jest.mock('../src/anthropic')
jest.mock('../src/mastraSkillProvider')
const db = require('../src/db')
const skillProvider = require('../src/mastraSkillProvider')
const request = require('supertest')
const app = require('../server')
const bcrypt = require('bcryptjs')

describe('POST /auth/signup', () => {
  it('returns 403 — signup is disabled', async () => {
    const res = await request(app).post('/auth/signup').send({ email: 'a@b.com', password: 'password123' })
    expect(res.status).toBe(403)
  })
})

describe('POST /auth/login', () => {
  it('returns 400 when fields missing', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com' })
    expect(res.status).toBe(400)
  })

  it('returns token and enabledPacks for valid credentials', async () => {
    const hash = await bcrypt.hash('password123', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-2', email: 'a@b.com', password_hash: hash, is_approved: true, enabled_packs: ['podcast'] }] })
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com', password: 'password123' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeDefined()
    expect(res.body.enabledPacks).toEqual(['podcast'])
  })

  it('returns a trusted-device credential only when Keep me signed in is requested', async () => {
    const hash = await bcrypt.hash('password123', 1)
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-remember', email: 'a@b.com', password_hash: hash, is_approved: true }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await request(app).post('/auth/login').send({
      email: 'a@b.com',
      password: 'password123',
      rememberMe: true,
      deviceName: 'Office PC',
    })
    expect(res.status).toBe(200)
    expect(res.body.refreshToken).toBeTruthy()
  })

  it('returns 401 for wrong password', async () => {
    const hash = await bcrypt.hash('correct', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-3', email: 'a@b.com', password_hash: hash, is_approved: true, enabled_packs: [] }] })
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com', password: 'wrong' })
    expect(res.status).toBe(401)
  })
})

describe('POST /auth/refresh', () => {
  it('rotates a trusted-device credential', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'uuid-refresh-route', email: 'a@b.com', enabled_packs: [], enabled_v2_skills: [] }],
    })
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'trusted-token', deviceName: 'Home PC' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
  })

  it('requires a trusted-device credential', async () => {
    const res = await request(app).post('/auth/refresh').send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /auth/logout', () => {
  it('revokes the current trusted-device credential', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app).post('/auth/logout').send({ refreshToken: 'trusted-token' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

const jwt = require('jsonwebtoken')

function makeToken() {
  return jwt.sign({ sub: 'user-1', email: 'a@b.com' }, process.env.JWT_SECRET)
}

function mockApprovedUser() {
  db.query.mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'a@b.com', is_approved: true }] })
}

describe('ClarityMode Skill assignment entitlement boundary', () => {
  test('does not report the product skill as available without account access', async () => {
    mockApprovedUser()
    db.query.mockResolvedValueOnce({ rows: [{ enabled: false }] })
    db.query.mockResolvedValueOnce({ rows: [] })
    db.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app)
      .get('/v2/skill-assignments/status')
      .set('authorization', `Bearer ${makeToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.skills).toEqual(expect.arrayContaining([expect.objectContaining({ entitled: false })]))
  })

  test('blocks execution when the account has not been assigned the skill', async () => {
    mockApprovedUser()
    db.query.mockResolvedValueOnce({ rows: [{ enabled: false }] })
    const res = await request(app)
      .post('/v2/skill-assignments/')
      .set('authorization', `Bearer ${makeToken()}`)
      .send({
        id: '11111111-1111-4111-8111-111111111111',
        clientRequestId: 'request-1',
        skillId: 'claritymode-youtube-script-producer',
        projectRef: { path: 'Projects/Test' },
        sourceTask: { id: 'task-test-1', text: 'Write a script' },
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('not enabled')
  })

  test('allows final outline revision notes before acceptance', async () => {
    mockApprovedUser()
    db.query.mockResolvedValueOnce({
      rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        user_id: 'user-1',
        status: 'queued',
        pending_response: { revisionNotes: 'Make the second section more specific.' },
        artifacts: [],
      }],
    })
    const res = await request(app)
      .post('/v2/skill-assignments/11111111-1111-4111-8111-111111111111/respond')
      .set('authorization', `Bearer ${makeToken()}`)
      .send({ response: { revisionNotes: 'Make the second section more specific.' } })
    expect(res.status).toBe(202)
    expect(db.query.mock.calls.at(-1)[0]).toContain("'ready_for_review'")
    expect(db.query.mock.calls.at(-1)[0]).toContain("pending_response")
    expect(db.query.mock.calls.at(-1)[0]).toContain("'retry'")
  })

  test('normalizes the existing retry button response to the runner retry contract', async () => {
    mockApprovedUser()
    db.query.mockResolvedValueOnce({
      rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        user_id: 'user-1',
        status: 'queued',
        pending_response: { kind: 'retry' },
        artifacts: [],
      }],
    })

    const res = await request(app)
      .post('/v2/skill-assignments/11111111-1111-4111-8111-111111111111/respond')
      .set('authorization', `Bearer ${makeToken()}`)
      .send({ response: { retry: true } })

    expect(res.status).toBe(202)
    const [query, params] = db.query.mock.calls.at(-1)
    expect(query).toContain("status = 'failed'")
    expect(query).toContain("jsonb_build_object('kind', 'retry')")
    expect(params[2]).toEqual({ retry: true })
  })
})

describe('GET /auth/admin/users', () => {
  it('returns 401 without admin secret', async () => {
    const res = await request(app).get('/auth/admin/users')
    expect(res.status).toBe(401)
  })

  it('returns user list with admin secret', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    db.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com', is_approved: true, enabled_packs: [], enabled_v2_skills: ['v2-test-skill'], created_at: new Date() }] })
    const res = await request(app).get('/auth/admin/users').set('x-admin-secret', 'test-secret')
    expect(res.status).toBe(200)
    expect(res.body.users).toHaveLength(1)
    expect(res.body.users[0].email).toBe('a@b.com')
    expect(res.body.users[0].enabled_v2_skills).toEqual(['v2-test-skill'])
  })
})

describe('PATCH /auth/admin/users/:email/approved', () => {
  it('returns 401 without admin secret', async () => {
    const res = await request(app).patch('/auth/admin/users/a@b.com/approved').send({ approved: true })
    expect(res.status).toBe(401)
  })

  it('approves a user', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    db.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com', is_approved: true }] })
    const res = await request(app)
      .patch('/auth/admin/users/a@b.com/approved')
      .set('x-admin-secret', 'test-secret')
      .send({ approved: true })
    expect(res.status).toBe(200)
    expect(res.body.isApproved).toBe(true)
  })

  it('returns 400 for non-boolean approved value', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    const res = await request(app)
      .patch('/auth/admin/users/a@b.com/approved')
      .set('x-admin-secret', 'test-secret')
      .send({ approved: 'yes' })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /auth/admin/users/:email/packs', () => {
  it('sets v1 pack ids without using the v2 skill catalog', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    db.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com', enabled_packs: ['legacy-pack'] }] })
    const res = await request(app)
      .patch('/auth/admin/users/a@b.com/packs')
      .set('x-admin-secret', 'test-secret')
      .send({ packs: ['legacy-pack'] })
    expect(res.status).toBe(200)
    expect(res.body.enabledPacks).toEqual(['legacy-pack'])
  })
})

describe('PATCH /auth/admin/users/:email/v2-skills', () => {
  it('rejects unknown v2 skill ids', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    const res = await request(app)
      .patch('/auth/admin/users/a@b.com/v2-skills')
      .set('x-admin-secret', 'test-secret')
      .send({ skills: ['not-real'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Unknown v2 skill')
  })

  it('sets known v2 skill ids separately from v1 packs', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    db.query.mockResolvedValueOnce({ rows: [{ id: 'v2-test-skill', name: 'V2 Test Skill', content: '# V2 Test Skill', status: 'active' }] })
    db.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com', enabled_v2_skills: ['v2-test-skill'] }] })
    const res = await request(app)
      .patch('/auth/admin/users/a@b.com/v2-skills')
      .set('x-admin-secret', 'test-secret')
      .send({ skills: ['v2-test-skill'] })
    expect(res.status).toBe(200)
    expect(res.body.enabledV2Skills).toEqual(['v2-test-skill'])
  })
})

describe('POST /auth/admin/reset-password', () => {
  it('returns 401 without admin secret', async () => {
    const res = await request(app).post('/auth/admin/reset-password').send({ email: 'a@b.com', password: 'newpass123' })
    expect(res.status).toBe(401)
  })

  it('resets password for existing user', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    db.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com' }] })
    const res = await request(app)
      .post('/auth/admin/reset-password')
      .set('x-admin-secret', 'test-secret')
      .send({ email: 'a@b.com', password: 'newpass123' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('returns 404 for unknown user', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    db.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app)
      .post('/auth/admin/reset-password')
      .set('x-admin-secret', 'test-secret')
      .send({ email: 'nope@b.com', password: 'newpass123' })
    expect(res.status).toBe(404)
  })
})

describe('POST /auth/change-password', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/auth/change-password').send({ currentPassword: 'old', newPassword: 'new' })
    expect(res.status).toBe(401)
  })

  it('returns 400 when fields missing', async () => {
    mockApprovedUser()
    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ currentPassword: 'old' })
    expect(res.status).toBe(400)
  })

  it('returns 401 for wrong current password', async () => {
    const hash = await bcrypt.hash('correct1', 1)
    mockApprovedUser()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-cp1', password_hash: hash }] })
    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ currentPassword: 'wrong123', newPassword: 'newpass1' })
    expect(res.status).toBe(401)
  })

  it('returns ok for valid change', async () => {
    const hash = await bcrypt.hash('oldpass1', 1)
    mockApprovedUser()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-cp2', password_hash: hash }] })
    db.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ currentPassword: 'oldpass1', newPassword: 'newpass1' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

describe('GET /v2/skills/available', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/v2/skills/available')
    expect(res.status).toBe(401)
  })

  it('returns only skills enabled for the logged-in user', async () => {
    mockApprovedUser()
    db.query.mockResolvedValueOnce({ rows: [{ enabled_v2_skills: ['v2-test-skill'] }] })
    const res = await request(app)
      .get('/v2/skills/available')
      .set('Authorization', `Bearer ${makeToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.skills).toHaveLength(1)
    expect(res.body.skills[0].id).toBe('v2-test-skill')
    expect(res.body.skills[0].content).toContain('V2 Test Skill')
  })

  it('hides skills not assigned to the logged-in user', async () => {
    mockApprovedUser()
    db.query.mockResolvedValueOnce({ rows: [{ enabled_v2_skills: [] }] })
    const res = await request(app)
      .get('/v2/skills/available')
      .set('Authorization', `Bearer ${makeToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.skills).toEqual([])
  })
})

describe('GET /auth/admin/skills/catalog', () => {
  it('returns 401 without admin secret', async () => {
    const res = await request(app).get('/auth/admin/skills/catalog')
    expect(res.status).toBe(401)
  })

  it('returns skill catalog metadata without skill content', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    const res = await request(app).get('/auth/admin/skills/catalog').set('x-admin-secret', 'test-secret')
    expect(res.status).toBe(200)
    expect(res.body.skills[0].id).toBe('v2-test-skill')
    expect(res.body.skills[0].content).toBeUndefined()
  })
})

describe('GET /auth/admin/v2/skills/catalog', () => {
  it('returns 401 without admin secret', async () => {
    const res = await request(app).get('/auth/admin/v2/skills/catalog')
    expect(res.status).toBe(401)
  })

  it('returns v2 skill catalog metadata without skill content', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    const res = await request(app).get('/auth/admin/v2/skills/catalog').set('x-admin-secret', 'test-secret')
    expect(res.status).toBe(200)
    expect(res.body.skills[0].id).toBe('v2-test-skill')
    expect(res.body.skills[0].content).toBeUndefined()
  })
})

describe('V2 owner-installed skills', () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = 'test-secret'
    global.fetch = undefined
  })

  it('reads a contract manifest from the managed Skill runner without exposing provider credentials', async () => {
    skillProvider.describeSkill.mockResolvedValueOnce({
      contractVersion: '1',
      skillId: 'company-research',
      skillVersion: '1.0.0',
      name: 'Company Research',
      description: 'Prepare a company brief.',
      inputs: [{ id: 'company', type: 'text', label: 'Company', required: true }],
      outputs: [{ id: 'brief', type: 'markdown', label: 'Brief', required: true }],
      connectors: [],
      completion: { requiresAcceptance: true, completeSourceTaskOnAcceptance: false, completeWorkAreaOnAcceptance: false },
    })
    const res = await request(app)
      .post('/auth/admin/v2/skills/describe')
      .set('x-admin-secret', 'test-secret')
      .send({ providerAppId: 'company-research', providerVersion: '1.0.0' })
    expect(res.status).toBe(200)
    expect(res.body.skill).toMatchObject({
      id: 'company-research',
      provider: 'mastra',
      providerAppId: 'company-research',
      contractVersion: '1',
    })
    expect(res.body.skill).not.toHaveProperty('apiKey')
  })

  it('previews pasted SKILL.md content with a Maude summary', async () => {
    const anthropic = require('../src/anthropic')
    anthropic.summarizeSkill.mockResolvedValueOnce('Use this skill for focused coaching.')
    const res = await request(app)
      .post('/auth/admin/v2/skills/preview')
      .set('x-admin-secret', 'test-secret')
      .send({
        content: `---
name: Coaching Skill
description: Helps with coaching.
version: 1.2.3
---

# Coaching Skill

Use this skill when coaching.`,
      })
    expect(res.status).toBe(200)
    expect(res.body.skill.id).toBe('coaching-skill')
    expect(res.body.skill.summary).toBe('Use this skill for focused coaching.')
  })

  it('rejects empty skill previews', async () => {
    const res = await request(app)
      .post('/auth/admin/v2/skills/preview')
      .set('x-admin-secret', 'test-secret')
      .send({ content: '' })
    expect(res.status).toBe(400)
  })

  it('previews SKILL.md content from a raw URL', async () => {
    const anthropic = require('../src/anthropic')
    anthropic.summarizeSkill.mockResolvedValueOnce('Imported from URL.')
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'text/markdown' },
      text: async () => '# URL Skill\n\nA remote skill.',
    })
    const res = await request(app)
      .post('/auth/admin/v2/skills/preview')
      .set('x-admin-secret', 'test-secret')
      .send({ sourceUrl: 'https://example.com/SKILL.md' })
    expect(res.status).toBe(200)
    expect(res.body.skill.id).toBe('url-skill')
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/SKILL.md')
  })

  it('rejects oversized URL imports', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'text/markdown' },
      text: async () => `# Big Skill\n\n${'x'.repeat(300 * 1024)}`,
    })
    const res = await request(app)
      .post('/auth/admin/v2/skills/preview')
      .set('x-admin-secret', 'test-secret')
      .send({ sourceUrl: 'https://example.com/SKILL.md' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('too large')
  })

  it('installs or updates a skill by stable id and assigns selected users', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'coaching-skill',
        name: 'Coaching Skill',
        description: 'Helps with coaching.',
        version: '1.0.0',
        source_url: '',
        content: '# Coaching Skill\n\nUse this skill.',
        summary: 'Summary.',
        status: 'active',
      }],
    })
    db.query.mockResolvedValueOnce({ rows: [] })
    const res = await request(app)
      .post('/auth/admin/v2/skills')
      .set('x-admin-secret', 'test-secret')
      .send({
        id: 'coaching-skill',
        name: 'Coaching Skill',
        content: '# Coaching Skill\n\nUse this skill.',
        summary: 'Summary.',
        assignTo: ['A@B.COM'],
      })
    expect(res.status).toBe(200)
    expect(res.body.skill.id).toBe('coaching-skill')
    const assignmentCall = db.query.mock.calls.find(call => String(call[0]).includes('array_append(enabled_v2_skills'))
    expect(assignmentCall[1]).toEqual(['coaching-skill', 'a@b.com'])
  })

  it('does not return inactive assigned skills to the app', async () => {
    mockApprovedUser()
    db.query.mockResolvedValueOnce({ rows: [{ enabled_v2_skills: ['archived-skill'] }] })
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'archived-skill',
        name: 'Archived Skill',
        content: '# Archived Skill',
        status: 'archived',
      }],
    })
    const res = await request(app)
      .get('/v2/skills/available')
      .set('Authorization', `Bearer ${makeToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.skills).toEqual([])
  })
})

describe('POST /chat/stream', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/chat/stream').send({ messages: [] })
    expect(res.status).toBe(401)
  })

  it('returns 400 when messages missing', async () => {
    mockApprovedUser()
    const res = await request(app)
      .post('/chat/stream')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /chat/summarize', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/chat/summarize').send({ messages: [] })
    expect(res.status).toBe(401)
  })

  it('returns summary for valid request', async () => {
    const anthropic = require('../src/anthropic')
    anthropic.summarize.mockResolvedValueOnce('A summary.')
    mockApprovedUser()
    const res = await request(app)
      .post('/chat/summarize')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.body.summary).toBe('A summary.')
  })
})
