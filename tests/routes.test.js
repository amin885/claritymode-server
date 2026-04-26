process.env.JWT_SECRET = 'test-secret-for-jest-only'
jest.mock('../src/db')
jest.mock('../src/anthropic')
const db = require('../src/db')
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

  it('returns 401 for wrong password', async () => {
    const hash = await bcrypt.hash('correct', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-3', email: 'a@b.com', password_hash: hash, is_approved: true, enabled_packs: [] }] })
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com', password: 'wrong' })
    expect(res.status).toBe(401)
  })
})

const jwt = require('jsonwebtoken')

function makeToken() {
  return jwt.sign({ sub: 'user-1', email: 'a@b.com' }, process.env.JWT_SECRET)
}

describe('GET /auth/admin/users', () => {
  it('returns 401 without admin secret', async () => {
    const res = await request(app).get('/auth/admin/users')
    expect(res.status).toBe(401)
  })

  it('returns user list with admin secret', async () => {
    process.env.ADMIN_SECRET = 'test-secret'
    db.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.com', is_approved: true, enabled_packs: [], created_at: new Date() }] })
    const res = await request(app).get('/auth/admin/users').set('x-admin-secret', 'test-secret')
    expect(res.status).toBe(200)
    expect(res.body.users).toHaveLength(1)
    expect(res.body.users[0].email).toBe('a@b.com')
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
    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ currentPassword: 'old' })
    expect(res.status).toBe(400)
  })

  it('returns 401 for wrong current password', async () => {
    const hash = await bcrypt.hash('correct1', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-cp1', password_hash: hash }] })
    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ currentPassword: 'wrong123', newPassword: 'newpass1' })
    expect(res.status).toBe(401)
  })

  it('returns ok for valid change', async () => {
    const hash = await bcrypt.hash('oldpass1', 1)
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

describe('POST /chat/stream', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/chat/stream').send({ messages: [] })
    expect(res.status).toBe(401)
  })

  it('returns 400 when messages missing', async () => {
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
    const res = await request(app)
      .post('/chat/summarize')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.body.summary).toBe('A summary.')
  })
})
