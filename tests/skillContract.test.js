const { connectorAllowed, validateArtifacts, validateManifest, validateProviderResponse } = require('../src/skillContract')
const { publicSkill } = require('../src/skills')

const manifest = {
  contractVersion: '1',
  skillId: 'company-research',
  skillVersion: '1.0.0',
  name: 'Company Research',
  description: 'Prepare a company brief.',
  inputs: [
    { id: 'companyName', type: 'text', label: 'Company', required: true },
    { id: 'depth', type: 'select', label: 'Depth', options: ['Brief', 'Detailed'] },
  ],
  outputs: [{ id: 'brief', type: 'markdown', label: 'Company brief', required: true }],
  connectors: [{ connector: 'company_data', operations: ['research'] }],
}

describe('ClarityMode Skill Contract v1', () => {
  test('normalizes a reusable Skill manifest', () => {
    const result = validateManifest(manifest)
    expect(result).toMatchObject({
      contractVersion: '1',
      skillId: 'company-research',
      completion: {
        requiresAcceptance: true,
        completeSourceTaskOnAcceptance: false,
        completeWorkAreaOnAcceptance: false,
      },
    })
    expect(result.inputs[1].options).toEqual([
      { value: 'Brief', label: 'Brief' },
      { value: 'Detailed', label: 'Detailed' },
    ])
  })

  test('rejects mismatched ids and unsupported field types', () => {
    expect(() => validateManifest(manifest, 'different-skill')).toThrow(/does not match/i)
    expect(() => validateManifest({ ...manifest, inputs: [{ id: 'file', type: 'password', label: 'Secret' }] })).toThrow(/unsupported/i)
  })

  test('uses an explicit connector allow-list', () => {
    const result = validateManifest(manifest)
    expect(connectorAllowed(result, 'company_data', 'research')).toBe(true)
    expect(connectorAllowed(result, 'company_data', 'delete')).toBe(false)
    expect(connectorAllowed(result, 'arbitrary_url', 'fetch')).toBe(false)
  })

  test('normalizes generic input and review states', () => {
    expect(validateProviderResponse({
      status: 'needs_input',
      stateToken: 'opaque',
      inputRequest: { id: 'goal', type: 'long_text', label: 'What should this accomplish?', required: true },
    })).toMatchObject({ status: 'needs_input', inputRequest: { id: 'goal', type: 'long_text' } })

    expect(validateProviderResponse({
      status: 'ready_for_review',
      review: { title: 'Review the brief', allowRequestChanges: true },
      artifacts: [{ id: 'brief', title: 'Acme brief', type: 'markdown', content: '# Acme' }],
    })).toMatchObject({ status: 'ready_for_review', review: { title: 'Review the brief', allowRequestChanges: true } })
  })

  test('requires structured connector requests', () => {
    expect(() => validateProviderResponse({ status: 'needs_connector' })).toThrow(/connector request/i)
    expect(validateProviderResponse({
      status: 'needs_connector',
      connectorRequest: { id: 'request-1', connector: 'company_data', operation: 'research', arguments: { company: 'Acme' } },
    })).toMatchObject({ connectorRequest: { connector: 'company_data', operation: 'research' } })
  })

  test('accepts only declared, type-safe artifacts', () => {
    expect(validateArtifacts(manifest, [
      { id: 'brief', type: 'markdown', title: 'Acme brief', content: '# Acme' },
    ], { requireOutputs: true })).toEqual([
      { id: 'brief', type: 'markdown', title: 'Acme brief', content: '# Acme' },
    ])
    expect(() => validateArtifacts(manifest, [
      { id: 'invoice', type: 'markdown', content: '# Invoice' },
    ])).toThrow(/undeclared artifact/i)
    expect(() => validateArtifacts(manifest, [], { requireOutputs: true })).toThrow(/required output/i)
  })

  test('keeps provider routing private in user-facing Skill metadata', () => {
    expect(publicSkill({
      id: 'company-research',
      provider: 'mindstudio',
      providerAppId: 'private-agent-id',
      providerVersion: 'published',
      manifest,
    })).toEqual({ id: 'company-research', manifest })
  })
})
