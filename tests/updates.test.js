process.env.JWT_SECRET = 'test-secret-for-jest-only'

jest.mock('../src/db')
jest.mock('../src/anthropic')

const request = require('supertest')
const app = require('../server')

const originalToken = process.env.CLARITYMODE_RELEASE_GITHUB_TOKEN
const originalRepo = process.env.CLARITYMODE_RELEASE_REPO
const originalGithubToken = process.env.GITHUB_TOKEN
const originalFetch = global.fetch

function fakeHeaders(values = {}) {
  return {
    get(name) {
      return values[name.toLowerCase()] || null
    },
  }
}

describe('GET /updates/v2/win/:assetName', () => {
  beforeEach(() => {
    delete process.env.CLARITYMODE_RELEASE_GITHUB_TOKEN
    delete process.env.CLARITYMODE_RELEASE_REPO
    delete process.env.GITHUB_TOKEN
    global.fetch = jest.fn()
  })

  afterEach(() => {
    if (originalToken) process.env.CLARITYMODE_RELEASE_GITHUB_TOKEN = originalToken
    else delete process.env.CLARITYMODE_RELEASE_GITHUB_TOKEN

    if (originalRepo) process.env.CLARITYMODE_RELEASE_REPO = originalRepo
    else delete process.env.CLARITYMODE_RELEASE_REPO

    if (originalGithubToken) process.env.GITHUB_TOKEN = originalGithubToken
    else delete process.env.GITHUB_TOKEN

    global.fetch = originalFetch
  })

  it('returns 503 when the private release token is not configured', async () => {
    const res = await request(app).get('/updates/v2/win/latest.yml')

    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/not configured/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects unsupported asset names', async () => {
    process.env.CLARITYMODE_RELEASE_GITHUB_TOKEN = 'test-token'

    const res = await request(app).get('/updates/v2/win/notes.txt')

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unsupported/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('serves latest.yml from the private GitHub release', async () => {
    process.env.CLARITYMODE_RELEASE_GITHUB_TOKEN = 'test-token'
    process.env.CLARITYMODE_RELEASE_REPO = 'owner/private-releases'

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          assets: [
            { name: 'latest.yml', url: 'https://api.github.com/repos/owner/private-releases/releases/assets/1' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: fakeHeaders(),
        body: null,
        arrayBuffer: async () => new TextEncoder().encode('version: 0.10.20\n').buffer,
      })

    const res = await request(app).get('/updates/v2/win/latest.yml')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/yaml/)
    expect(res.text).toContain('version: 0.10.20')
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/owner/private-releases/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer test-token' }),
      })
    )
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/owner/private-releases/releases/assets/1',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'application/octet-stream',
          authorization: 'Bearer test-token',
        }),
      })
    )
  })

  it('returns 404 when the requested asset is not in the latest release', async () => {
    process.env.CLARITYMODE_RELEASE_GITHUB_TOKEN = 'test-token'

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ assets: [] }),
    })

    const res = await request(app).get('/updates/v2/win/latest.yml')

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })
})
