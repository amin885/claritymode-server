const subscribers = new Map()
let listenerClient = null
let reconnectTimer = null
let stopping = false

function writeEvent(res, event) {
  res.write(`id: ${event.cursor}\n`)
  res.write('event: shared-project-change\n')
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function subscribe(userId, res) {
  const clients = subscribers.get(userId) || new Set()
  clients.add(res)
  subscribers.set(userId, clients)
  return () => {
    clients.delete(res)
    if (!clients.size) subscribers.delete(userId)
  }
}

async function deliver(db, event) {
  const result = await db.query(
    `SELECT user_id
       FROM shared_project_members
      WHERE project_id = $1 AND removed_at IS NULL`,
    [event.projectId]
  )
  for (const row of result.rows) {
    for (const response of subscribers.get(row.user_id) || []) {
      writeEvent(response, event)
    }
  }
}

async function start(db) {
  if (listenerClient || stopping) return
  try {
    const client = await db.connect()
    listenerClient = client
    client.on('notification', message => {
      if (message.channel !== 'claritymode_shared_project_change') return
      try {
        const event = JSON.parse(message.payload || '{}')
        if (event.projectId && Number.isSafeInteger(Number(event.cursor))) {
          deliver(db, { ...event, cursor: Number(event.cursor), revision: Number(event.revision || 0) }).catch(() => {})
        }
      } catch {
        // A malformed notification must not interrupt the durable fallback feed.
      }
    })
    client.on('error', () => {
      if (listenerClient === client) listenerClient = null
      try { client.release() } catch {}
      if (!stopping) reconnectTimer = setTimeout(() => start(db), 2_000)
    })
    await client.query('LISTEN claritymode_shared_project_change')
  } catch {
    listenerClient = null
    if (!stopping) reconnectTimer = setTimeout(() => start(db), 2_000)
  }
}

async function stop() {
  stopping = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  const client = listenerClient
  listenerClient = null
  if (client) {
    try { await client.query('UNLISTEN claritymode_shared_project_change') } catch {}
    try { client.release() } catch {}
  }
}

module.exports = { subscribe, start, stop, writeEvent }
