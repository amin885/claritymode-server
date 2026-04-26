require('dotenv').config()
const db = require('./db')

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email       TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_approved BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT now()
    )
  `)
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT false`)
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled_packs TEXT[] NOT NULL DEFAULT '{}'`)
  console.log('Migration complete.')
  process.exit(0)
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
