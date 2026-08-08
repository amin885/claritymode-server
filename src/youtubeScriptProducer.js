const DEFAULT_AGENT_ID = ''
const ALLOWED_OPERATIONS = new Set(['generate_candidates', 'evaluate_topics', 'validate_topic'])
const MAX_INPUT_BYTES = 256 * 1024

function configured() {
  return Boolean(
    String(process.env.MINDSTUDIO_API_KEY || '').trim()
    && String(process.env.MINDSTUDIO_YOUTUBE_AGENT_ID || DEFAULT_AGENT_ID).trim()
  )
}

function normalizeInput(input = {}) {
  const operation = String(input.operation || '').trim()
  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw Object.assign(new Error('Unknown YouTube Script Producer operation.'), { status: 400 })
  }

  const normalized = {
    operation,
    businessOffer: String(input.businessOffer || '').trim().slice(0, 12000),
    idealAudience: String(input.idealAudience || '').trim().slice(0, 12000),
    audienceProblems: String(input.audienceProblems || '').trim().slice(0, 12000),
    excludedAudiences: String(input.excludedAudiences || '').trim().slice(0, 8000),
    channelName: String(input.channelName || '').trim().slice(0, 300),
    channelContext: String(input.channelContext || '').trim().slice(0, 16000),
    seedIdea: String(input.seedIdea || '').trim().slice(0, 2000),
    vidiqEvidence: Array.isArray(input.vidiqEvidence) ? input.vidiqEvidence.slice(0, 100) : [],
  }

  if (!normalized.businessOffer || !normalized.idealAudience || !normalized.audienceProblems || !normalized.channelName) {
    throw Object.assign(new Error('Channel and audience context are required.'), { status: 400 })
  }
  if (operation === 'validate_topic' && !normalized.seedIdea) {
    throw Object.assign(new Error('A seed idea is required for validation.'), { status: 400 })
  }
  if (['evaluate_topics', 'validate_topic'].includes(operation) && !normalized.vidiqEvidence.length) {
    throw Object.assign(new Error('VidIQ evidence is required for this operation.'), { status: 400 })
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_INPUT_BYTES) {
    throw Object.assign(new Error('YouTube research input is too large.'), { status: 413 })
  }
  return normalized
}

function parseResult(value) {
  if (value && typeof value === 'object') return value
  const text = String(value || '').trim()
  if (!text) throw new Error('MindStudio returned an empty result.')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('MindStudio returned an invalid result.')
  }
}

async function run(input, deps = {}) {
  const variables = normalizeInput(input)
  const apiKey = String(process.env.MINDSTUDIO_API_KEY || '').trim()
  const appId = String(process.env.MINDSTUDIO_YOUTUBE_AGENT_ID || DEFAULT_AGENT_ID).trim()
  if (!apiKey || !appId) {
    throw Object.assign(new Error('YouTube Script Producer is not configured on the ClarityMode service.'), { status: 503 })
  }

  const loadSdk = deps.loadSdk || (() => import('@mindstudio-ai/agent'))
  const sdk = await loadSdk()
  const MindStudioAgent = deps.MindStudioAgent || sdk.MindStudioAgent
  const client = new MindStudioAgent({ apiKey })
  const response = await client.runAgent({
    appId,
    workflow: 'Main.flow',
    variables: {
      ...variables,
      vidiqEvidence: variables.vidiqEvidence.length ? JSON.stringify(variables.vidiqEvidence) : '',
    },
    ...(String(process.env.MINDSTUDIO_YOUTUBE_AGENT_VERSION || '').trim()
      ? { version: String(process.env.MINDSTUDIO_YOUTUBE_AGENT_VERSION).trim() }
      : {}),
  })
  const result = parseResult(response?.result)
  if (result.operation && result.operation !== variables.operation) {
    throw new Error('MindStudio returned a result for the wrong operation.')
  }
  return {
    result,
    threadId: String(response?.threadId || ''),
    billingCost: response?.billingCost == null ? undefined : String(response.billingCost),
  }
}

module.exports = {
  ALLOWED_OPERATIONS,
  configured,
  normalizeInput,
  parseResult,
  run,
}
