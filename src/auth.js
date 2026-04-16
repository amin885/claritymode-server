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
    'SELECT id, email, password_hash, is_approved FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  )
  const user = result.rows[0]
  if (!user) throw Object.assign(new Error('Invalid credentials'), { status: 401 })
  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) throw Object.assign(new Error('Invalid credentials'), { status: 401 })
  if (!user.is_approved) throw Object.assign(new Error('Account not authorized. Contact Amin to request access.'), { status: 403 })
  return signToken({ id: user.id, email: user.email })
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET)
}

module.exports = { createUser, login, verifyToken }
