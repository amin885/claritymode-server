require('dotenv').config()
const express = require('express')
const path = require('path')
const authRoutes = require('./src/routes/auth')
const chatRoutes = require('./src/routes/chat')
const updateRoutes = require('./src/routes/updates')
const skillRoutes = require('./src/routes/skills')
const sharedProjectRoutes = require('./src/routes/sharedProjects')

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use('/auth', authRoutes)
app.use('/chat', chatRoutes)
app.use('/updates', updateRoutes)
app.use(skillRoutes)
app.use('/v2/shared-projects', sharedProjectRoutes)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'src/admin/index.html')))
app.get('/admin/v2', (req, res) => res.sendFile(path.join(__dirname, 'src/admin/v2.html')))

if (require.main === module) {
  const PORT = process.env.PORT || 3000
  const db = require('./src/db')
  const { runMigrations } = require('./src/migrations')
  const sharedProjectEvents = require('./src/sharedProjectEvents')
  const connString = process.env.POSTGRES_URL || process.env.DATABASE_URL
  console.log('DB connection string set:', !!connString, connString?.slice(0, 20))
  runMigrations(db)
    .then(async () => {
      await sharedProjectEvents.start(db)
      console.log('Database ready.')
    })
    .catch(err => console.error('Migration warning:', JSON.stringify(err), err.message, err.code))
    .finally(() => {
      app.listen(PORT, () => console.log(`ClarityMode server running on ${PORT}`))
    })
}

module.exports = app
