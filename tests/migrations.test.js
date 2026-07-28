const { migrations, runMigrations } = require('../src/migrations')

describe('numbered database migrations', () => {
  test('contains a durable collaboration migration after the legacy schema', () => {
    expect(migrations.map(item => item.version)).toEqual([1, 2])
    expect(migrations[1].statements.join('\n')).toContain('shared_project_operations')
    expect(migrations[1].statements.join('\n')).toContain('shared_project_conflicts')
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
