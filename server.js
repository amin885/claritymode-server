require('dotenv').config()
const express = require('express')
const authRoutes = require('./src/routes/auth')
const chatRoutes = require('./src/routes/chat')

const app = express()
app.use(express.json())
app.get('/debug-env', (req, res) => {
  res.json({
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    HAS_POSTGRES_URL: !!process.env.POSTGRES_URL,
    HAS_DATABASE_URL: !!process.env.DATABASE_URL,
    ALL_KEYS: Object.keys(process.env).sort(),
  })
})
app.use('/auth', authRoutes)
app.use('/chat', chatRoutes)

if (require.main === module) {
  const PORT = process.env.PORT || 3000
  const db = require('./src/db')
  const connString = process.env.POSTGRES_URL || process.env.DATABASE_URL
  console.log('DB connection string set:', !!connString, connString?.slice(0, 20))
  db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_approved BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `)
    .then(() => db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT false`))
    .then(() => console.log('Database ready.'))
    .catch(err => console.error('Migration warning:', JSON.stringify(err), err.message, err.code))
    .finally(() => {
      app.listen(PORT, () => console.log(`ClarityMode server running on ${PORT}`))
    })
}

module.exports = app
