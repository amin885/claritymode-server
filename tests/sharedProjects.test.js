process.env.JWT_SECRET = 'test-secret-for-jest-only'
jest.mock('../src/db')

const jwt = require('jsonwebtoken')
const request = require('supertest')
const db = require('../src/db')
const app = require('../server')

function token(userId = 'user-1', email = 'owner@example.com') {
  return jwt.sign({ sub: userId, email }, process.env.JWT_SECRET)
}

function authenticate(userId = 'user-1', email = 'owner@example.com') {
  db.query.mockResolvedValueOnce({ rows: [{ id: userId, email, is_approved: true }] })
}

function mockClient(rows = []) {
  const query = jest.fn()
  for (const result of rows) query.mockResolvedValueOnce(result)
  query.mockResolvedValue({ rows: [] })
  const client = { query, release: jest.fn() }
  db.connect.mockResolvedValueOnce(client)
  return client
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('shared project authorization', () => {
  test('requires authentication for every collaboration route', async () => {
    const response = await request(app).get('/v2/shared-projects')
    expect(response.status).toBe(401)
  })

  test('lists only active projects where the user is a current member', async () => {
    authenticate()
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'project-1',
        title: 'Camping',
        owner_user_id: 'user-1',
        role: 'owner',
        schema_version: 1,
        minimum_app_version: '0.10.221',
        revision: '4',
        snapshot: { title: 'Camping' },
        status: 'active',
        updated_at: new Date(),
      }],
    })
    const response = await request(app)
      .get('/v2/shared-projects')
      .set('Authorization', `Bearer ${token()}`)
    expect(response.status).toBe(200)
    expect(response.body.projects[0]).toMatchObject({ title: 'Camping', revision: 4, role: 'owner' })
    expect(db.query.mock.calls[1][0]).toContain('m.user_id = $1')
  })

  test('does not reveal whether an unshared project exists', async () => {
    authenticate('user-2', 'member@example.com')
    db.query.mockResolvedValueOnce({ rows: [] })
    const response = await request(app)
      .get('/v2/shared-projects/project-secret/changes?since=0')
      .set('Authorization', `Bearer ${token('user-2', 'member@example.com')}`)
    expect(response.status).toBe(404)
  })
})

describe('shared project creation and invitations', () => {
  test('creates the owner membership and initial snapshot transactionally', async () => {
    authenticate()
    const client = mockClient([
      { rows: [] },
      { rows: [{
        id: 'project-1',
        title: 'Camping',
        owner_user_id: 'user-1',
        schema_version: 1,
        minimum_app_version: '0.10.221',
        revision: '0',
        snapshot: { title: 'Camping', projectAreas: [] },
        status: 'active',
        updated_at: new Date(),
      }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ])
    const response = await request(app)
      .post('/v2/shared-projects')
      .set('Authorization', `Bearer ${token()}`)
      .send({ title: 'Camping', snapshot: { title: 'Camping', projectAreas: [] } })
    expect(response.status).toBe(201)
    expect(response.body.project.role).toBe('owner')
    expect(client.query.mock.calls.some(call => String(call[0]).includes('shared_project_members'))).toBe(true)
    expect(client.query).toHaveBeenLastCalledWith('COMMIT')
  })

  test('rejects an invitation created by a non-owner without leaking the project', async () => {
    authenticate('user-2', 'member@example.com')
    const client = mockClient([{ rows: [] }, { rows: [] }, { rows: [] }])
    const response = await request(app)
      .post('/v2/shared-projects/project-1/invitations')
      .set('Authorization', `Bearer ${token('user-2', 'member@example.com')}`)
      .send({ email: 'other@example.com' })
    expect(response.status).toBe(404)
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
  })

  test('accepts an invitation only for the authenticated normalized email', async () => {
    authenticate('user-2', 'wife@example.com')
    const client = mockClient([
      { rows: [] },
      { rows: [{
        id: 'invite-1',
        project_id: 'project-1',
        invited_email: 'Wife@Example.com',
        status: 'pending',
        project_status: 'active',
        expires_at: new Date(Date.now() + 60_000),
      }] },
      { rows: [] },
      { rows: [] },
      { rows: [{
        id: 'project-1',
        title: 'Camping',
        owner_user_id: 'user-1',
        role: 'member',
        schema_version: 1,
        minimum_app_version: '0.10.221',
        revision: '0',
        snapshot: { title: 'Camping' },
        status: 'active',
        updated_at: new Date(),
      }] },
      { rows: [] },
    ])
    const response = await request(app)
      .post('/v2/shared-projects/invitations/invite-1/accept')
      .set('Authorization', `Bearer ${token('user-2', 'wife@example.com')}`)
    expect(response.status).toBe(200)
    expect(response.body.project.role).toBe('member')
  })
})

describe('revisioned shared project operations', () => {
  const operation = {
    deviceId: 'device-12345678',
    operationId: 'operation-12345678',
    baseRevision: 2,
    kind: 'task.complete',
    payload: { taskId: 'task-1', completed: true },
    snapshot: { title: 'Camping', projectAreas: [] },
  }

  test('rejects stale writes with the canonical snapshot', async () => {
    authenticate()
    const client = mockClient([
      { rows: [] },
      { rows: [{
        id: 'project-1',
        owner_user_id: 'user-1',
        role: 'owner',
        revision: '3',
        snapshot: { title: 'Camping', changed: true },
        status: 'active',
      }] },
      { rows: [] },
      { rows: [] },
    ])
    const response = await request(app)
      .post('/v2/shared-projects/project-1/operations')
      .set('Authorization', `Bearer ${token()}`)
      .send(operation)
    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ revision: 3, snapshot: { title: 'Camping', changed: true } })
    expect(client.query.mock.calls.some(call => String(call[0]).startsWith('INSERT INTO shared_project_operations'))).toBe(false)
  })

  test('deduplicates a retried device operation', async () => {
    authenticate()
    const client = mockClient([
      { rows: [] },
      { rows: [{ id: 'project-1', role: 'owner', revision: '2', status: 'active' }] },
      { rows: [{ revision: '3' }] },
      { rows: [] },
    ])
    const response = await request(app)
      .post('/v2/shared-projects/project-1/operations')
      .set('Authorization', `Bearer ${token()}`)
      .send(operation)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ duplicate: true, revision: 3 })
  })

  test('commits an operation and next snapshot atomically', async () => {
    authenticate()
    const client = mockClient([
      { rows: [] },
      { rows: [{ id: 'project-1', role: 'owner', revision: '2', status: 'active' }] },
      { rows: [] },
      { rows: [{ id: 'change-1', created_at: new Date() }] },
      { rows: [] },
      { rows: [] },
    ])
    const response = await request(app)
      .post('/v2/shared-projects/project-1/operations')
      .set('Authorization', `Bearer ${token()}`)
      .send(operation)
    expect(response.status).toBe(201)
    expect(response.body.revision).toBe(3)
    expect(client.query).toHaveBeenLastCalledWith('COMMIT')
  })
})
