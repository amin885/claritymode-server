require('dotenv').config()
const express = require('express')
const authRoutes = require('./src/routes/auth')
const chatRoutes = require('./src/routes/chat')

const app = express()
app.use(express.json())
app.use('/auth', authRoutes)
app.use('/chat', chatRoutes)

if (require.main === module) {
  const PORT = process.env.PORT || 3000
  const db = require('./src/db')
  console.log('DATABASE_URL set:', !!process.env.DATABASE_URL, process.env.DATABASE_URL?.slice(0, 20))
  db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `)
    .then(() => console.log('Database ready.'))
    .catch(err => console.error('Migration warning:', JSON.stringify(err), err.message, err.code))
    .finally(() => {
      app.listen(PORT, () => console.log(`ClarityMode server running on ${PORT}`))
    })
}

module.exports = app
