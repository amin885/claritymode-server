const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const db = require('./db')

function signToken(user) {
  return { token: jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' }) }
}

async function createUser(email, password) {
  const hash = await bcrypt.hash(password, 12)
  const result = await db.query(
    'INSERT INTO users (email, password_hash, is_approved) VALUES ($1, $2, true) RETURNING id, email',
    [email.toLowerCase().trim(), hash]
  )
  return result.rows[0]
}

async function login(email, password) {
  const result = await db.query(
    'SELECT id, email, password_hash, is_approved, enabled_packs FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  )
  const user = result.rows[0]
  if (!user) throw Object.assign(new Error('Invalid credentials'), { status: 401 })
  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) throw Object.assign(new Error('Invalid credentials'), { status: 401 })
  if (!user.is_approved) throw Object.assign(new Error('Account not authorized. Contact Amin to request access.'), { status: 403 })
  const { token } = signToken({ id: user.id, email: user.email })
  return { token, enabledPacks: user.enabled_packs || [] }
}

async function changePassword(email, currentPassword, newPassword) {
  const result = await db.query(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  )
  const user = result.rows[0]
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 })
  const valid = await bcrypt.compare(currentPassword, user.password_hash)
  if (!valid) throw Object.assign(new Error('Current password is incorrect'), { status: 401 })
  if (newPassword.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 })
  const hash = await bcrypt.hash(newPassword, 12)
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id])
  return { ok: true }
}

async function resetPassword(email, newPassword) {
  if (newPassword.length < 8) throw new Error('Password must be at least 8 characters')
  const hash = await bcrypt.hash(newPassword, 12)
  const result = await db.query(
    'UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING email',
    [hash, email.toLowerCase().trim()]
  )
  if (!result.rows[0]) throw new Error(`No user found with email: ${email}`)
  return result.rows[0]
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET)
}

module.exports = { createUser, login, changePassword, resetPassword, verifyToken }
