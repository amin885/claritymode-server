const CONTRACT_VERSION = '1'
const MAX_FIELDS = 40
const MAX_OPTIONS = 100
const INPUT_TYPES = new Set(['text', 'long_text', 'number', 'date', 'select', 'checkbox'])
const OUTPUT_TYPES = new Set(['markdown', 'plain_text', 'structured_list', 'file_link'])
const RESPONSE_STATUSES = new Set(['working', 'needs_input', 'needs_connector', 'ready_for_review', 'completed', 'failed', 'cancelled'])
const MAX_ARTIFACTS = 40
const MAX_ARTIFACT_TEXT = 500_000
const WORK_PLAN_OWNERS = new Set(['claritymode', 'user'])

function contractError(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function text(value, maximum = 200) {
  return String(value || '').trim().slice(0, maximum)
}

function identifier(value, label) {
  const normalized = text(value, 100)
  if (!/^[a-z][a-z0-9_-]*$/i.test(normalized)) throw contractError(`${label} must use letters, numbers, dashes, or underscores.`)
  return normalized
}

function normalizeField(field, index, kind) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) throw contractError(`${kind} field ${index + 1} is invalid.`)
  const allowed = kind === 'Input' ? INPUT_TYPES : OUTPUT_TYPES
  const type = text(field.type, 40)
  if (!allowed.has(type)) throw contractError(`${kind} field ${index + 1} has an unsupported type.`)
  const normalized = {
    id: identifier(field.id, `${kind} field id`),
    type,
    label: text(field.label || field.id, 160),
    required: Boolean(field.required),
  }
  if (!normalized.label) throw contractError(`${kind} field ${index + 1} needs a label.`)
  const description = text(field.description, 500)
  if (description) normalized.description = description
  if (kind === 'Input' && type === 'select') {
    const options = Array.isArray(field.options) ? field.options : []
    if (!options.length || options.length > MAX_OPTIONS) throw contractError(`Select field ${normalized.id} needs between 1 and ${MAX_OPTIONS} options.`)
    normalized.options = options.map((option, optionIndex) => {
      const source = typeof option === 'string' ? { value: option, label: option } : option
      if (!source || typeof source !== 'object') throw contractError(`Option ${optionIndex + 1} for ${normalized.id} is invalid.`)
      const value = text(source.value, 200)
      const label = text(source.label || source.value, 200)
      if (!value || !label) throw contractError(`Option ${optionIndex + 1} for ${normalized.id} is incomplete.`)
      return { value, label }
    })
  }
  return normalized
}

function normalizeFields(fields, kind) {
  const values = Array.isArray(fields) ? fields : []
  if (values.length > MAX_FIELDS) throw contractError(`A Skill can declare at most ${MAX_FIELDS} ${kind.toLowerCase()} fields.`)
  const normalized = values.map((field, index) => normalizeField(field, index, kind))
  const ids = new Set()
  for (const field of normalized) {
    if (ids.has(field.id)) throw contractError(`${kind} field ids must be unique.`)
    ids.add(field.id)
  }
  return normalized
}

function normalizeConnectors(connectors) {
  const values = Array.isArray(connectors) ? connectors : []
  if (values.length > 20) throw contractError('A Skill can declare at most 20 connectors.')
  const seen = new Set()
  return values.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw contractError(`Connector ${index + 1} is invalid.`)
    const connector = identifier(entry.connector || entry.id, 'Connector id')
    if (seen.has(connector)) throw contractError('Connector ids must be unique.')
    seen.add(connector)
    const operations = [...new Set((Array.isArray(entry.operations) ? entry.operations : []).map(operation => identifier(operation, 'Connector operation')))]
    if (!operations.length || operations.length > 40) throw contractError(`Connector ${connector} needs between 1 and 40 operations.`)
    return { connector, operations }
  })
}

function normalizeWorkPlan(workPlan) {
  const values = Array.isArray(workPlan) ? workPlan : []
  if (values.length > 30) throw contractError('A Skill work plan can contain at most 30 steps.')
  const seen = new Set()
  return values.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw contractError(`Work plan step ${index + 1} is invalid.`)
    const id = identifier(step.id, 'Work plan step id')
    const label = text(step.label, 240)
    const owner = text(step.owner || 'claritymode', 40)
    if (!label) throw contractError(`Work plan step ${index + 1} needs a label.`)
    if (!WORK_PLAN_OWNERS.has(owner)) throw contractError(`Work plan step ${id} has an unsupported owner.`)
    if (seen.has(id)) throw contractError('Work plan step ids must be unique.')
    seen.add(id)
    return { id, label, owner }
  })
}

function validateManifest(value, expectedSkillId = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError('A Skill manifest is required.')
  const contractVersion = text(value.contractVersion, 20)
  if (contractVersion !== CONTRACT_VERSION) throw contractError(`Unsupported Skill contract version: ${contractVersion || 'missing'}.`)
  const skillId = identifier(value.skillId, 'Skill id')
  if (expectedSkillId && skillId !== expectedSkillId) throw contractError('The manifest Skill id does not match the registered Skill.')
  const skillVersion = text(value.skillVersion, 40)
  const name = text(value.name, 160)
  if (!skillVersion) throw contractError('A Skill version is required.')
  if (!name) throw contractError('A Skill name is required.')
  const completion = value.completion && typeof value.completion === 'object' ? value.completion : {}
  const outputs = normalizeFields(value.outputs, 'Output')
  if (outputs.length !== 1) throw contractError('ClarityMode Skill Contract v1 requires exactly one primary output.')
  if (!outputs[0].required) throw contractError('The primary Skill output must be required.')
  return {
    contractVersion,
    skillId,
    skillVersion,
    name,
    description: text(value.description, 1000),
    inputs: normalizeFields(value.inputs, 'Input'),
    outputs,
    connectors: normalizeConnectors(value.connectors),
    workPlan: normalizeWorkPlan(value.workPlan),
    taskProposals: { enabled: Boolean(value.taskProposals?.enabled) },
    completion: {
      requiresAcceptance: completion.requiresAcceptance !== false,
      completeSourceTaskOnAcceptance: Boolean(completion.completeSourceTaskOnAcceptance),
      completeWorkAreaOnAcceptance: Boolean(completion.completeWorkAreaOnAcceptance),
    },
  }
}

function validateAssignmentInputs(manifest, inputs) {
  const normalizedManifest = validateManifest(manifest)
  const values = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : {}
  const allowed = new Set(normalizedManifest.inputs.map(field => field.id))
  const unknown = Object.keys(values).find(key => !allowed.has(key))
  if (unknown) throw contractError(`Unknown Skill input: ${unknown}.`)
  const result = {}
  for (const field of normalizedManifest.inputs) {
    const value = values[field.id]
    const missing = value === undefined || value === null || value === ''
    if (field.required && missing) throw contractError(`${field.label} is required.`)
    if (missing) continue
    if (field.type === 'checkbox') result[field.id] = Boolean(value)
    else if (field.type === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) throw contractError(`${field.label} must be a number.`)
      result[field.id] = number
    } else {
      const string = text(value, field.type === 'long_text' ? 200_000 : 5_000)
      if (field.type === 'select' && !field.options.some(option => option.value === string)) throw contractError(`Choose a valid option for ${field.label}.`)
      result[field.id] = string
    }
  }
  return result
}

function connectorAllowed(manifest, connector, operation) {
  const connectorId = text(connector, 100)
  const operationId = text(operation, 100)
  return Boolean((manifest?.connectors || []).some(entry => entry.connector === connectorId && entry.operations.includes(operationId)))
}

function validateArtifacts(manifest, artifacts, { requireOutputs = false } = {}) {
  const normalizedManifest = validateManifest(manifest)
  const values = Array.isArray(artifacts) ? artifacts : []
  if (values.length > MAX_ARTIFACTS) throw contractError(`A Skill can return at most ${MAX_ARTIFACTS} artifacts.`)
  const declared = new Map(normalizedManifest.outputs.map(output => [output.id, output]))
  const seen = new Set()
  const normalized = values.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw contractError(`Artifact ${index + 1} is invalid.`)
    const id = identifier(artifact.id, 'Artifact id')
    const output = declared.get(id)
    if (!output) throw contractError(`The Skill returned an undeclared artifact: ${id}.`)
    if (seen.has(id)) throw contractError(`The Skill returned artifact ${id} more than once.`)
    seen.add(id)
    const type = text(artifact.type || output.type, 40)
    if (type !== output.type) throw contractError(`Artifact ${id} does not match its declared output type.`)
    const value = { id, type, title: text(artifact.title || output.label, 240) }
    if (type === 'markdown' || type === 'plain_text') {
      const content = String(artifact.content || '')
      if (!content.trim()) throw contractError(`Artifact ${id} is empty.`)
      if (content.length > MAX_ARTIFACT_TEXT) throw contractError(`Artifact ${id} is too large.`)
      value.content = content
    } else if (type === 'structured_list') {
      const items = Array.isArray(artifact.items) ? artifact.items : []
      if (!items.length || items.length > 1000) throw contractError(`Artifact ${id} needs between 1 and 1000 items.`)
      const serialized = JSON.stringify(items)
      if (serialized.length > MAX_ARTIFACT_TEXT) throw contractError(`Artifact ${id} is too large.`)
      value.items = items
      value.content = String(artifact.content || '')
    } else if (type === 'file_link') {
      const url = text(artifact.url, 4000)
      if (!/^https:\/\//i.test(url)) throw contractError(`Artifact ${id} must use a secure web link.`)
      value.url = url
      value.content = String(artifact.content || '')
    }
    return value
  })
  if (requireOutputs) {
    const missing = normalizedManifest.outputs.find(output => output.required && !seen.has(output.id))
    if (missing) throw contractError(`The Skill did not return required output: ${missing.label}.`)
  }
  return normalized
}

function validateProviderResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError('The Skill returned an invalid response.')
  const status = text(value.status, 40)
  if (!RESPONSE_STATUSES.has(status)) throw contractError('The Skill returned an unsupported status.')
  const result = {
    contractVersion: CONTRACT_VERSION,
    status,
    stateToken: value.stateToken == null ? null : text(value.stateToken, 20_000),
    progress: value.progress && typeof value.progress === 'object'
      ? {
          label: text(value.progress.label || 'ClarityMode is working...', 300),
          currentStepId: value.progress.currentStepId ? identifier(value.progress.currentStepId, 'Current work plan step id') : '',
          completedStepIds: [...new Set((Array.isArray(value.progress.completedStepIds) ? value.progress.completedStepIds : [])
            .slice(0, 30).map(stepId => identifier(stepId, 'Completed work plan step id')))],
        }
      : { label: 'ClarityMode is working...', currentStepId: '', completedStepIds: [] },
    inputRequest: null,
    connectorRequest: null,
    review: null,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.slice(0, 40) : [],
    taskProposals: [],
    error: null,
  }
  if (status === 'needs_input') {
    result.inputRequest = normalizeField(value.inputRequest, 0, 'Input')
  }
  if (status === 'needs_connector') {
    const request = value.connectorRequest
    if (!request || typeof request !== 'object') throw contractError('The Skill did not provide a connector request.')
    result.connectorRequest = {
      id: identifier(request.id, 'Connector request id'),
      connector: identifier(request.connector, 'Connector id'),
      operation: identifier(request.operation, 'Connector operation'),
      arguments: request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments) ? request.arguments : {},
    }
  }
  if (status === 'ready_for_review') {
    const review = value.review && typeof value.review === 'object' ? value.review : {}
    result.review = {
      title: text(review.title || 'Ready for review', 200),
      message: text(review.message, 2000),
      allowRequestChanges: review.allowRequestChanges !== false,
    }
  }
  if (value.taskProposals !== undefined) {
    if (!Array.isArray(value.taskProposals) || value.taskProposals.length > 100) throw contractError('The Skill returned invalid task proposals.')
    result.taskProposals = value.taskProposals.map((proposal, index) => {
      const title = text(proposal?.title || proposal?.task, 500)
      if (!title) throw contractError(`Task proposal ${index + 1} needs a title.`)
      return {
        id: text(proposal?.id || `proposal-${index + 1}`, 120), title,
        details: text(proposal?.details, 20_000), owner: text(proposal?.owner, 500),
        dueDate: text(proposal?.dueDate, 40), suggestedForUser: Boolean(proposal?.suggestedForUser),
      }
    })
  }
  if (status === 'failed') {
    const error = value.error && typeof value.error === 'object' ? value.error : {}
    result.error = {
      code: text(error.code || 'skill_failed', 100),
      message: text(error.message || 'ClarityMode could not finish this assignment.', 500),
      retryable: Boolean(error.retryable),
      correlationId: text(error.correlationId, 120) || undefined,
    }
  }
  return result
}

module.exports = {
  CONTRACT_VERSION,
  INPUT_TYPES,
  OUTPUT_TYPES,
  RESPONSE_STATUSES,
  connectorAllowed,
  validateArtifacts,
  validateAssignmentInputs,
  validateManifest,
  validateProviderResponse,
}
