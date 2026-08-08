const express = require('express')
const db = require('../db')
const requireAuth = require('../middleware/requireAuth')
const producer = require('../youtubeScriptProducer')

const router = express.Router()
const SKILL_ID = 'claritymode-youtube-script-producer'

router.use(requireAuth)

async function hasEntitlement(userId) {
  const result = await db.query(
    'SELECT $1 = ANY(enabled_v2_skills) AS enabled FROM users WHERE id = $2',
    [SKILL_ID, userId],
  )
  return Boolean(result.rows[0]?.enabled)
}

router.get('/status', async (req, res) => {
  try {
    const entitled = await hasEntitlement(req.user.sub)
    res.json({
      ok: true,
      skillId: SKILL_ID,
      entitled,
      serviceReady: entitled && producer.configured(),
    })
  } catch {
    res.status(500).json({ error: 'Could not check YouTube Script Producer access.' })
  }
})

router.post('/run', async (req, res) => {
  try {
    if (!await hasEntitlement(req.user.sub)) {
      return res.status(403).json({ error: 'YouTube Script Producer is not enabled for this account.' })
    }
    const output = await producer.run(req.body || {})
    res.json({ ok: true, ...output })
  } catch (error) {
    const status = Number(error.status) || 500
    res.status(status).json({
      error: status >= 500
        ? 'YouTube Script Producer could not complete that request.'
        : error.message,
    })
  }
})

module.exports = router
module.exports.SKILL_ID = SKILL_ID
module.exports.hasEntitlement = hasEntitlement
