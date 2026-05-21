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
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled_v2_skills TEXT[] NOT NULL DEFAULT '{}'`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS v2_skills (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      version     TEXT NOT NULL DEFAULT '',
      source_url  TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL,
      summary     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    )
  `)
  await db.query(`ALTER TABLE v2_skills ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT ''`)
  console.log('Migration complete.')
  process.exit(0)
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
