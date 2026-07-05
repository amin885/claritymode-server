const { authenticateToken } = require('../auth')

async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' })
  }
  try {
    req.user = await authenticateToken(header.slice(7))
    next()
  } catch (err) {
    const status = err.status || 500
    const error = status === 403
      ? 'Account not authorized'
      : status === 401
        ? 'Invalid or expired token'
        : 'Authentication check failed'
    res.status(status).json({ error })
  }
}

module.exports = requireAuth
