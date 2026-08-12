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
  {
    version: 6,
    name: 'trusted-device-sessions',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0`,
      `CREATE TABLE IF NOT EXISTS trusted_device_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        device_name TEXT NOT NULL DEFAULT '',
        expires_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS trusted_device_sessions_user
        ON trusted_device_sessions (user_id, expires_at)
        WHERE revoked_at IS NULL`,
    ],
  },
  {
    version: 7,
    name: 'youtube-script-producer-product-skill',
    statements: [
      `INSERT INTO v2_skills (
        id,
        name,
        description,
        version,
        source_url,
        data_source,
        content,
        summary,
        status,
        updated_at
      ) VALUES (
        'claritymode-youtube-script-producer',
        'YouTube Script Producer',
        'Turn an approved video idea into a researched, human-reviewed YouTube script inside a project.',
        '0.1.0',
        '',
        'youtube-script-producer',
        $skill$# YouTube Script Producer

This is a contained ClarityMode product skill. It is started from a project and is not an Ask skill.

ClarityMode owns the workflow and human approval steps. The user connects their own vidIQ account for read-only YouTube evidence. MindStudio remains a hidden ClarityMode-managed execution service.
$skill$,
        'A contained project workflow for topic validation and YouTube script production. Access is assigned per ClarityMode account; users can turn it on or off locally.',
        'active',
        now()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        version = EXCLUDED.version,
        data_source = EXCLUDED.data_source,
        content = EXCLUDED.content,
        summary = EXCLUDED.summary,
        status = 'active',
        updated_at = now()`,
    ],
  },
  {
    version: 8,
    name: 'durable-skill-assignments',
    statements: [
      `CREATE TABLE IF NOT EXISTS skill_connector_credentials (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, connector_id)
      )`,
      `CREATE TABLE IF NOT EXISTS skill_assignments (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES v2_skills(id),
        skill_version TEXT NOT NULL DEFAULT '1.0.0',
        client_request_id TEXT NOT NULL,
        project_ref JSONB NOT NULL,
        source_task JSONB NOT NULL,
        brief JSONB NOT NULL,
        project_context JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
          'queued', 'working', 'needs_approval', 'needs_input',
          'ready_for_review', 'accepted', 'failed', 'cancelled'
        )),
        stage TEXT NOT NULL DEFAULT 'queued',
        progress_label TEXT NOT NULL DEFAULT 'Preparing this assignment...',
        workflow_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        connector_request JSONB,
        approval JSONB,
        question JSONB,
        artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
        public_error JSONB,
        pending_response JSONB,
        provider_thread_id TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        run_started_at TIMESTAMPTZ,
        accepted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, client_request_id)
      )`,
      `CREATE INDEX IF NOT EXISTS skill_assignments_user_updated
        ON skill_assignments (user_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS skill_assignments_worker_queue
        ON skill_assignments (status, updated_at)
        WHERE status IN ('queued', 'working')`,
    ],
  },
  {
    version: 9,
    name: 'skill-user-profiles',
    statements: [
      `CREATE TABLE IF NOT EXISTS skill_user_profiles (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES v2_skills(id) ON DELETE CASCADE,
        profile JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, skill_id)
      )`,
    ],
  },
  {
    version: 10,
    name: 'youtube-outline-builder-product-skill',
    statements: [
      `UPDATE v2_skills
          SET name = 'YouTube Outline Builder',
              description = 'Turn a rough video idea into three hooks and a detailed, research-backed outline through a human-reviewed project workflow.',
              version = '0.2.0',
              content = $skill$# YouTube Outline Builder

This contained ClarityMode product skill interviews the creator one question at a time, pauses for angle and scope approval, then returns three hook options and a detailed Markdown outline for final review.

ClarityMode owns the assignment envelope and human approval gates. The user connects their own VidIQ account for read-only YouTube evidence. The execution provider remains hidden and replaceable.
$skill$,
              summary = 'A contained 10-80-10 project workflow for creator interview, scoped research, and detailed YouTube outline production.',
              updated_at = now()
        WHERE id = 'claritymode-youtube-script-producer'`,
    ],
  },
  {
    version: 11,
    name: 'skill-assignment-private-diagnostics',
    statements: [
      `ALTER TABLE skill_assignments
        ADD COLUMN IF NOT EXISTS internal_error JSONB`,
    ],
  },
  {
    version: 12,
    name: 'skill-assignment-connector-evidence',
    statements: [
      `ALTER TABLE skill_assignments
        ADD COLUMN IF NOT EXISTS connector_evidence JSONB NOT NULL DEFAULT '{}'::jsonb`,
    ],
  },
  {
    version: 13,
    name: 'youtube-outline-single-review-gate',
    statements: [
      `UPDATE v2_skills
          SET description = 'Turn a rough video idea into an outlier-informed, research-backed YouTube outline with one final human review.',
              version = '0.3.0',
              content = $skill$# YouTube Outline Builder

This contained ClarityMode product skill checks VidIQ opportunity evidence, asks a short creator interview, then produces three hooks and a detailed Markdown outline for final review.

ClarityMode owns the assignment envelope and final review. The user connects their own VidIQ account for read-only YouTube evidence. The execution provider remains hidden and replaceable.
$skill$,
              summary = 'A contained project workflow for VidIQ opportunity validation, a brief creator interview, and an outlier-informed YouTube outline.',
              updated_at = now()
        WHERE id = 'claritymode-youtube-script-producer'`,
      `UPDATE skill_assignments
          SET status = 'queued',
              pending_response = jsonb_build_object('approved', true, 'direction', COALESCE(approval->'data', approval, '{}'::jsonb)),
              approval = NULL,
              progress_label = 'ClarityMode is building the outline...',
              updated_at = now()
        WHERE skill_id = 'claritymode-youtube-script-producer'
          AND status = 'needs_approval'`,
    ],
  },
  {
    version: 14,
    name: 'generic-skill-contract-v1',
    statements: [
      `ALTER TABLE v2_skills ADD COLUMN IF NOT EXISTS contract_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE v2_skills ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE v2_skills ADD COLUMN IF NOT EXISTS provider_app_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE v2_skills ADD COLUMN IF NOT EXISTS provider_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE v2_skills ADD COLUMN IF NOT EXISTS manifest JSONB NOT NULL DEFAULT '{}'::jsonb`,
      `CREATE INDEX IF NOT EXISTS v2_skills_provider_app
        ON v2_skills (provider, provider_app_id)
        WHERE status = 'active' AND provider_app_id <> ''`,
    ],
  },
  {
    version: 15,
    name: 'promote-mastra-skill-framework',
    statements: [
      `UPDATE v2_skills
          SET name = 'YouTube Outline Builder',
              description = 'Turn a seed idea and your point of view into an outlier-informed YouTube outline.',
              version = '1.0.0',
              contract_version = '1',
              provider = 'mastra',
              provider_app_id = 'claritymode-youtube-script-producer',
              provider_version = '1.0.0',
              manifest = $manifest${JSON.stringify({
                contractVersion: '1',
                skillId: 'claritymode-youtube-script-producer',
                skillVersion: '1.0.0',
                name: 'YouTube Outline Builder',
                description: 'Turn a seed idea and your point of view into an outlier-informed YouTube outline.',
                inputs: [
                  { id: 'seedIdea', type: 'text', label: 'Video idea', required: true, description: 'The main idea or working title.' },
                  { id: 'brainDump', type: 'long_text', label: 'What is already in your head?', required: false, description: 'Opinions, experience, stories, examples, or lessons.' },
                  { id: 'callToAction', type: 'long_text', label: 'Call to action', required: true, description: 'What should the viewer do next?' },
                ],
                outputs: [{ id: 'outline', type: 'markdown', label: 'YouTube outline', required: true }],
                connectors: [{ connector: 'vidiq', operations: ['research_topics'] }],
                completion: { requiresAcceptance: true, completeSourceTaskOnAcceptance: false, completeWorkAreaOnAcceptance: false },
              })}$manifest$::jsonb,
              content = '# YouTube Outline Builder\n\nA reusable ClarityMode Skill executed by the managed Mastra runner. ClarityMode owns tasks, project context, user approvals, deliverables, and the user-owned VidIQ connection.',
              summary = 'A reusable project workflow for VidIQ opportunity research and a reviewable YouTube outline.',
              status = 'active',
              updated_at = now()
        WHERE id = 'claritymode-youtube-script-producer'`,
      `UPDATE v2_skills
          SET status = 'archived', updated_at = now()
        WHERE id = 'claritymode-youtube-outline-mastra-test'`,
      `UPDATE users
          SET enabled_v2_skills = array_remove(enabled_v2_skills, 'claritymode-youtube-outline-mastra-test')
        WHERE 'claritymode-youtube-outline-mastra-test' = ANY(enabled_v2_skills)`,
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
