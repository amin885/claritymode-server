const express = require('express')
const db = require('../db')
const requireAuth = require('../middleware/requireAuth')
const assignments = require('../skillAssignmentEngine')
const credentials = require('../skillCredentials')
const vidiq = require('../vidiqConnector')
const { getConnector, publicConnectors } = require('../skillConnectors')
const { validateAssignmentInputs, validateManifest } = require('../skillContract')
const { publicSkill, skillsForEnabledIds } = require('../skills')
const skillRunner = require('../skillRunner')

const router = express.Router()
router.use(requireAuth)

async function entitled(userId, skillId) {
  const result = await db.query('SELECT $1 = ANY(enabled_v2_skills) AS enabled FROM users WHERE id = $2', [skillId, userId])
  return Boolean(result.rows[0]?.enabled)
}

async function connectorEntitled(userId, connectorId) {
  const result = await db.query('SELECT enabled_v2_skills FROM users WHERE id = $1', [userId])
  const skills = await skillsForEnabledIds(result.rows[0]?.enabled_v2_skills || [])
  return skills.some(skill => (skill.manifest?.connectors || []).some(entry => entry.connector === connectorId))
    || (connectorId === 'vidiq' && (result.rows[0]?.enabled_v2_skills || []).includes(assignments.SKILL_ID))
}

async function saveConnector(userId, connectorId, secret) {
  if (!await connectorEntitled(userId, connectorId)) throw Object.assign(new Error('No assigned Skill is allowed to use that connection.'), { status: 403 })
  const connector = getConnector(connectorId)
  const cleanSecret = String(secret || '').trim()
  if (!cleanSecret) throw Object.assign(new Error(`Enter your ${connector.credentialLabel}.`), { status: 400 })
  const metadata = await connector.validate(cleanSecret)
  await db.query(
    `INSERT INTO skill_connector_credentials (user_id, connector_id, encrypted_value, metadata)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, connector_id) DO UPDATE
       SET encrypted_value = EXCLUDED.encrypted_value, metadata = EXCLUDED.metadata, updated_at = now()`,
    [userId, connector.id, credentials.encrypt(cleanSecret), metadata],
  )
  return { ok: true, connector: connector.id, connected: true, metadata }
}

async function removeConnector(userId, connectorId) {
  const connector = getConnector(connectorId)
  await db.query('DELETE FROM skill_connector_credentials WHERE user_id = $1 AND connector_id = $2', [userId, connector.id])
  return { ok: true, connector: connector.id, connected: false }
}

router.get('/connectors', async (req, res) => {
  try {
    const userResult = await db.query('SELECT enabled_v2_skills FROM users WHERE id = $1', [req.user.sub])
    const enabledSkills = await skillsForEnabledIds(userResult.rows[0]?.enabled_v2_skills || [])
    const allowedIds = [...new Set(enabledSkills.flatMap(skill => (skill.manifest?.connectors || []).map(entry => entry.connector)))]
    const connected = allowedIds.length
      ? await db.query('SELECT connector_id, metadata, updated_at FROM skill_connector_credentials WHERE user_id = $1 AND connector_id = ANY($2)', [req.user.sub, allowedIds])
      : { rows: [] }
    const byId = new Map(connected.rows.map(row => [row.connector_id, row]))
    res.json({
      connectors: publicConnectors(allowedIds).map(connector => ({
        ...connector,
        connected: byId.has(connector.id),
        metadata: byId.get(connector.id)?.metadata || {},
        updatedAt: byId.get(connector.id)?.updated_at || null,
      })),
    })
  } catch {
    res.status(500).json({ error: 'Skill connections could not be loaded.' })
  }
})

router.put('/connectors/:connectorId', async (req, res) => {
  try {
    res.json(await saveConnector(req.user.sub, req.params.connectorId, req.body?.secret || req.body?.apiKey))
  } catch (error) {
    res.status(Number(error.status) || 400).json({ error: String(error.message || 'That connection could not be saved.') })
  }
})

router.delete('/connectors/:connectorId', async (req, res) => {
  try { res.json(await removeConnector(req.user.sub, req.params.connectorId)) }
  catch (error) { res.status(Number(error.status) || 400).json({ error: String(error.message || 'That connection could not be removed.') }) }
})

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

router.get('/catalog', async (req, res) => {
  try {
    const result = await db.query('SELECT enabled_v2_skills FROM users WHERE id = $1', [req.user.sub])
    const enabledIds = result.rows[0]?.enabled_v2_skills || []
    const skills = await skillsForEnabledIds(enabledIds)
    const serviceReady = skills.some(skill => skill.contractVersion === '1' && skillRunner.configured(skill.provider)) || assignments.configured()
    res.json({
      serviceReady,
      skills: skills.map(({ content, sourceUrl, ...skill }) => ({
        ...publicSkill(skill),
        executable: Boolean(skill.contractVersion === '1' && skillRunner.configured(skill.provider) && skill.providerAppId && skill.manifest),
      })),
    })
  } catch {
    res.status(500).json({ error: 'ClarityMode Skills could not be loaded.' })
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
    res.json(await saveConnector(req.user.sub, 'vidiq', req.body?.apiKey))
  } catch (error) {
    res.status(400).json({ error: String(error.message || 'VidIQ could not be connected.') })
  }
})

router.delete('/connectors/vidiq', async (req, res) => {
  res.json(await removeConnector(req.user.sub, 'vidiq'))
})

router.post('/', async (req, res) => {
  try {
    const input = assignments.normalizeCreate(req.body || {})
    if (!await entitled(req.user.sub, input.skillId)) return res.status(403).json({ error: 'This Skill is not enabled for your account.' })
    const skillResult = await db.query(
      `SELECT version, contract_version, manifest FROM v2_skills WHERE id = $1 AND status = 'active'`,
      [input.skillId],
    )
    const skill = skillResult.rows[0]
    if (!skill) return res.status(404).json({ error: 'That ClarityMode Skill is not available.' })
    let workflowState = {}
    if (String(skill.contract_version || '') === '1') {
      const manifest = validateManifest(skill.manifest, input.skillId)
      input.brief = validateAssignmentInputs(manifest, input.brief)
      input.skillVersion = manifest.skillVersion
      workflowState = {
        contractVersion: '1',
        skillVersion: manifest.skillVersion,
        workPlan: Array.isArray(manifest.workPlan) ? manifest.workPlan : [],
        manifest,
      }
    } else {
      input.skillVersion = String(skill.version || input.skillVersion)
    }
    const result = await db.query(
      `INSERT INTO skill_assignments (
        id, user_id, skill_id, skill_version, client_request_id, project_ref, source_task, brief, project_context, workflow_state
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id, client_request_id) DO UPDATE SET updated_at = skill_assignments.updated_at
      RETURNING *`,
      [input.id, req.user.sub, input.skillId, input.skillVersion, input.clientRequestId, input.projectRef, input.sourceTask, input.brief, input.projectContext, workflowState],
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
        WHERE id = $1 AND user_id = $2 AND status IN ('needs_input', 'ready_for_review', 'failed')
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
  const acceptedTaskProposals = Array.isArray(req.body?.acceptedTaskProposals)
    ? req.body.acceptedTaskProposals.slice(0, 100).map((proposal, index) => ({
      id: String(proposal?.id || `proposal-${index + 1}`).trim().slice(0, 120),
      title: String(proposal?.title || '').trim().slice(0, 500),
      details: String(proposal?.details || '').trim().slice(0, 20000),
      owner: String(proposal?.owner || '').trim().slice(0, 500),
      dueDate: String(proposal?.dueDate || '').trim().slice(0, 40),
    })).filter(proposal => proposal.title)
    : []
  const result = await db.query(
    `UPDATE skill_assignments
        SET status = 'queued', stage = 'accepting', progress_label = 'Finishing this assignment...',
            pending_response = jsonb_build_object('kind', 'accept'),
            workflow_state = jsonb_set(COALESCE(workflow_state, '{}'::jsonb), '{acceptedTaskProposals}', $3::jsonb, true),
            updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'ready_for_review'
      RETURNING *`,
    [req.params.id, req.user.sub, JSON.stringify(acceptedTaskProposals)],
  )
  if (!result.rows[0]) return res.status(409).json({ error: 'This assignment is not ready to accept.' })
  assignments.workOnce().catch(() => {})
  res.status(202).json({ ok: true, assignment: assignments.publicAssignment(result.rows[0]) })
})

router.post('/:id/cancel', async (req, res) => {
  const result = await db.query(
    `UPDATE skill_assignments
        SET status = 'cancelled', stage = 'cancelled', progress_label = 'Cancelled',
            pending_response = NULL, run_started_at = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status NOT IN ('accepted', 'cancelled')
      RETURNING *`,
    [req.params.id, req.user.sub],
  )
  if (!result.rows[0]) return res.status(409).json({ error: 'This assignment cannot be cancelled.' })
  // Cancellation is final in ClarityMode immediately. The runner cleanup is
  // best-effort and cannot make a late result visible again.
  assignments.cancelRunnerState(req.params.id, req.user.sub).catch(error => {
    console.error('[skill-assignments] Runner cancellation cleanup failed', {
      assignmentId: req.params.id,
      error: String(error?.message || error || 'Unknown cancellation error').slice(0, 500),
    })
  })
  res.json({ ok: true, assignment: assignments.publicAssignment(result.rows[0]) })
})

module.exports = router
