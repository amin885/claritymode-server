const { migrations, runMigrations } = require('../src/migrations')

describe('numbered database migrations', () => {
  test('contains a durable collaboration migration after the legacy schema', () => {
    expect(migrations.map(item => item.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(migrations[1].statements.join('\n')).toContain('shared_project_operations')
    expect(migrations[1].statements.join('\n')).toContain('shared_project_conflicts')
    expect(migrations[2].statements.join('\n')).toContain('shared_project_events')
    expect(migrations[11].statements.join('\n')).toContain('connector_evidence')
    expect(migrations[12].statements.join('\n')).toContain('one final human review')
    expect(migrations[3].statements.join('\n')).toContain('target_user_id')
    expect(migrations[4].statements.join('\n')).toContain('user_preferences')
    expect(migrations[5].statements.join('\n')).toContain('trusted_device_sessions')
    expect(migrations[6].statements.join('\n')).toContain('claritymode-youtube-script-producer')
    expect(migrations[7].statements.join('\n')).toContain('skill_assignments')
    expect(migrations[7].statements.join('\n')).toContain('skill_connector_credentials')
    expect(migrations[8].statements.join('\n')).toContain('skill_user_profiles')
    expect(migrations[13].statements.join('\n')).toContain('provider_app_id')
    expect(migrations[13].statements.join('\n')).toContain('manifest JSONB')
    expect(migrations[10].statements.join('\n')).toContain('internal_error')
  })

  test('runs unapplied migrations in one transaction and releases the client', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const client = { query, release: jest.fn() }
    query.mockImplementation(async sql => {
      if (String(sql).startsWith('SELECT version')) return { rows: [{ version: 1 }] }
      return { rows: [] }
    })
    await runMigrations({ connect: async () => client })
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(query.mock.calls.some(call => String(call[0]).includes('shared_projects'))).toBe(true)
    expect(query).toHaveBeenLastCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalled()
  })

  test('rolls back a failed migration before releasing the client', async () => {
    const query = jest.fn(async sql => {
      if (String(sql).startsWith('SELECT version')) return { rows: [] }
      if (String(sql).includes('CREATE TABLE IF NOT EXISTS users')) throw new Error('migration failed')
      return { rows: [] }
    })
    const client = { query, release: jest.fn() }
    await expect(runMigrations({ connect: async () => client })).rejects.toThrow('migration failed')
    expect(query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })
})
