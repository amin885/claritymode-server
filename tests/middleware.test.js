process.env.JWT_SECRET = 'test-secret-for-jest-only'
jest.mock('../src/db')
const request = require('supertest')
const express = require('express')
const requireAuth = require('../src/middleware/requireAuth')
const jwt = require('jsonwebtoken')

const app = express()
app.get('/protected', requireAuth, (req, res) => res.json({ user: req.user }))

function makeToken(payload = { sub: 'id-1', email: 'a@b.com' }) {
  return jwt.sign(payload, process.env.JWT_SECRET)
}

describe('requireAuth', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await request(app).get('/protected')
    expect(res.status).toBe(401)
  })

  it('rejects requests with a bad token', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Bearer bad.token')
    expect(res.status).toBe(401)
  })

  it('allows requests with a valid token and attaches user', async () => {
    const token = makeToken()
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe('a@b.com')
  })
})
