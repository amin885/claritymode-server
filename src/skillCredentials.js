const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'

function encryptionKey() {
  const raw = String(process.env.CLARITYMODE_CREDENTIAL_KEY || '').trim()
  if (!raw) return null
  return crypto.createHash('sha256').update(raw, 'utf8').digest()
}

function configured() {
  return Boolean(encryptionKey())
}

function encrypt(value) {
  const key = encryptionKey()
  if (!key) throw new Error('Secure connector storage is not configured.')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
}

function decrypt(payload) {
  const key = encryptionKey()
  if (!key) throw new Error('Secure connector storage is not configured.')
  const [version, ivValue, tagValue, encryptedValue] = String(payload || '').split('.')
  if (version !== VERSION || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('Stored connector credentials could not be read.')
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

module.exports = { configured, decrypt, encrypt }
