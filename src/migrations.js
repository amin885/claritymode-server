const migrations = [
  {
    version: 1,
    name: 'existing-account-and-skill-schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_approved BOOLEAN NOT NULL DEFAULT false,
        enabled_packs TEXT[] NOT NULL DEFAULT '{}',
        enabled_v2_skills TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now()
      )`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled_packs TEXT[] NOT NULL DEFAULT '{}'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled_v2_skills TEXT[] NOT NULL DEFAULT '{}'`,
      `CREATE TABLE IF NOT EXISTS v2_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        data_source TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )`,
      `ALTER TABLE v2_skills ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 2,
    name: 'shared-project-foundation',
    statements: [
      `CREATE TABLE IF NOT EXISTS shared_projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id UUID NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        minimum_app_version TEXT NOT NULL DEFAULT '0.10.221',
        revision BIGINT NOT NULL DEFAULT 0,
        snapshot JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'deleted')),
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS shared_project_members (
        project_id UUID NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        removed_at TIMESTAMPTZ,
        PRIMARY KEY (project_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS shared_project_invitations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
        inviter_user_id UUID NOT NULL REFERENCES users(id),
        invited_email TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
        expires_at TIMESTAMPTZ NOT NULL,
        accepted_by_user_id UUID REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        accepted_at TIMESTAMPTZ
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS shared_project_pending_invite
        ON shared_project_invitations (project_id, lower(invited_email))
        WHERE status = 'pending'`,
      `CREATE TABLE IF NOT EXISTS shared_project_operations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL,
        actor_user_id UUID NOT NULL REFERENCES users(id),
        device_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        base_revision BIGINT NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (project_id, revision),
        UNIQUE (project_id, device_id, operation_id)
      )`,
      `CREATE INDEX IF NOT EXISTS shared_project_operations_since
        ON shared_project_operations (project_id, revision)`,
      `CREATE TABLE IF NOT EXISTS shared_project_snapshots (
        project_id UUID NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL,
        snapshot JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, revision)
      )`,
      `CREATE TABLE IF NOT EXISTS shared_project_conflicts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
        operation_id UUID REFERENCES shared_project_operations(id),
        element_id TEXT NOT NULL,
        server_value JSONB,
        incoming_value JSONB,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        resolved_by_user_id UUID REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS shared_markdown_deliverables (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
        stable_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0,
        deleted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (project_id, stable_id),
        UNIQUE (project_id, relative_path)
      )`,
    ],
  },
  {
    version: 3,
    name: 'shared-project-change-feed',
    statements: [
      `CREATE TABLE IF NOT EXISTS shared_project_events (
        cursor BIGSERIAL PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL,
        kind TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS shared_project_events_project_cursor
        ON shared_project_events (project_id, cursor)`,
    ],
  },
  {
    version: 4,
    name: 'shared-project-targeted-events',
    statements: [
      `ALTER TABLE shared_project_events
        ADD COLUMN IF NOT EXISTS target_user_id UUID REFERENCES users(id)`,
      `CREATE INDEX IF NOT EXISTS shared_project_events_target_cursor
        ON shared_project_events (target_user_id, cursor)
        WHERE target_user_id IS NOT NULL`,
    ],
  },
  {
    version: 5,
    name: 'account-preferences',
    statements: [
      `CREATE TABLE IF NOT EXISTS user_preferences (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL DEFAULT 0,
        preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by_device_id TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
  },
]

async function runMigrations(db) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    const appliedResult = await client.query('SELECT version FROM schema_migrations')
    const applied = new Set(appliedResult.rows.map(row => Number(row.version)))
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      for (const statement of migration.statements) await client.query(statement)
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

module.exports = { migrations, runMigrations }
