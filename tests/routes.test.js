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
