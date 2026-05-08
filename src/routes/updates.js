const express = require('express')
const path = require('path')
const { Readable } = require('stream')

const router = express.Router()

const DEFAULT_RELEASE_REPO = 'amin885/claritymode-v2-server'
const USER_AGENT = 'ClarityMode-update-bridge'
const ALLOWED_ASSET_NAMES = [
  /^latest\.yml$/i,
  /^latest-mac\.yml$/i,
  /^latest-linux\.yml$/i,
  /^.+\.(exe|dmg|zip|AppImage)$/i,
  /^.+\.(exe|dmg|zip|AppImage)\.blockmap$/i,
]

function getBridgeConfig() {
  const token = process.env.CLARITYMODE_RELEASE_GITHUB_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.CLARITYMODE_RELEASE_REPO || DEFAULT_RELEASE_REPO

  if (!token) {
    const error = new Error('Update bridge is not configured.')
    error.status = 503
    throw error
  }

  return { token, repo }
}

function isAllowedAssetName(assetName) {
  return assetName === path.basename(assetName) && ALLOWED_ASSET_NAMES.some(pattern => pattern.test(assetName))
}

function contentTypeFor(assetName) {
  if (assetName.endsWith('.yml')) return 'text/yaml; charset=utf-8'
  if (assetName.endsWith('.blockmap')) return 'application/octet-stream'
  if (assetName.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  if (assetName.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (assetName.endsWith('.zip')) return 'application/zip'
  return 'application/octet-stream'
}

async function githubFetch(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
      ...(options.headers || {}),
    },
  })
}

async function getLatestRelease(repo, token) {
  const response = await githubFetch(`https://api.github.com/repos/${repo}/releases/latest`, token)

  if (!response.ok) {
    const error = new Error('Could not load the latest v2 release.')
    error.status = response.status === 404 ? 404 : 502
    throw error
  }

  return response.json()
}

function findReleaseAsset(release, assetName) {
  return (release.assets || []).find(asset => asset.name === assetName)
}

async function sendAssetResponse(asset, assetName, token, res) {
  const response = await githubFetch(asset.url, token, {
    headers: { accept: 'application/octet-stream' },
  })

  if (!response.ok) {
    const error = new Error('Could not download the requested update asset.')
    error.status = 502
    throw error
  }

  res.setHeader('content-type', contentTypeFor(assetName))
  res.setHeader('cache-control', assetName.endsWith('.yml') ? 'no-store' : 'private, max-age=3600')

  const contentLength = response.headers.get ? response.headers.get('content-length') : null
  if (contentLength) res.setHeader('content-length', contentLength)

  if (response.body) {
    Readable.fromWeb(response.body).pipe(res)
    return
  }

  const body = await response.arrayBuffer()
  res.end(Buffer.from(body))
}

router.get('/v2/win/:assetName', async (req, res) => {
  const assetName = req.params.assetName

  if (!isAllowedAssetName(assetName)) {
    res.status(400).json({ error: 'Unsupported update asset.' })
    return
  }

  try {
    const { token, repo } = getBridgeConfig()
    const release = await getLatestRelease(repo, token)
    const asset = findReleaseAsset(release, assetName)

    if (!asset) {
      res.status(404).json({ error: 'Update asset not found.' })
      return
    }

    await sendAssetResponse(asset, assetName, token, res)
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error)
      return
    }

    const status = error.status || 500
    res.status(status).json({ error: error.message || 'Update bridge failed.' })
  }
})

module.exports = router
module.exports._private = {
  contentTypeFor,
  isAllowedAssetName,
}
