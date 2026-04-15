process.env.JWT_SECRET = 'test-secret-for-jest-only'
jest.mock('../src/db')
jest.mock('../src/anthropic')
const db = require('../src/db')
const request = require('supertest')
const app = require('../server')
const bcrypt = require('bcryptjs')

describe('POST /auth/signup', () => {
  it('returns 400 when fields missing', async () => {
    const res = await request(app).post('/auth/signup').send({ email: 'a@b.com' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when password under 8 chars', async () => {
    const res = await request(app).post('/auth/signup').send({ email: 'a@b.com', password: 'short' })
    expect(res.status).toBe(400)
  })

  it('returns token on success', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', email: 'a@b.com' }] })
    const res = await request(app).post('/auth/signup').send({ email: 'a@b.com', password: 'password123' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeDefined()
  })

  it('returns 409 when email already exists', async () => {
    db.query.mockRejectedValueOnce({ code: '23505' })
    const res = await request(app).post('/auth/signup').send({ email: 'a@b.com', password: 'password123' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Email already in use')
  })
})

describe('POST /auth/login', () => {
  it('returns 400 when fields missing', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com' })
    expect(res.status).toBe(400)
  })

  it('returns token for valid credentials', async () => {
    const hash = await bcrypt.hash('password123', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-2', email: 'a@b.com', password_hash: hash }] })
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com', password: 'password123' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeDefined()
  })

  it('returns 401 for wrong password', async () => {
    const hash = await bcrypt.hash('correct', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-3', email: 'a@b.com', password_hash: hash }] })
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
