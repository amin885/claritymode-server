const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const db = require('./db')

const TRUSTED_SESSION_DAYS = 180

function signToken(user) {
  return {
    token: jwt.sign(
      { sub: user.id, email: user.email, av: Number(user.auth_version || 0) },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    ),
  }
}

function refreshToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function refreshTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function normalizeDeviceName(value) {
  return String(value || '').trim().slice(0, 120)
}

async function createTrustedSession(user, deviceName = '') {
  const token = refreshToken()
  await db.query(
    `INSERT INTO trusted_device_sessions (user_id, token_hash, device_name, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 day'))`,
    [user.id, refreshTokenHash(token), normalizeDeviceName(deviceName), TRUSTED_SESSION_DAYS]
  )
  return token
}

async function createUser(email, password) {
  const hash = await bcrypt.hash(password, 12)
  const result = await db.query(
    'INSERT INTO users (email, password_hash, is_approved) VALUES ($1, $2, true) RETURNING id, email',
    [email.toLowerCase().trim(), hash]
  )
  return result.rows[0]
}

async function login(email, password, options = {}) {
  const result = await db.query(
    'SELECT id, email, password_hash, is_approved, enabled_packs, enabled_v2_skills, auth_version FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  )
  const user = result.rows[0]
  if (!user) throw Object.assign(new Error('Invalid credentials'), { status: 401 })
  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) throw Object.assign(new Error('Invalid credentials'), { status: 401 })
  if (!user.is_approved) throw Object.assign(new Error('Account not authorized. Contact Amin to request access.'), { status: 403 })
  const { token } = signToken({ id: user.id, email: user.email })
  const response = {
    token,
    enabledPacks: user.enabled_packs || [],
    enabledV2Skills: user.enabled_v2_skills || [],
  }
  if (options.rememberMe === true) {
    response.refreshToken = await createTrustedSession(user, options.deviceName)
  }
  return response
}

async function refreshTrustedSession(token, deviceName = '') {
  if (!token) throw Object.assign(new Error('Trusted device session required'), { status: 401 })
  const nextToken = refreshToken()
  const result = await db.query(
    `WITH current_session AS (
       UPDATE trusted_device_sessions session
       SET revoked_at = now(), last_used_at = now()
       FROM users account
       WHERE session.user_id = account.id
         AND session.token_hash = $1
         AND session.revoked_at IS NULL
         AND session.expires_at > now()
         AND account.is_approved = true
       RETURNING account.id, account.email, account.enabled_packs, account.enabled_v2_skills, account.auth_version
     ), next_session AS (
       INSERT INTO trusted_device_sessions (user_id, token_hash, device_name, expires_at)
       SELECT id, $2, $3, now() + ($4 * interval '1 day')
       FROM current_session
       RETURNING user_id
     )
     SELECT current_session.*
     FROM current_session
     JOIN next_session ON next_session.user_id = current_session.id`,
    [refreshTokenHash(token), refreshTokenHash(nextToken), normalizeDeviceName(deviceName), TRUSTED_SESSION_DAYS]
  )
  const user = result.rows[0]
  if (!user) throw Object.assign(new Error('Trusted device session expired or revoked'), { status: 401 })
  return {
    ...signToken(user),
    refreshToken: nextToken,
    enabledPacks: user.enabled_packs || [],
    enabledV2Skills: user.enabled_v2_skills || [],
  }
}

async function revokeTrustedSession(token) {
  if (!token) return { ok: true }
  await db.query(
    `UPDATE trusted_device_sessions
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE token_hash = $1`,
    [refreshTokenHash(token)]
  )
  return { ok: true }
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
  await db.query(
    'UPDATE users SET password_hash = $1, auth_version = auth_version + 1 WHERE id = $2',
    [hash, user.id]
  )
  await db.query(
    'UPDATE trusted_device_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1',
    [user.id]
  )
  return { ok: true }
}

async function resetPassword(email, newPassword) {
  if (newPassword.length < 8) throw new Error('Password must be at least 8 characters')
  const hash = await bcrypt.hash(newPassword, 12)
  const result = await db.query(
    'UPDATE users SET password_hash = $1, auth_version = auth_version + 1 WHERE email = $2 RETURNING id, email',
    [hash, email.toLowerCase().trim()]
  )
  if (!result.rows[0]) throw new Error(`No user found with email: ${email}`)
  await db.query(
    `UPDATE trusted_device_sessions
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE user_id = $1`,
    [result.rows[0].id]
  )
  return result.rows[0]
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET)
}

async function authenticateToken(token) {
  let payload
  try {
    payload = verifyToken(token)
  } catch {
    throw Object.assign(new Error('Invalid or expired token'), { status: 401 })
  }

  const result = await db.query(
    'SELECT id, email, is_approved, auth_version FROM users WHERE id = $1',
    [payload.sub]
  )
  const user = result.rows[0]
  if (!user) throw Object.assign(new Error('Invalid or expired token'), { status: 401 })
  if (!user.is_approved) throw Object.assign(new Error('Account not authorized'), { status: 403 })
  if (Number(payload.av || 0) !== Number(user.auth_version || 0)) {
    throw Object.assign(new Error('Invalid or expired token'), { status: 401 })
  }
  return { ...payload, sub: user.id, email: user.email }
}

module.exports = {
  createUser,
  login,
  refreshTrustedSession,
  revokeTrustedSession,
  changePassword,
  resetPassword,
  verifyToken,
  authenticateToken,
  refreshTokenHash,
}
