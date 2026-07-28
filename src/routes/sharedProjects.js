const crypto = require('crypto')
const express = require('express')
const db = require('../db')
const requireAuth = require('../middleware/requireAuth')

const router = express.Router()
const MAX_SNAPSHOT_BYTES = 1024 * 1024
const MAX_OPERATION_BYTES = 256 * 1024
const INVITATION_DAYS = 14
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 180
const requestWindows = new Map()

router.use(requireAuth)
router.use((req, res, next) => {
  const now = Date.now()
  const key = req.user.sub
  const current = requestWindows.get(key)
  const window = !current || now - current.startedAt >= RATE_WINDOW_MS
    ? { startedAt: now, count: 0 }
    : current
  window.count += 1
  requestWindows.set(key, window)
  if (window.count > RATE_LIMIT) return res.status(429).json({ error: 'Too many shared-project requests. Try again shortly.' })
  next()
})

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function validDeviceId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(value)
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function publicProject(row) {
  return {
    id: row.id,
    title: row.title,
    ownerUserId: row.owner_user_id,
    role: row.role,
    schemaVersion: row.schema_version,
    minimumAppVersion: row.minimum_app_version,
    revision: Number(row.revision),
    snapshot: row.snapshot,
    status: row.status,
    updatedAt: row.updated_at,
  }
}

function publicInvitation(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    invitedEmail: row.invited_email,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

async function loadMembership(client, projectId, userId, { ownerOnly = false, lock = false } = {}) {
  const result = await client.query(
    `SELECT p.*, m.role
       FROM shared_projects p
       JOIN shared_project_members m ON m.project_id = p.id
      WHERE p.id = $1 AND m.user_id = $2 AND m.removed_at IS NULL
        AND p.status = 'active'
        ${ownerOnly ? "AND m.role = 'owner'" : ''}
      ${lock ? 'FOR UPDATE OF p' : ''}`,
    [projectId, userId]
  )
  return result.rows[0] || null
}

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, m.role
         FROM shared_projects p
         JOIN shared_project_members m ON m.project_id = p.id
        WHERE m.user_id = $1 AND m.removed_at IS NULL AND p.status = 'active'
        ORDER BY p.updated_at DESC`,
      [req.user.sub]
    )
    res.json({ projects: result.rows.map(publicProject) })
  } catch {
    res.status(500).json({ error: 'Shared projects could not be loaded' })
  }
})

router.post('/', async (req, res) => {
  const title = String(req.body?.title || '').trim()
  const snapshot = req.body?.snapshot
  const schemaVersion = Number(req.body?.schemaVersion || 1)
  const minimumAppVersion = String(req.body?.minimumAppVersion || '0.10.221').trim()
  if (!title || title.length > 200) return res.status(400).json({ error: 'A valid project title is required' })
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return res.status(400).json({ error: 'A project snapshot is required' })
  }
  if (jsonSize(snapshot) > MAX_SNAPSHOT_BYTES) return res.status(413).json({ error: 'Project is too large to share' })
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) return res.status(400).json({ error: 'Invalid schema version' })

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `INSERT INTO shared_projects
        (owner_user_id, title, schema_version, minimum_app_version, snapshot)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.sub, title, schemaVersion, minimumAppVersion, snapshot]
    )
    const project = projectResult.rows[0]
    await client.query(
      `INSERT INTO shared_project_members (project_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [project.id, req.user.sub]
    )
    await client.query(
      `INSERT INTO shared_project_snapshots (project_id, revision, snapshot)
       VALUES ($1, 0, $2)`,
      [project.id, snapshot]
    )
    await client.query('COMMIT')
    res.status(201).json({ project: publicProject({ ...project, role: 'owner' }) })
  } catch {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Project could not be shared' })
  } finally {
    client.release()
  }
})

router.get('/invitations', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.id, i.project_id, i.invited_email, i.expires_at, i.created_at,
              p.title, u.email AS invited_by
         FROM shared_project_invitations i
         JOIN shared_projects p ON p.id = i.project_id
         JOIN users u ON u.id = i.inviter_user_id
        WHERE lower(i.invited_email) = lower($1)
          AND i.status = 'pending' AND i.expires_at > now()
          AND p.status = 'active'
        ORDER BY i.created_at DESC`,
      [req.user.email]
    )
    res.json({ invitations: result.rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      projectTitle: row.title,
      invitedBy: row.invited_by,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })) })
  } catch {
    res.status(500).json({ error: 'Invitations could not be loaded' })
  }
})

router.get('/:projectId/invitations', async (req, res) => {
  try {
    const project = await loadMembership(db, req.params.projectId, req.user.sub, { ownerOnly: true })
    if (!project) return res.status(404).json({ error: 'Shared project not found' })
    const result = await db.query(
      `SELECT id, project_id, invited_email, expires_at, created_at
         FROM shared_project_invitations
        WHERE project_id = $1 AND status = 'pending' AND expires_at > now()
        ORDER BY created_at DESC`,
      [project.id]
    )
    res.json({ invitations: result.rows.map(publicInvitation) })
  } catch {
    res.status(500).json({ error: 'Pending invitations could not be loaded' })
  }
})

router.post('/:projectId/invitations', async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  if (!email || !email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'Enter a valid ClarityMode account email' })
  }
  if (email === normalizeEmail(req.user.email)) return res.status(400).json({ error: 'You already own this project' })

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const project = await loadMembership(client, req.params.projectId, req.user.sub, { ownerOnly: true, lock: true })
    if (!project) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Shared project not found' })
    }
    const userResult = await client.query('SELECT id FROM users WHERE lower(email) = lower($1) AND is_approved = true', [email])
    if (!userResult.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'That email does not have an active ClarityMode account' })
    }
    const memberResult = await client.query(
      `SELECT 1 FROM shared_project_members
        WHERE project_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [project.id, userResult.rows[0].id]
    )
    if (memberResult.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'That person already shares this project' })
    }
    await client.query(
      `UPDATE shared_project_invitations
          SET status = 'revoked'
        WHERE project_id = $1 AND lower(invited_email) = lower($2) AND status = 'pending'`,
      [project.id, email]
    )
    const invitationResult = await client.query(
      `INSERT INTO shared_project_invitations
        (project_id, inviter_user_id, invited_email, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 day'))
       RETURNING id, project_id, invited_email, expires_at, created_at`,
      [project.id, req.user.sub, email, crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), INVITATION_DAYS]
    )
    await client.query('COMMIT')
    res.status(201).json({ invitation: publicInvitation(invitationResult.rows[0]) })
  } catch {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Invitation could not be created' })
  } finally {
    client.release()
  }
})

router.delete('/:projectId/invitations/:invitationId', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE shared_project_invitations i
          SET status = 'revoked'
        WHERE i.id = $1 AND i.project_id = $2 AND i.status = 'pending'
          AND EXISTS (
            SELECT 1
              FROM shared_project_members m
             WHERE m.project_id = i.project_id AND m.user_id = $3
               AND m.role = 'owner' AND m.removed_at IS NULL
          )
        RETURNING i.id`,
      [req.params.invitationId, req.params.projectId, req.user.sub]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Pending invitation not found' })
    res.json({ ok: true, invitationId: result.rows[0].id })
  } catch {
    res.status(500).json({ error: 'Invitation could not be canceled' })
  }
})

router.post('/invitations/:invitationId/accept', async (req, res) => {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT i.*, p.status AS project_status
         FROM shared_project_invitations i
         JOIN shared_projects p ON p.id = i.project_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [req.params.invitationId]
    )
    const invitation = result.rows[0]
    if (!invitation || invitation.status !== 'pending' || invitation.project_status !== 'active') {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Invitation is no longer available' })
    }
    if (new Date(invitation.expires_at) <= new Date()) {
      await client.query(`UPDATE shared_project_invitations SET status = 'expired' WHERE id = $1`, [invitation.id])
      await client.query('COMMIT')
      return res.status(410).json({ error: 'Invitation has expired' })
    }
    if (normalizeEmail(invitation.invited_email) !== normalizeEmail(req.user.email)) {
      await client.query('ROLLBACK')
      return res.status(403).json({ error: 'Invitation belongs to another account' })
    }
    await client.query(
      `INSERT INTO shared_project_members (project_id, user_id, role, removed_at)
       VALUES ($1, $2, 'member', NULL)
       ON CONFLICT (project_id, user_id)
       DO UPDATE SET role = 'member', removed_at = NULL, joined_at = now()`,
      [invitation.project_id, req.user.sub]
    )
    await client.query(
      `UPDATE shared_project_invitations
          SET status = 'accepted', accepted_by_user_id = $1, accepted_at = now()
        WHERE id = $2`,
      [req.user.sub, invitation.id]
    )
    const project = await loadMembership(client, invitation.project_id, req.user.sub)
    await client.query('COMMIT')
    res.json({ project: publicProject(project) })
  } catch {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Invitation could not be accepted' })
  } finally {
    client.release()
  }
})

router.get('/:projectId/members', async (req, res) => {
  try {
    const member = await loadMembership(db, req.params.projectId, req.user.sub)
    if (!member) return res.status(404).json({ error: 'Shared project not found' })
    const result = await db.query(
      `SELECT m.user_id, m.role, m.joined_at, u.email
         FROM shared_project_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 AND m.removed_at IS NULL
        ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, lower(u.email)`,
      [req.params.projectId]
    )
    res.json({
      members: result.rows.map(row => ({
        userId: row.user_id,
        email: row.email,
        role: row.role,
        joinedAt: row.joined_at,
      })),
    })
  } catch {
    res.status(500).json({ error: 'Project members could not be loaded' })
  }
})

router.get('/:projectId/changes', async (req, res) => {
  const since = Math.max(0, Number(req.query.since || 0))
  if (!Number.isSafeInteger(since)) return res.status(400).json({ error: 'Invalid revision' })
  try {
    const member = await loadMembership(db, req.params.projectId, req.user.sub)
    if (!member) return res.status(404).json({ error: 'Shared project not found' })
    const result = await db.query(
      `SELECT o.id, o.revision, o.actor_user_id, u.email AS actor_email,
              o.device_id, o.operation_id, o.base_revision, o.kind, o.payload, o.created_at
         FROM shared_project_operations o
         JOIN users u ON u.id = o.actor_user_id
        WHERE o.project_id = $1 AND o.revision > $2
        ORDER BY o.revision ASC
        LIMIT 500`,
      [req.params.projectId, since]
    )
    res.json({
      project: publicProject(member),
      changes: result.rows.map(row => ({ ...row, revision: Number(row.revision), base_revision: Number(row.base_revision) })),
    })
  } catch {
    res.status(500).json({ error: 'Project changes could not be loaded' })
  }
})

router.post('/:projectId/operations', async (req, res) => {
  const { deviceId, operationId, baseRevision, kind, payload, snapshot } = req.body || {}
  if (!validDeviceId(deviceId) || !validDeviceId(operationId)) {
    return res.status(400).json({ error: 'Valid device and operation IDs are required' })
  }
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) return res.status(400).json({ error: 'Invalid base revision' })
  if (typeof kind !== 'string' || !kind.trim() || kind.length > 80) return res.status(400).json({ error: 'Invalid operation kind' })
  if (!payload || typeof payload !== 'object' || jsonSize(payload) > MAX_OPERATION_BYTES) {
    return res.status(413).json({ error: 'Operation payload is invalid or too large' })
  }
  if (!snapshot || typeof snapshot !== 'object' || jsonSize(snapshot) > MAX_SNAPSHOT_BYTES) {
    return res.status(413).json({ error: 'Project snapshot is invalid or too large' })
  }

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const project = await loadMembership(client, req.params.projectId, req.user.sub, { lock: true })
    if (!project) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Shared project not found' })
    }
    const existing = await client.query(
      `SELECT revision FROM shared_project_operations
        WHERE project_id = $1 AND device_id = $2 AND operation_id = $3`,
      [project.id, deviceId, operationId]
    )
    if (existing.rows[0]) {
      await client.query('COMMIT')
      return res.json({ ok: true, duplicate: true, revision: Number(existing.rows[0].revision) })
    }
    if (Number(project.revision) !== baseRevision) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'Project changed on another device',
        revision: Number(project.revision),
        snapshot: project.snapshot,
      })
    }
    const revision = baseRevision + 1
    const operationResult = await client.query(
      `INSERT INTO shared_project_operations
        (project_id, revision, actor_user_id, device_id, operation_id, base_revision, kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [project.id, revision, req.user.sub, deviceId, operationId, baseRevision, kind.trim(), payload]
    )
    await client.query(
      `UPDATE shared_projects
          SET revision = $1, snapshot = $2, title = COALESCE(NULLIF($3, ''), title), updated_at = now()
        WHERE id = $4`,
      [revision, snapshot, String(snapshot.title || '').trim(), project.id]
    )
    if (revision % 25 === 0) {
      await client.query(
        `INSERT INTO shared_project_snapshots (project_id, revision, snapshot)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [project.id, revision, snapshot]
      )
    }
    await client.query('COMMIT')
    res.status(201).json({
      ok: true,
      revision,
      operation: { id: operationResult.rows[0].id, createdAt: operationResult.rows[0].created_at },
    })
  } catch {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Project change could not be synchronized' })
  } finally {
    client.release()
  }
})

router.delete('/:projectId/members/:userId', async (req, res) => {
  if (req.params.userId === req.user.sub) return res.status(400).json({ error: 'The owner cannot remove themselves' })
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const project = await loadMembership(client, req.params.projectId, req.user.sub, { ownerOnly: true, lock: true })
    if (!project) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Shared project not found' })
    }
    const result = await client.query(
      `UPDATE shared_project_members SET removed_at = now()
        WHERE project_id = $1 AND user_id = $2 AND role = 'member' AND removed_at IS NULL
        RETURNING user_id`,
      [project.id, req.params.userId]
    )
    await client.query('COMMIT')
    if (!result.rows[0]) return res.status(404).json({ error: 'Member not found' })
    res.json({ ok: true })
  } catch {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Member could not be removed' })
  } finally {
    client.release()
  }
})

router.post('/:projectId/leave', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE shared_project_members SET removed_at = now()
        WHERE project_id = $1 AND user_id = $2 AND role = 'member' AND removed_at IS NULL
        RETURNING project_id`,
      [req.params.projectId, req.user.sub]
    )
    if (!result.rows[0]) return res.status(400).json({ error: 'Owners cannot leave a shared project' })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Shared project could not be left' })
  }
})

router.post('/:projectId/stop', async (req, res) => {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const project = await loadMembership(client, req.params.projectId, req.user.sub, { ownerOnly: true, lock: true })
    if (!project) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Shared project not found' })
    }
    await client.query(`UPDATE shared_projects SET status = 'stopped', updated_at = now() WHERE id = $1`, [project.id])
    await client.query(`UPDATE shared_project_members SET removed_at = now() WHERE project_id = $1 AND role = 'member'`, [project.id])
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Sharing could not be stopped' })
  } finally {
    client.release()
  }
})

module.exports = router
