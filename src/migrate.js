require('dotenv').config()
const db = require('./db')
const { runMigrations } = require('./migrations')

async function migrate() {
  await runMigrations(db)
  console.log('Migration complete.')
  process.exit(0)
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
