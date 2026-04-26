const express = require('express')
const { createUser, login, changePassword } = require('../auth')
const requireAuth = require('../middleware/requireAuth')

const router = express.Router()

// Public signup is disabled — users are created by admin only
router.post('/signup', (req, res) => {
  res.status(403).json({ error: 'Sign-up is not available. Contact Amin to request access.' })
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  try {
    const result = await login(email, password)
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Login failed' })
  }
})

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' })
  try {
    await changePassword(req.user.email, currentPassword, newPassword)
    res.json({ ok: true })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to change password' })
  }
})

// Admin-only: create a new approved user
// Protected by ADMIN_SECRET env var — never expose this to clients
router.post('/admin/create-user', async (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  try {
    const user = await createUser(email, password)
    res.json({ ok: true, email: user.email })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' })
    res.status(500).json({ error: 'Failed to create user' })
  }
})

// Admin-only: reset a user's password
router.post('/admin/reset-password', async (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'email and password required' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  try {
    const { resetPassword } = require('../auth')
    const user = await resetPassword(email, password)
    res.json({ ok: true, email: user.email })
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

// Admin-only: list all users
router.get('/admin/users', async (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const db = require('../db')
  try {
    const result = await db.query(
      'SELECT email, is_approved, enabled_packs, created_at FROM users ORDER BY created_at DESC'
    )
    res.json({ users: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' })
  }
})

// Admin-only: set enabled packs for a user
router.patch('/admin/users/:email/packs', async (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { packs } = req.body
  if (!Array.isArray(packs)) return res.status(400).json({ error: 'packs must be an array' })
  const db = require('../db')
  try {
    const result = await db.query(
      'UPDATE users SET enabled_packs = $1 WHERE email = $2 RETURNING email, enabled_packs',
      [packs, req.params.email.toLowerCase().trim()]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ ok: true, email: result.rows[0].email, enabledPacks: result.rows[0].enabled_packs })
  } catch (err) {
    res.status(500).json({ error: 'Failed to update packs' })
  }
})

module.exports = router
