require('dotenv').config()
const express = require('express')
const path = require('path')
const authRoutes = require('./src/routes/auth')
const chatRoutes = require('./src/routes/chat')

const app = express()
app.use(express.json())
app.use('/auth', authRoutes)
app.use('/chat', chatRoutes)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'src/admin/index.html')))

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
    .then(() => db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled_packs TEXT[] NOT NULL DEFAULT '{}'`))
    .then(() => console.log('Database ready.'))
    .catch(err => console.error('Migration warning:', JSON.stringify(err), err.message, err.code))
    .finally(() => {
      app.listen(PORT, () => console.log(`ClarityMode server running on ${PORT}`))
    })
}

module.exports = app
