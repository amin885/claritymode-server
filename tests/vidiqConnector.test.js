const vidiq = require('../src/vidiqConnector')

describe('VidIQ connected channel discovery', () => {
  test('prefers the connected-channels utility over general channel search', () => {
    const tool = vidiq.connectedChannelsTool([
      { name: 'channel_search', description: 'Search public YouTube channels.' },
      { name: 'list_connected_channels', description: 'List the channels connected to your vidIQ account.' },
      { name: 'vidiq_user_channels', description: 'Get channels authorized by the current user.' },
    ])
    expect(tool.name).toBe('vidiq_user_channels')
  })

  test('recognizes the VidIQ channel-details utility and extracts connected IDs', () => {
    const details = vidiq.channelDetailsTool([
      { name: 'vidiq_channel_search' },
      { name: 'vidiq_get_channels_by_ids' },
    ])
    expect(details.name).toBe('vidiq_get_channels_by_ids')
    expect(vidiq.normalizeChannelIds({ channels: [
      { channelId: 'UC123' },
      { channelId: 'UC456' },
      { channelId: 'UC123' },
    ] })).toEqual(['UC123', 'UC456'])
  })

  test('normalizes channel identities from nested MCP results without duplicates', () => {
    const channels = vidiq.normalizeChannels({
      channels: [
        { channel_id: 'UC123', channel_name: 'ClarityMode Podcast', handle: '@claritymode' },
        { channelId: 'UC123', channelTitle: 'ClarityMode Podcast' },
      ],
    })
    expect(channels).toEqual([
      { id: 'UC123', name: 'ClarityMode Podcast', handle: '@claritymode', url: '' },
    ])
  })

  test('resolves VidIQ user channel IDs into display names during validation', async () => {
    const responses = [
      { body: { jsonrpc: '2.0', id: 1, result: {} }, sessionId: 'session-1' },
      { notification: true },
      { body: { jsonrpc: '2.0', id: 2, result: { tools: [
        { name: 'vidiq_keyword_research' },
        { name: 'vidiq_user_channels', inputSchema: { type: 'object', properties: {} } },
        { name: 'vidiq_get_channels_by_ids', inputSchema: { type: 'object', properties: { channelIds: { type: 'array' } }, required: ['channelIds'] } },
      ] } } },
      { body: { jsonrpc: '2.0', id: 3, result: { structuredContent: { channels: [{ channelId: 'UC123' }] }, content: [
        { type: 'text', text: JSON.stringify({ channels: [{ channelId: 'UC123' }] }) },
      ] } } },
      { body: { jsonrpc: '2.0', id: 4, result: { structuredContent: { channels: [{ id: 'UC123', title: 'ClarityMode Podcast' }] }, content: [
        { type: 'text', text: JSON.stringify({ channels: [{ id: 'UC123', title: 'ClarityMode Podcast' }] }) },
      ] } } },
    ]
    const calls = []
    const fetchImpl = jest.fn(async (_url, options) => {
      calls.push(JSON.parse(options.body))
      const next = responses.shift()
      if (next.notification) return { ok: true }
      return {
        ok: true,
        headers: { get: name => name.toLowerCase() === 'mcp-session-id' ? (next.sessionId || '') : '' },
        text: async () => JSON.stringify(next.body),
      }
    })

    const result = await vidiq.validate('private-key', fetchImpl)

    expect(result.channels).toEqual([
      { id: 'UC123', name: 'ClarityMode Podcast', handle: '', url: '' },
    ])
    expect(calls.at(-1).params).toEqual({
      name: 'vidiq_get_channels_by_ids',
      arguments: { channelIds: ['UC123'] },
    })
  })
})
