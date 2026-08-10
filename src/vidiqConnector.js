const VIDIQ_MCP_URL = 'https://mcp.vidiq.com/mcp'

function parseSse(text) {
  const payloads = String(text || '')
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(value => value && value !== '[DONE]')
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(payloads[index]) } catch {}
  }
  throw new Error('VidIQ returned an unreadable response.')
}

async function readResponse(response) {
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = parseSse(text) }
  if (!response.ok || body?.error) {
    throw new Error(String(body?.error?.message || body?.error || `VidIQ connection failed (${response.status}).`))
  }
  return body
}

async function rpc({ apiKey, method, params, sessionId = '', fetchImpl = fetch, id = 1 }) {
  const response = await fetchImpl(VIDIQ_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
  })
  return { body: await readResponse(response), sessionId: response.headers?.get?.('mcp-session-id') || sessionId }
}

async function openSession(apiKey, fetchImpl = fetch) {
  const initialized = await rpc({
    apiKey,
    fetchImpl,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ClarityMode', version: '1.0.0' } },
  })
  const notification = await fetchImpl(VIDIQ_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(initialized.sessionId ? { 'Mcp-Session-Id': initialized.sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  if (!notification.ok) throw new Error(`VidIQ connection failed (${notification.status}).`)
  const listed = await rpc({ apiKey, fetchImpl, method: 'tools/list', params: {}, sessionId: initialized.sessionId, id: 2 })
  return {
    sessionId: initialized.sessionId,
    tools: Array.isArray(listed.body?.result?.tools) ? listed.body.result.tools : [],
  }
}

function keywordTool(tools) {
  return [...tools]
    .map(tool => ({
      tool,
      score: /keyword.research|research.keyword/i.test(tool?.name || '') ? 3
        : /keyword/i.test(tool?.name || '') ? 2
          : /topic|research/i.test(tool?.name || '') ? 1 : 0,
    }))
    .filter(item => item.score)
    .sort((left, right) => right.score - left.score)[0]?.tool
}

function connectedChannelsTool(tools) {
  return [...tools]
    .map(tool => {
      const name = String(tool?.name || '')
      const description = String(tool?.description || '')
      const text = `${name} ${description}`
      const score = /connected[_ -]?channels/i.test(text) ? 4
        : /list.*(?:my|your).*channels|(?:my|your).*channels/i.test(text) ? 3
          : /channel.*(?:account|connection)|(?:account|connection).*channel/i.test(text) ? 2 : 0
      return { tool, score }
    })
    .filter(item => item.score)
    .sort((left, right) => right.score - left.score)[0]?.tool
}

function schemaValue(definition, stringValue, numberValue) {
  const types = Array.isArray(definition?.type) ? definition.type : [definition?.type]
  const values = Array.isArray(definition?.enum) ? definition.enum : []
  if (types.includes('string')) {
    return values.find(value => typeof value === 'string' && value.toLowerCase() === stringValue.toLowerCase())
      || values.find(value => typeof value === 'string')
      || stringValue
  }
  if (types.includes('number') || types.includes('integer')) {
    return values.find(value => typeof value === 'number') ?? numberValue
  }
  return stringValue
}

function argumentsFor(tool, query) {
  const properties = tool?.inputSchema?.properties || {}
  const required = new Set(Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [])
  const args = {}
  for (const [name, definition = {}] of Object.entries(properties)) {
    const normalized = name.toLowerCase()
    if (/keyword|query|topic|search|term|phrase/.test(normalized)) args[name] = definition.type === 'array' ? [query] : query
    else if (/language|locale/.test(normalized)) args[name] = schemaValue(definition, 'en', 0)
    else if (/country|region|location/.test(normalized)) args[name] = schemaValue(definition, 'CA', 0)
    else if (/limit|(?:^|[_-])count(?:$|[_-])|maximum|maxresults|max_results/.test(normalized)) {
      const limit = Math.min(10, Number(definition.maximum) || 10)
      args[name] = schemaValue(definition, String(limit), limit)
    } else if (required.has(name) && definition.default !== undefined) args[name] = definition.default
    else if (required.has(name) && Array.isArray(definition.enum) && definition.enum.length) args[name] = definition.enum[0]
  }
  const missing = [...required].filter(name => args[name] === undefined)
  if (missing.length) throw new Error(`VidIQ requires unsupported input: ${missing.join(', ')}.`)
  return args
}

function contentValue(result) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter(item => item?.type === 'text')
    .map(item => item.text)
    .join('\n')
    .trim()
  if (!text) return result
  try { return JSON.parse(text) } catch { return text }
}

function normalizeChannels(value) {
  const found = []
  const visit = current => {
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (!current || typeof current !== 'object') return
    const name = String(
      current.channelName || current.channel_name || current.channelTitle || current.channel_title
      || current.displayName || current.display_name || current.title || current.name || '',
    ).trim()
    const id = String(current.channelId || current.channel_id || current.youtubeChannelId || current.youtube_channel_id || current.id || '').trim()
    const handle = String(current.handle || current.channelHandle || current.channel_handle || '').trim()
    const url = String(current.url || current.channelUrl || current.channel_url || '').trim()
    if (name && (id || handle || url || /channel/i.test(String(current.type || current.kind || '')))) {
      found.push({ id, name: name.slice(0, 160), handle: handle.slice(0, 160), url: url.slice(0, 500) })
    }
    Object.values(current).forEach(visit)
  }
  visit(value)
  const unique = new Map()
  for (const channel of found) {
    const key = channel.id || channel.handle.toLowerCase() || channel.url.toLowerCase() || channel.name.toLowerCase()
    if (!unique.has(key)) unique.set(key, channel)
  }
  return [...unique.values()]
}

async function readConnectedChannels(apiKey, session, fetchImpl = fetch) {
  const tool = connectedChannelsTool(session.tools)
  if (!tool) return null
  const required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : []
  const properties = tool?.inputSchema?.properties || {}
  const args = {}
  for (const name of required) {
    const definition = properties[name] || {}
    if (definition.default !== undefined) args[name] = definition.default
    else if (Array.isArray(definition.enum) && definition.enum.length) args[name] = definition.enum[0]
    else return null
  }
  const response = await rpc({
    apiKey,
    fetchImpl,
    sessionId: session.sessionId,
    id: 3,
    method: 'tools/call',
    params: { name: tool.name, arguments: args },
  })
  if (response.body?.result?.isError) return null
  return normalizeChannels(contentValue(response.body?.result))
}

async function validate(apiKey, fetchImpl = fetch) {
  const session = await openSession(String(apiKey || '').trim(), fetchImpl)
  if (!keywordTool(session.tools)) throw new Error('VidIQ did not provide keyword research for this account.')
  const channels = await readConnectedChannels(String(apiKey || '').trim(), session, fetchImpl)
  return {
    connected: true,
    toolCount: session.tools.length,
    channels: Array.isArray(channels) ? channels : [],
    ...(Array.isArray(channels) ? { channelsCheckedAt: new Date().toISOString() } : {}),
  }
}

async function research(apiKey, queries, fetchImpl = fetch) {
  const cleanQueries = [...new Set((Array.isArray(queries) ? queries : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 20)
  if (!cleanQueries.length) throw new Error('No VidIQ research queries were provided.')
  const session = await openSession(apiKey, fetchImpl)
  const tool = keywordTool(session.tools)
  if (!tool) throw new Error('VidIQ did not provide keyword research for this account.')
  const results = []
  for (let index = 0; index < cleanQueries.length; index += 1) {
    const query = cleanQueries[index]
    const response = await rpc({
      apiKey,
      fetchImpl,
      sessionId: session.sessionId,
      id: index + 3,
      method: 'tools/call',
      params: { name: tool.name, arguments: argumentsFor(tool, query) },
    })
    if (response.body?.result?.isError) throw new Error(String(contentValue(response.body.result) || 'VidIQ research failed.'))
    results.push({ query, tool: tool.name, evidence: contentValue(response.body?.result) })
  }
  return results
}

module.exports = { argumentsFor, connectedChannelsTool, normalizeChannels, parseSse, research, validate }
