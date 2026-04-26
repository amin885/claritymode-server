jest.mock('../src/db')
const db = require('../src/db')
const { createUser, login, verifyToken } = require('../src/auth')

process.env.JWT_SECRET = 'test-secret-for-jest-only'

describe('createUser', () => {
  beforeEach(() => db.query.mockClear())

  it('returns a JWT token', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', email: 'a@b.com' }] })
    const result = await createUser('a@b.com', 'password123')
    expect(result.id).toBeDefined()
  })

  it('passes email lowercased to db', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-2', email: 'a@b.com' }] })
    await createUser('A@B.COM', 'password123')
    expect(db.query.mock.calls[0][1][0]).toBe('a@b.com')
  })
})

describe('login', () => {
  it('returns a token and enabledPacks for valid credentials', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('password123', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-3', email: 'a@b.com', password_hash: hash, is_approved: true, enabled_packs: ['podcast'] }] })
    const result = await login('a@b.com', 'password123')
    expect(result.token).toBeDefined()
    expect(result.enabledPacks).toEqual(['podcast'])
  })

  it('returns empty enabledPacks when none set', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('password123', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-3b', email: 'a@b.com', password_hash: hash, is_approved: true, enabled_packs: [] }] })
    const result = await login('a@b.com', 'password123')
    expect(result.enabledPacks).toEqual([])
  })

  it('throws 401 for wrong password', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('correct', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-4', email: 'a@b.com', password_hash: hash, is_approved: true, enabled_packs: [] }] })
    await expect(login('a@b.com', 'wrong')).rejects.toMatchObject({ status: 401 })
  })

  it('throws 401 for unknown email', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    await expect(login('nope@b.com', 'pw')).rejects.toMatchObject({ status: 401 })
  })

  it('throws 403 for unapproved account', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('password123', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-5', email: 'a@b.com', password_hash: hash, is_approved: false, enabled_packs: [] }] })
    await expect(login('a@b.com', 'password123')).rejects.toMatchObject({ status: 403 })
  })
})

describe('verifyToken', () => {
  it('decodes a token signed by login', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('password123', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-6', email: 'c@d.com', password_hash: hash, is_approved: true, enabled_packs: [] }] })
    const { token } = await login('c@d.com', 'password123')
    const payload = verifyToken(token)
    expect(payload.email).toBe('c@d.com')
  })

  it('throws for a bad token', () => {
    expect(() => verifyToken('not.a.token')).toThrow()
  })
})
