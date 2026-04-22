const Anthropic = require('@anthropic-ai/sdk')

const MODEL = 'claude-sonnet-4-6'

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

async function streamToResponse(res, { systemPrompt, messages, tools }) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const stream = await getClient().messages.stream({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] : [],
      tools: tools || [],
      messages,
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        send({ type: 'chunk', text: event.delta.text })
      }
    }

    const final = await stream.finalMessage()

    if (final.stop_reason === 'tool_use') {
      for (const block of final.content) {
        if (block.type === 'tool_use') {
          send({ type: 'tool_use', name: block.name, id: block.id, input: block.input })
        }
      }
    }

    send({ type: 'done', stopReason: final.stop_reason, content: final.content, usage: final.usage })
  } catch (err) {
    send({ type: 'error', message: err.message || 'Anthropic error' })
  } finally {
    res.end()
  }
}

async function summarize(messages) {
  const formatted = messages
    .map(m => {
      const text = typeof m.content === 'string'
        ? m.content.trim()
        : Array.isArray(m.content)
          ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
          : ''
      if (!text) return null
      return `${m.role === 'user' ? 'User' : 'Maude'}: ${text}`
    })
    .filter(Boolean)
    .join('\n')

  if (!formatted) return null

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: `Summarize this ClarityMode conversation in 3–5 sentences. Focus on what was discussed, what was captured, and any key decisions or intentions set. Be concise and use plain language.\n\n${formatted}` }],
  })
  return response.content[0]?.text || null
}

module.exports = { streamToResponse, summarize }
