jest.mock('../src/db')
const db = require('../src/db')
const { signup, login, verifyToken } = require('../src/auth')

process.env.JWT_SECRET = 'test-secret-for-jest-only'

describe('signup', () => {
  it('returns a JWT token', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', email: 'a@b.com' }] })
    const result = await signup('a@b.com', 'password123')
    expect(result.token).toBeDefined()
  })

  it('passes email lowercased to db', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-2', email: 'a@b.com' }] })
    await signup('A@B.COM', 'password123')
    expect(db.query.mock.calls[0][1][0]).toBe('a@b.com')
  })
})

describe('login', () => {
  it('returns a token for valid credentials', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('password123', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-3', email: 'a@b.com', password_hash: hash }] })
    const result = await login('a@b.com', 'password123')
    expect(result.token).toBeDefined()
  })

  it('throws 401 for wrong password', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('correct', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-4', email: 'a@b.com', password_hash: hash }] })
    await expect(login('a@b.com', 'wrong')).rejects.toMatchObject({ status: 401 })
  })

  it('throws 401 for unknown email', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    await expect(login('nope@b.com', 'pw')).rejects.toMatchObject({ status: 401 })
  })
})

describe('verifyToken', () => {
  it('decodes a token signed by signup', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-5', email: 'c@d.com' }] })
    const { token } = await signup('c@d.com', 'password123')
    const payload = verifyToken(token)
    expect(payload.email).toBe('c@d.com')
  })

  it('throws for a bad token', () => {
    expect(() => verifyToken('not.a.token')).toThrow()
  })
})
