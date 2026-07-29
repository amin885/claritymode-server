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
  'telegramPreferences',
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
  const changes = normalizeChanges(req.body?.changes)
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'No supported preferences were provided.' })
  if (Buffer.byteLength(JSON.stringify(changes), 'utf8') > MAX_PREFERENCES_BYTES) {
    return res.status(413).json({ error: 'Preferences are too large.' })
  }
  try {
    const result = await db.query(
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
