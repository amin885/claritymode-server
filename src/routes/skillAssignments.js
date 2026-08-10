const express = require('express')
const db = require('../db')
const requireAuth = require('../middleware/requireAuth')
const assignments = require('../skillAssignments')
const credentials = require('../skillCredentials')
const vidiq = require('../vidiqConnector')

const router = express.Router()
router.use(requireAuth)

async function entitled(userId, skillId) {
  const result = await db.query('SELECT $1 = ANY(enabled_v2_skills) AS enabled FROM users WHERE id = $2', [skillId, userId])
  return Boolean(result.rows[0]?.enabled)
}

router.get('/status', async (req, res) => {
  try {
    const hasSkill = await entitled(req.user.sub, assignments.SKILL_ID)
    const connector = await db.query(
      'SELECT metadata, updated_at FROM skill_connector_credentials WHERE user_id = $1 AND connector_id = $2',
      [req.user.sub, 'vidiq'],
    )
    const profileResult = await db.query(
      'SELECT profile, updated_at FROM skill_user_profiles WHERE user_id = $1 AND skill_id = $2',
      [req.user.sub, assignments.SKILL_ID],
    )
    let connectorMetadata = connector.rows[0]?.metadata || {}
    if (connector.rows[0] && !connectorMetadata.channelsCheckedAt) {
      try {
        const credentialResult = await db.query(
          'SELECT encrypted_value FROM skill_connector_credentials WHERE user_id = $1 AND connector_id = $2',
          [req.user.sub, 'vidiq'],
        )
        const apiKey = credentialResult.rows[0]?.encrypted_value ? credentials.decrypt(credentialResult.rows[0].encrypted_value) : ''
        if (apiKey) {
          const validation = await vidiq.validate(apiKey)
          connectorMetadata = {
            toolCount: validation.toolCount,
            channels: validation.channels,
            channelsCheckedAt: validation.channelsCheckedAt,
          }
          await db.query(
            `UPDATE skill_connector_credentials SET metadata = $3, updated_at = now()
             WHERE user_id = $1 AND connector_id = $2`,
            [req.user.sub, 'vidiq', connectorMetadata],
          )
        }
      } catch {
        // A connected account remains usable even if channel discovery is temporarily unavailable.
      }
    }
    const channels = Array.isArray(connectorMetadata.channels) ? connectorMetadata.channels : []
    const storedProfile = profileResult.rows[0]?.profile || {}
    const profile = {
      ...storedProfile,
      channelName: storedProfile.channelName || (channels.length === 1 ? channels[0].name : ''),
    }
    res.json({
      ok: true,
      serviceReady: assignments.configured(),
      skills: [{ id: assignments.SKILL_ID, entitled: hasSkill }],
      connectors: { vidiq: { connected: Boolean(connector.rows[0]), metadata: connectorMetadata, updatedAt: connector.rows[0]?.updated_at } },
      profiles: { [assignments.SKILL_ID]: { value: profile, updatedAt: profileResult.rows[0]?.updated_at || null } },
    })
  } catch {
    res.status(500).json({ error: 'ClarityMode Skills could not be checked.' })
  }
})

router.put('/profiles/youtube-script-producer', async (req, res) => {
  try {
    if (!await entitled(req.user.sub, assignments.SKILL_ID)) return res.status(403).json({ error: 'This Skill is not enabled for your account.' })
    const value = req.body?.profile && typeof req.body.profile === 'object' ? req.body.profile : {}
    const profile = {
      channelName: String(value.channelName || '').trim().slice(0, 160),
      channelPurpose: String(value.channelPurpose || '').trim().slice(0, 1200),
      idealViewer: String(value.idealViewer || '').trim().slice(0, 1200),
      viewerProblems: String(value.viewerProblems || '').trim().slice(0, 2000),
    }
    if (!profile.channelName || !profile.channelPurpose || !profile.idealViewer || !profile.viewerProblems) {
      return res.status(400).json({ error: 'Choose the YouTube channel and complete its purpose, ideal viewer, and viewer problems.' })
    }
    await db.query(
      `INSERT INTO skill_user_profiles (user_id, skill_id, profile)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, skill_id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = now()`,
      [req.user.sub, assignments.SKILL_ID, profile],
    )
    res.json({ ok: true, profile })
  } catch {
    res.status(500).json({ error: 'The channel profile could not be saved.' })
  }
})

router.put('/connectors/vidiq', async (req, res) => {
  try {
    if (!await entitled(req.user.sub, assignments.SKILL_ID)) return res.status(403).json({ error: 'This Skill is not enabled for your account.' })
    const apiKey = String(req.body?.apiKey || '').trim()
    if (!apiKey) return res.status(400).json({ error: 'Enter your VidIQ API key.' })
    const validation = await vidiq.validate(apiKey)
    const metadata = {
      toolCount: validation.toolCount,
      channels: validation.channels,
      channelsCheckedAt: validation.channelsCheckedAt,
    }
    await db.query(
      `INSERT INTO skill_connector_credentials (user_id, connector_id, encrypted_value, metadata)
       VALUES ($1, 'vidiq', $2, $3)
       ON CONFLICT (user_id, connector_id) DO UPDATE
         SET encrypted_value = EXCLUDED.encrypted_value, metadata = EXCLUDED.metadata, updated_at = now()`,
      [req.user.sub, credentials.encrypt(apiKey), metadata],
    )
    res.json({ ok: true, connected: true, metadata })
  } catch (error) {
    res.status(400).json({ error: String(error.message || 'VidIQ could not be connected.') })
  }
})

router.delete('/connectors/vidiq', async (req, res) => {
  await db.query('DELETE FROM skill_connector_credentials WHERE user_id = $1 AND connector_id = $2', [req.user.sub, 'vidiq'])
  res.json({ ok: true, connected: false })
})

router.post('/', async (req, res) => {
  try {
    const input = assignments.normalizeCreate(req.body || {})
    if (!await entitled(req.user.sub, input.skillId)) return res.status(403).json({ error: 'This Skill is not enabled for your account.' })
    const result = await db.query(
      `INSERT INTO skill_assignments (
        id, user_id, skill_id, skill_version, client_request_id, project_ref, source_task, brief, project_context
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (user_id, client_request_id) DO UPDATE SET updated_at = skill_assignments.updated_at
      RETURNING *`,
      [input.id, req.user.sub, input.skillId, input.skillVersion, input.clientRequestId, input.projectRef, input.sourceTask, input.brief, input.projectContext],
    )
    assignments.workOnce().catch(() => {})
    res.status(202).json({ ok: true, assignment: assignments.publicAssignment(result.rows[0]) })
  } catch (error) {
    res.status(Number(error.status) || 500).json({ error: Number(error.status) ? error.message : 'ClarityMode could not create that assignment.' })
  }
})

router.get('/', async (req, res) => {
  try {
    const values = [req.user.sub]
    let filter = ''
    if (req.query.projectPath) {
      values.push(String(req.query.projectPath))
      filter = ` AND project_ref->>'path' = $2`
    }
    const result = await db.query(
      `SELECT * FROM skill_assignments WHERE user_id = $1${filter} ORDER BY updated_at DESC LIMIT 100`,
      values,
    )
    res.json({ assignments: result.rows.map(assignments.publicAssignment) })
  } catch {
    res.status(500).json({ error: 'Assignments could not be loaded.' })
  }
})

router.get('/:id', async (req, res) => {
  const result = await db.query('SELECT * FROM skill_assignments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.sub])
  if (!result.rows[0]) return res.status(404).json({ error: 'Assignment not found.' })
  res.json({ assignment: assignments.publicAssignment(result.rows[0]) })
})

router.post('/:id/respond', async (req, res) => {
  try {
    const response = req.body?.response && typeof req.body.response === 'object' ? req.body.response : {}
    const result = await db.query(
      `UPDATE skill_assignments
          SET status = 'queued',
              stage = CASE
                WHEN status = 'failed' AND COALESCE(workflow_state->>'stage', '') <> '' THEN workflow_state->>'stage'
                ELSE stage
              END,
              pending_response = CASE
                WHEN status = 'failed' AND COALESCE(($3::jsonb->>'retry')::boolean, false)
                  THEN COALESCE(pending_response, $3::jsonb)
                ELSE $3::jsonb
              END,
              approval = NULL, question = NULL,
              progress_label = 'ClarityMode is continuing...', updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status IN ('needs_approval', 'needs_input', 'ready_for_review', 'failed')
        RETURNING *`,
      [req.params.id, req.user.sub, response],
    )
    if (!result.rows[0]) return res.status(409).json({ error: 'This assignment is not waiting for a response.' })
    assignments.workOnce().catch(() => {})
    res.status(202).json({ ok: true, assignment: assignments.publicAssignment(result.rows[0]) })
  } catch {
    res.status(500).json({ error: 'ClarityMode could not continue that assignment.' })
  }
})

router.post('/:id/accept', async (req, res) => {
  const result = await db.query(
    `UPDATE skill_assignments
        SET status = 'accepted', stage = 'accepted', progress_label = 'Accepted', accepted_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'ready_for_review'
      RETURNING *`,
    [req.params.id, req.user.sub],
  )
  if (!result.rows[0]) return res.status(409).json({ error: 'This assignment is not ready to accept.' })
  res.json({ ok: true, assignment: assignments.publicAssignment(result.rows[0]) })
})

module.exports = router
