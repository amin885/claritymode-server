const vidiq = require('../src/vidiqConnector')

describe('VidIQ connected channel discovery', () => {
  test('respects boolean schema fields whose names contain query-like words', () => {
    const args = vidiq.argumentsFor({
      name: 'vidiq_outliers',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          requireAllTitleTerms: { type: 'boolean' },
          minOutlierScore: { type: 'number' },
        },
        required: ['query', 'requireAllTitleTerms'],
      },
    }, 'productivity tools')

    expect(args).toEqual({
      query: 'productivity tools',
      requireAllTitleTerms: false,
      minOutlierScore: 2,
    })
  })

  test('prefers VidIQ outlier research over generic video search', () => {
    const tool = vidiq.outliersTool([
      { name: 'youtube_search', description: 'Search YouTube videos.' },
      { name: 'find_breakout_videos', description: 'Find overperforming videos.' },
      { name: 'vidiq_outliers', description: 'Return VidIQ outlier scores.' },
    ])
    expect(tool.name).toBe('vidiq_outliers')
  })

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
        { name: 'vidiq_outliers' },
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

  test('combines bounded outlier and keyword evidence for each topic query', async () => {
    const responses = [
      { body: { jsonrpc: '2.0', id: 1, result: {} }, sessionId: 'session-1' },
      { notification: true },
      { body: { jsonrpc: '2.0', id: 2, result: { tools: [
        { name: 'vidiq_outliers', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', maximum: 20 } }, required: ['query'] } },
        { name: 'vidiq_keyword_research', inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } },
      ] } } },
      { body: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify({ videos: [{ title: 'Breakout', outlierScore: 8.4, viewsPerHour: 120 }] }) }] } } },
      { body: { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: JSON.stringify({ volume: 4200, competition: 'low' }) }] } } },
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

    const result = await vidiq.research('private-key', ['decision fatigue'], fetchImpl)

    expect(result).toEqual([{
      query: 'decision fatigue',
      tools: { outliers: 'vidiq_outliers', keyword: 'vidiq_keyword_research' },
      evidence: {
        outliers: { videos: [{ title: 'Breakout', outlierScore: 8.4, viewsPerHour: 120 }] },
        keyword: { volume: 4200, competition: 'low' },
      },
    }])
    expect(calls.slice(-2).map(call => call.params.name)).toEqual(['vidiq_outliers', 'vidiq_keyword_research'])
  })

  test('executes the complete six-query playlist research plan without silently dropping later directions', async () => {
    const queries = ['one', 'two', 'three', 'four', 'five', 'six', 'seven']
    const responses = [
      { body: { jsonrpc: '2.0', id: 1, result: {} }, sessionId: 'session-1' },
      { notification: true },
      { body: { jsonrpc: '2.0', id: 2, result: { tools: [
        { name: 'vidiq_outliers', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'vidiq_keyword_research', inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } },
      ] } } },
      ...queries.slice(0, 6).flatMap((query, index) => [
        { body: { jsonrpc: '2.0', id: (index * 2) + 3, result: { content: [{ type: 'text', text: JSON.stringify({ videos: [{ id: `video-${index}`, title: query, outlierScore: index + 1 }] }) }] } } },
        { body: { jsonrpc: '2.0', id: (index * 2) + 4, result: { content: [{ type: 'text', text: JSON.stringify({ volume: index + 100 }) }] } } },
      ]),
    ]
    const fetchImpl = jest.fn(async (_url, options) => {
      const next = responses.shift()
      if (next.notification) return { ok: true }
      return {
        ok: true,
        headers: { get: name => name.toLowerCase() === 'mcp-session-id' ? (next.sessionId || '') : '' },
        text: async () => JSON.stringify(next.body),
      }
    })

    const result = await vidiq.research('private-key', queries, fetchImpl)

    expect(result.map(item => item.query)).toEqual(queries.slice(0, 6))
    expect(fetchImpl).toHaveBeenCalledTimes(15)
  })

  test('identifies exhausted VidIQ credits as an actionable connector error', async () => {
    const responses = [
      { body: { jsonrpc: '2.0', id: 1, result: {} }, sessionId: 'session-1' },
      { notification: true },
      { body: { jsonrpc: '2.0', id: 2, result: { tools: [
        { name: 'vidiq_outliers', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'vidiq_keyword_research', inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } },
      ] } } },
      { body: { jsonrpc: '2.0', id: 3, result: { isError: true, content: [
        { type: 'text', text: 'Not enough credits. This tool costs 5 credits. No credits were charged.' },
      ] } } },
    ]
    const fetchImpl = jest.fn(async (_url, options) => {
      const next = responses.shift()
      if (next.notification) return { ok: true }
      return {
        ok: true,
        headers: { get: name => name.toLowerCase() === 'mcp-session-id' ? (next.sessionId || '') : '' },
        text: async () => JSON.stringify(next.body),
      }
    })

    await expect(vidiq.research('private-key', ['energy management'], fetchImpl)).rejects.toMatchObject({
      code: 'VIDIQ_CREDITS_EXHAUSTED',
      status: 402,
    })
  })
})
