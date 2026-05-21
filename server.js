require('dotenv').config()
const express = require('express')
const path = require('path')
const authRoutes = require('./src/routes/auth')
const chatRoutes = require('./src/routes/chat')
const updateRoutes = require('./src/routes/updates')
const skillRoutes = require('./src/routes/skills')

const app = express()
app.use(express.json())
app.use('/auth', authRoutes)
app.use('/chat', chatRoutes)
app.use('/updates', updateRoutes)
app.use(skillRoutes)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'src/admin/index.html')))
app.get('/admin/v2', (req, res) => res.sendFile(path.join(__dirname, 'src/admin/v2.html')))

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
    .then(() => db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled_v2_skills TEXT[] NOT NULL DEFAULT '{}'`))
    .then(() => db.query(`
      CREATE TABLE IF NOT EXISTS v2_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `))
    .then(() => db.query('ALTER TABLE v2_skills ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT ' + "''" ))
    .then(() => console.log('Database ready.'))
    .catch(err => console.error('Migration warning:', JSON.stringify(err), err.message, err.code))
    .finally(() => {
      app.listen(PORT, () => console.log(`ClarityMode server running on ${PORT}`))
    })
}

module.exports = app
