jest.mock('../src/db')
const db = require('../src/db')
const {
  createUser,
  login,
  refreshTrustedSession,
  revokeTrustedSession,
  changePassword,
  resetPassword,
  verifyToken,
  authenticateToken,
  refreshTokenHash,
} = require('../src/auth')

process.env.JWT_SECRET = 'test-secret-for-jest-only'

beforeEach(() => db.query.mockReset())

describe('createUser', () => {
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

  it('creates a revocable trusted-device session only when requested', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('password123', 1)
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-trusted', email: 'a@b.com', password_hash: hash, is_approved: true }] })
      .mockResolvedValueOnce({ rows: [] })
    const result = await login('a@b.com', 'password123', { rememberMe: true, deviceName: 'Home PC' })
    expect(result.refreshToken).toBeTruthy()
    expect(db.query.mock.calls[1][0]).toMatch(/INSERT INTO trusted_device_sessions/)
    expect(db.query.mock.calls[1][1][0]).toBe('uuid-trusted')
    expect(db.query.mock.calls[1][1][1]).toBe(refreshTokenHash(result.refreshToken))
    expect(db.query.mock.calls[1][1][2]).toBe('Home PC')
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

describe('trusted device sessions', () => {
  it('rotates a valid session and returns a fresh access token', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'uuid-refresh', email: 'a@b.com', enabled_packs: ['podcast'], enabled_v2_skills: ['skill-one'] }],
    })
    const result = await refreshTrustedSession('old-refresh-token', 'Laptop')
    expect(result.token).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()
    expect(result.refreshToken).not.toBe('old-refresh-token')
    expect(result.enabledPacks).toEqual(['podcast'])
    expect(db.query.mock.calls[0][1][0]).toBe(refreshTokenHash('old-refresh-token'))
  })

  it('rejects an expired or revoked session', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    await expect(refreshTrustedSession('expired')).rejects.toMatchObject({ status: 401 })
  })

  it('revokes the current trusted device without storing its raw token', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    await revokeTrustedSession('current-device-token')
    expect(db.query.mock.calls[0][1]).toEqual([refreshTokenHash('current-device-token')])
  })
})

describe('changePassword', () => {
  it('succeeds with correct current password', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('oldpass1', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-7', password_hash: hash }] })
    db.query.mockResolvedValueOnce({ rows: [] })
    const result = await changePassword('a@b.com', 'oldpass1', 'newpass1')
    expect(result.ok).toBe(true)
    expect(db.query.mock.calls[2][0]).toMatch(/UPDATE trusted_device_sessions/)
  })

  it('throws 401 for wrong current password', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('correct1', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-8', password_hash: hash }] })
    await expect(changePassword('a@b.com', 'wrong123', 'newpass1')).rejects.toMatchObject({ status: 401 })
  })

  it('throws 404 for unknown user', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    await expect(changePassword('nope@b.com', 'oldpass1', 'newpass1')).rejects.toMatchObject({ status: 404 })
  })

  it('throws 400 when new password too short', async () => {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash('oldpass1', 1)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-9', password_hash: hash }] })
    await expect(changePassword('a@b.com', 'oldpass1', 'short')).rejects.toMatchObject({ status: 400 })
  })
})

describe('resetPassword', () => {
  it('updates password for existing user', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-reset', email: 'a@b.com' }] })
      .mockResolvedValueOnce({ rows: [] })
    const result = await resetPassword('a@b.com', 'newpass123')
    expect(result.email).toBe('a@b.com')
    expect(db.query.mock.calls[1][1]).toEqual(['uuid-reset'])
  })

  it('throws for unknown user', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    await expect(resetPassword('nope@b.com', 'newpass123')).rejects.toThrow()
  })

  it('throws for short password', async () => {
    await expect(resetPassword('a@b.com', 'short')).rejects.toThrow()
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

describe('authenticateToken', () => {
  it('returns the current approved user from the database', async () => {
    const jwt = require('jsonwebtoken')
    const signed = jwt.sign({ sub: 'uuid-approved', email: 'old@b.com' }, process.env.JWT_SECRET)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-approved', email: 'a@b.com', is_approved: true }] })

    const user = await authenticateToken(signed)

    expect(user.sub).toBe('uuid-approved')
    expect(user.email).toBe('a@b.com')
  })

  it('throws 403 for a suspended user token', async () => {
    const jwt = require('jsonwebtoken')
    const signed = jwt.sign({ sub: 'uuid-suspended', email: 'a@b.com' }, process.env.JWT_SECRET)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-suspended', email: 'a@b.com', is_approved: false }] })

    await expect(authenticateToken(signed)).rejects.toMatchObject({ status: 403 })
  })

  it('throws 401 when the token user no longer exists', async () => {
    const jwt = require('jsonwebtoken')
    const signed = jwt.sign({ sub: 'uuid-missing', email: 'a@b.com' }, process.env.JWT_SECRET)
    db.query.mockResolvedValueOnce({ rows: [] })

    await expect(authenticateToken(signed)).rejects.toMatchObject({ status: 401 })
  })

  it('rejects every older access token after the account auth version changes', async () => {
    const jwt = require('jsonwebtoken')
    const signed = jwt.sign({ sub: 'uuid-changed', email: 'a@b.com', av: 2 }, process.env.JWT_SECRET)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'uuid-changed', email: 'a@b.com', is_approved: true, auth_version: 3 }],
    })

    await expect(authenticateToken(signed)).rejects.toMatchObject({ status: 401 })
  })
})
