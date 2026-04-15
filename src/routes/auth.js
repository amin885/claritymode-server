const express = require('express')
const { signup, login } = require('../auth')

const router = express.Router()

router.post('/signup', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  try {
    const result = await signup(email, password)
    res.json(result)
  } catch (err) {
    console.error('Signup error:', err.message, err.code, err.constructor?.name)
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' })
    res.status(500).json({ error: 'Signup failed' })
  }
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

module.exports = router
