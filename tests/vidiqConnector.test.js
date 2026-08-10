const vidiq = require('../src/vidiqConnector')

describe('VidIQ connected channel discovery', () => {
  test('prefers the connected-channels utility over general channel search', () => {
    const tool = vidiq.connectedChannelsTool([
      { name: 'channel_search', description: 'Search public YouTube channels.' },
      { name: 'list_connected_channels', description: 'List the channels connected to your vidIQ account.' },
    ])
    expect(tool.name).toBe('list_connected_channels')
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
})
