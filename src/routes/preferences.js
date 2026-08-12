const express = require('express')
const crypto = require('crypto')
const db = require('../db')
const requireAuth = require('../middleware/requireAuth')

const router = express.Router()
const MAX_PREFERENCES_BYTES = 64 * 1024
const ALLOWED_KEYS = new Set([
  'assistantName',
  'appearanceTheme',
  'planning',
  'priorityEmail',
  'gmailRemoteImageSenders',
  'telegramPreferences',
  'pinnedProjects',
  'projectViews',
])
const APPEARANCE_THEMES = new Set(['soft', 'professional', 'editorial-grid', 'modernist-blocks'])

router.use(requireAuth)

function clock(value, fallback) {
  const text = String(value || '')
  const match = text.match(/^(\d{2}):(\d{2})$/)
  if (!match) return fallback
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours <= 23 && minutes <= 59 ? text : fallback
}

function normalizeContact(contact = {}) {
  const email = String(contact.email || '').trim().toLowerCase()
  const accountEmail = contact.allAccounts === true
    ? '*'
    : String(contact.accountEmail || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !accountEmail) return null
  return {
    id: String(contact.id || `priority-${crypto.createHash('sha256').update(`${accountEmail}:${email}`).digest('hex').slice(0, 24)}`).slice(0, 160),
    name: String(contact.name || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    email,
    accountEmail,
    enabled: contact.enabled !== false,
    addedAt: String(contact.addedAt || '').slice(0, 40),
  }
}

function normalizePinnedProjectPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\.md$/i, '')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) return ''
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) return ''
  return normalized.slice(0, 500)
}

function normalizePinnedProjects(value) {
  const entries = Array.isArray(value?.entries) ? value.entries : []
  const byPath = new Map()
  for (const entry of entries.slice(0, 2000)) {
    const path = normalizePinnedProjectPath(entry?.path)
    if (!path) continue
    const candidate = {
      path,
      pinned: entry?.pinned !== false,
      changedAt: String(entry?.changedAt || '').slice(0, 40),
      deviceId: String(entry?.deviceId || '').slice(0, 128),
    }
    const current = byPath.get(path)
    const candidateTime = Date.parse(candidate.changedAt || '') || 0
    const currentTime = Date.parse(current?.changedAt || '') || 0
    if (!current || candidateTime > currentTime || (candidateTime === currentTime && candidate.deviceId >= current.deviceId)) {
      byPath.set(path, candidate)
    }
  }
  return { entries: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) }
}

function normalizeProjectViews(value) {
  const entries = Array.isArray(value?.entries) ? value.entries : []
  const byPath = new Map()
  for (const entry of entries.slice(0, 500)) {
    const path = normalizePinnedProjectPath(entry?.path)
    if (!path) continue
    const areaFilter = ['open', 'done', 'reference'].includes(entry?.areaFilter) ? entry.areaFilter : 'open'
    const candidate = {
      path,
      areaFilter,
      taskFilters: { open: entry?.taskFilters?.open !== false, done: Boolean(entry?.taskFilters?.done) },
      collapsedKeys: [...new Set((Array.isArray(entry?.collapsedKeys) ? entry.collapsedKeys : [])
        .slice(0, 300).map(key => String(key || '').trim().slice(0, 600)).filter(Boolean))],
      changedAt: String(entry?.changedAt || '').slice(0, 40),
      deviceId: String(entry?.deviceId || '').slice(0, 128),
    }
    const current = byPath.get(path)
    const candidateTime = Date.parse(candidate.changedAt || '') || 0
    const currentTime = Date.parse(current?.changedAt || '') || 0
    if (!current || candidateTime > currentTime || (candidateTime === currentTime && candidate.deviceId >= current.deviceId)) byPath.set(path, candidate)
  }
  return { entries: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) }
}

function normalizeChange(key, value) {
  if (key === 'assistantName') {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'ClarityMode'
  }
  if (key === 'appearanceTheme') {
    return APPEARANCE_THEMES.has(value) ? value : 'professional'
  }
  if (key === 'planning') {
    const rawBuffer = Number(value?.bufferMinutes ?? 15)
    const bufferMinutes = Number.isFinite(rawBuffer) ? Math.max(0, Math.min(60, rawBuffer)) : 15
    const requestedTimeZone = String(value?.timeZone || '').trim().slice(0, 100)
    let timeZone = ''
    if (requestedTimeZone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: requestedTimeZone }).format(new Date())
        timeZone = requestedTimeZone
      } catch {}
    }
    return {
      workdayStart: clock(value?.workdayStart, '09:00'),
      workdayEnd: clock(value?.workdayEnd, '17:00'),
      bufferMinutes,
      timeZone,
    }
  }
  if (key === 'priorityEmail') {
    return {
      includeBody: value?.includeBody !== false,
      contacts: (Array.isArray(value?.contacts) ? value.contacts : [])
        .slice(0, 500)
        .map(normalizeContact)
        .filter(Boolean),
    }
  }
  if (key === 'gmailRemoteImageSenders') {
    const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []
    return Object.fromEntries(entries
      .slice(0, 25)
      .map(([accountEmail, senders]) => [
        String(accountEmail || '').trim().toLowerCase(),
        [...new Set((Array.isArray(senders) ? senders : [])
          .slice(0, 500)
          .map(sender => String(sender || '').trim().toLowerCase())
          .filter(sender => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)))],
      ])
      .filter(([accountEmail]) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountEmail)))
  }
  if (key === 'telegramPreferences') {
    return {
      menuKeyword: String(value?.menuKeyword || 'hey').trim().slice(0, 40),
      keyboardEnabled: Boolean(value?.keyboardEnabled),
      nudgesEnabled: Boolean(value?.nudgesEnabled),
      nudgeTodayEnabled: value?.nudgeTodayEnabled !== false,
      nudgeWinEnabled: value?.nudgeWinEnabled !== false,
      nudgeStreakEnabled: value?.nudgeStreakEnabled !== false,
      nudgeJournalEnabled: value?.nudgeJournalEnabled !== false,
      nudgeTodayTime: clock(value?.nudgeTodayTime, '08:00'),
      nudgeWinTime: clock(value?.nudgeWinTime, '13:00'),
      nudgeStreakTime: clock(value?.nudgeStreakTime, '17:00'),
      nudgeJournalTime: clock(value?.nudgeJournalTime, '20:30'),
      quietHoursStart: clock(value?.quietHoursStart, '21:00'),
      quietHoursEnd: clock(value?.quietHoursEnd, '07:00'),
    }
  }
  if (key === 'pinnedProjects') return normalizePinnedProjects(value)
  if (key === 'projectViews') return normalizeProjectViews(value)
  return undefined
}

function normalizeChanges(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => ALLOWED_KEYS.has(key))
    .map(([key, entry]) => [key, normalizeChange(key, entry)])
    .filter(([, entry]) => entry !== undefined))
}

function validDeviceId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(value)
}

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT revision, preferences, updated_by_device_id, updated_at
         FROM user_preferences
        WHERE user_id = $1`,
      [req.user.sub]
    )
    const row = result.rows[0]
    res.json({
      revision: Number(row?.revision || 0),
      preferences: row?.preferences || {},
      updatedByDeviceId: row?.updated_by_device_id || '',
      updatedAt: row?.updated_at || null,
    })
  } catch {
    res.status(503).json({ error: 'Preferences are temporarily unavailable.' })
  }
})

router.patch('/', async (req, res) => {
  const deviceId = String(req.body?.deviceId || '')
  if (!validDeviceId(deviceId)) return res.status(400).json({ error: 'A valid device ID is required.' })
  const expectedRevision = Number(req.body?.expectedRevision)
  const revisionProtected = Number.isInteger(expectedRevision) && expectedRevision >= 0
  const changes = normalizeChanges(req.body?.changes)
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'No supported preferences were provided.' })
  if (Buffer.byteLength(JSON.stringify(changes), 'utf8') > MAX_PREFERENCES_BYTES) {
    return res.status(413).json({ error: 'Preferences are too large.' })
  }
  try {
    const result = revisionProtected
      ? await db.query(
        `WITH current AS (
           SELECT 1 FROM user_preferences WHERE user_id = $1
         )
         INSERT INTO user_preferences (user_id, revision, preferences, updated_by_device_id, updated_at)
         SELECT $1, 1, $2::jsonb, $3, now()
          WHERE $4::bigint = 0 OR EXISTS (SELECT 1 FROM current)
         ON CONFLICT (user_id) DO UPDATE SET
           revision = user_preferences.revision + 1,
           preferences = user_preferences.preferences || EXCLUDED.preferences,
           updated_by_device_id = EXCLUDED.updated_by_device_id,
           updated_at = now()
         WHERE user_preferences.revision = $4::bigint
         RETURNING revision, preferences, updated_by_device_id, updated_at`,
        [req.user.sub, JSON.stringify(changes), deviceId, expectedRevision]
      )
      : await db.query(
        `INSERT INTO user_preferences (user_id, revision, preferences, updated_by_device_id, updated_at)
         VALUES ($1, 1, $2::jsonb, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET
           revision = user_preferences.revision + 1,
           preferences = user_preferences.preferences || EXCLUDED.preferences,
           updated_by_device_id = EXCLUDED.updated_by_device_id,
           updated_at = now()
         RETURNING revision, preferences, updated_by_device_id, updated_at`,
        [req.user.sub, JSON.stringify(changes), deviceId]
      )
    if (!result.rows[0] && revisionProtected) {
      const current = await db.query(
        `SELECT revision, preferences, updated_by_device_id, updated_at
           FROM user_preferences
          WHERE user_id = $1`,
        [req.user.sub]
      )
      const row = current.rows[0]
      return res.status(409).json({
        error: 'Preferences changed on another device.',
        revision: Number(row?.revision || 0),
        preferences: row?.preferences || {},
        updatedByDeviceId: row?.updated_by_device_id || '',
        updatedAt: row?.updated_at || null,
      })
    }
    const row = result.rows[0]
    res.json({
      revision: Number(row.revision),
      preferences: row.preferences,
      updatedByDeviceId: row.updated_by_device_id,
      updatedAt: row.updated_at,
    })
  } catch {
    res.status(503).json({ error: 'Preferences could not be saved. Try again.' })
  }
})

module.exports = router
module.exports.normalizeChanges = normalizeChanges
