const express = require('express')
const db = require('../db')
const requireAuth = require('../middleware/requireAuth')
const { getSkillCatalog, skillsForEnabledIds } = require('../skills')

const router = express.Router()

router.get('/v2/skills/available', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT enabled_v2_skills FROM users WHERE email = $1',
      [req.user.email.toLowerCase().trim()]
    )
    const enabledIds = result.rows[0]?.enabled_v2_skills || []
    res.json({ skills: skillsForEnabledIds(enabledIds) })
  } catch {
    res.status(500).json({ error: 'Failed to fetch skills' })
  }
})

router.get('/skills/available', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT enabled_v2_skills FROM users WHERE email = $1',
      [req.user.email.toLowerCase().trim()]
    )
    const enabledIds = result.rows[0]?.enabled_v2_skills || []
    res.json({ skills: skillsForEnabledIds(enabledIds) })
  } catch {
    res.status(500).json({ error: 'Failed to fetch skills' })
  }
})

router.get('/auth/admin/v2/skills/catalog', (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  res.json({ skills: getSkillCatalog().map(({ content, ...skill }) => skill) })
})

router.get('/auth/admin/skills/catalog', (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  res.json({ skills: getSkillCatalog().map(({ content, ...skill }) => skill) })
})

module.exports = router
