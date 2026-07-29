process.env.JWT_SECRET = 'test-secret-for-jest-only'
jest.mock('../src/db')

const jwt = require('jsonwebtoken')
const request = require('supertest')
const db = require('../src/db')
const app = require('../server')
const { normalizeChanges } = require('../src/routes/preferences')

function token(userId = 'user-1', email = 'owner@example.com') {
  return jwt.sign({ sub: userId, email }, process.env.JWT_SECRET)
}

function authenticate(userId = 'user-1', email = 'owner@example.com') {
  db.query.mockResolvedValueOnce({ rows: [{ id: userId, email, is_approved: true }] })
}

beforeEach(() => jest.clearAllMocks())

test('account preferences require authentication', async () => {
  expect((await request(app).get('/v2/preferences')).status).toBe(401)
  expect((await request(app).patch('/v2/preferences').send({})).status).toBe(401)
})

test('returns only the authenticated user preference document', async () => {
  authenticate()
  db.query.mockResolvedValueOnce({
    rows: [{ revision: '3', preferences: { assistantName: 'Mae' }, updated_by_device_id: 'device-one', updated_at: new Date() }],
  })
  const response = await request(app).get('/v2/preferences').set('Authorization', `Bearer ${token()}`)
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ revision: 3, preferences: { assistantName: 'Mae' } })
  expect(db.query.mock.calls[1][1]).toEqual(['user-1'])
})

test('merges a whitelisted patch without accepting credentials or paths', async () => {
  authenticate()
  db.query.mockResolvedValueOnce({
    rows: [{
      revision: '4',
      preferences: { assistantName: 'Mae', appearanceTheme: 'soft' },
      updated_by_device_id: 'device-desktop',
      updated_at: new Date(),
    }],
  })
  const response = await request(app)
    .patch('/v2/preferences')
    .set('Authorization', `Bearer ${token()}`)
    .send({
      deviceId: 'device-desktop',
      changes: {
        assistantName: ' Mae ',
        appearanceTheme: 'soft',
        gmailTokens: { refresh_token: 'secret' },
        telegramBotToken: 'secret',
        vaultPath: 'C:\\Private',
      },
    })
  expect(response.status).toBe(200)
  const written = JSON.parse(db.query.mock.calls[1][1][1])
  expect(written).toEqual({ assistantName: 'Mae', appearanceTheme: 'soft' })
  expect(db.query.mock.calls[1][0]).toContain('preferences = user_preferences.preferences || EXCLUDED.preferences')
})

test('normalizes portable settings and excludes device credentials', () => {
  expect(normalizeChanges({
    planning: { workdayStart: '08:30', workdayEnd: '18:00', bufferMinutes: 90, timeZone: 'America/Edmonton' },
    priorityEmail: {
      enabled: true,
      contacts: [{ email: 'CLIENT@EXAMPLE.COM', accountEmail: '*', enabled: true }],
    },
    telegramPreferences: { quietHoursStart: '22:00', quietHoursEnd: '06:30' },
    authToken: 'secret',
  })).toEqual(expect.objectContaining({
    planning: expect.objectContaining({ workdayStart: '08:30', bufferMinutes: 60 }),
    priorityEmail: expect.objectContaining({
      contacts: [expect.objectContaining({ email: 'client@example.com', accountEmail: '*' })],
    }),
    telegramPreferences: expect.objectContaining({ quietHoursStart: '22:00', quietHoursEnd: '06:30' }),
  }))
})
