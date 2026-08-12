const express = require('express')
const db = require('../db')
const requireAuth = require('../middleware/requireAuth')
const { getSkillCatalog, installSkill, previewSkill, publicSkill, skillsForEnabledIds } = require('../skills')
const skillRunner = require('../skillRunner')
const connectorBroker = require('../skillConnectorBroker')

const router = express.Router()

router.get('/v2/skills/available', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT enabled_v2_skills FROM users WHERE email = $1',
      [req.user.email.toLowerCase().trim()]
    )
    const enabledIds = result.rows[0]?.enabled_v2_skills || []
    res.json({ skills: (await skillsForEnabledIds(enabledIds)).map(publicSkill) })
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
    res.json({ skills: (await skillsForEnabledIds(enabledIds)).map(publicSkill) })
  } catch {
    res.status(500).json({ error: 'Failed to fetch skills' })
  }
})

function requireAdmin(req, res) {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

router.get('/auth/admin/v2/skills', async (req, res) => {
  if (!requireAdmin(req, res)) return
  res.json({ skills: (await getSkillCatalog()).map(({ content, ...skill }) => skill) })
})

router.post('/auth/admin/v2/skills/preview', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    res.json({ skill: await previewSkill(req.body || {}) })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to preview skill' })
  }
})

router.post('/auth/admin/v2/skills/describe', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const provider = String(req.body?.provider || 'mindstudio').trim().toLowerCase()
    const providerAppId = String(req.body?.providerAppId || '').trim()
    const providerVersion = String(req.body?.providerVersion || '').trim()
    const manifest = await skillRunner.describeSkill({ provider, appId: providerAppId, version: providerVersion })
    const unsupportedConnector = manifest.connectors.find(connector => !connectorBroker.supportsDeclaration(connector))
    if (unsupportedConnector) throw Object.assign(new Error(`Connector ${unsupportedConnector.connector} is not supported by ClarityMode yet.`), { status: 400 })
    res.json({
      skill: {
        id: manifest.skillId,
        name: manifest.name,
        description: manifest.description,
        version: manifest.skillVersion,
        contractVersion: manifest.contractVersion,
        provider,
        providerAppId,
        providerVersion,
        manifest,
        summary: manifest.description,
      },
    })
  } catch (error) {
    res.status(Number(error.status) || 500).json({ error: Number(error.status) ? error.message : 'That Skill workflow could not be read.' })
  }
})

router.post('/auth/admin/v2/skills', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const skill = await installSkill(req.body || {})
    const assignTo = Array.isArray(req.body.assignTo) ? req.body.assignTo.map(email => String(email).toLowerCase().trim()).filter(Boolean) : []
    if (assignTo.length) {
      await Promise.all(assignTo.map(email => db.query(
        `UPDATE users
         SET enabled_v2_skills = CASE
           WHEN $1 = ANY(enabled_v2_skills) THEN enabled_v2_skills
           ELSE array_append(enabled_v2_skills, $1)
         END
         WHERE email = $2`,
        [skill.id, email],
      )))
    }
    const { content, ...metadata } = skill
    res.json({ ok: true, skill: metadata })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) })
  }
})

router.get('/auth/admin/v2/skills/catalog', async (req, res) => {
  if (!requireAdmin(req, res)) return
  res.json({ skills: (await getSkillCatalog()).map(({ content, ...skill }) => skill) })
})

router.get('/auth/admin/skills/catalog', async (req, res) => {
  if (!requireAdmin(req, res)) return
  res.json({ skills: (await getSkillCatalog()).map(({ content, ...skill }) => skill) })
})

module.exports = router
