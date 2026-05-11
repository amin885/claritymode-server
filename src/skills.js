const DEFAULT_SKILL_CATALOG = [
  {
    id: 'podcast',
    name: 'Podcast Pack',
    description: 'Helps shape episode ideas, outlines, show notes, and publishing follow-up.',
    version: '1.0.0',
    appliesTo: ['skill'],
    content: [
      '# Podcast Pack',
      '',
      'Use this skill only inside the explicit skill routine.',
      'Help the user turn rough podcast ideas into useful episode plans, outlines, show notes, and practical next actions.',
      'Keep recommendations concise, specific, and confirmation-based when suggesting saved changes.',
    ].join('\n'),
  },
]

function getSkillCatalog() {
  const raw = process.env.CLARITYMODE_SKILL_CATALOG
  if (!raw) return DEFAULT_SKILL_CATALOG
  try {
    const parsed = JSON.parse(raw)
    return normalizeCatalog(Array.isArray(parsed) ? parsed : parsed.skills)
  } catch {
    return DEFAULT_SKILL_CATALOG
  }
}

function normalizeCatalog(skills) {
  return (Array.isArray(skills) ? skills : [])
    .map(skill => ({
      id: String(skill.id || '').trim(),
      name: String(skill.name || skill.id || 'Untitled Skill').trim(),
      description: String(skill.description || '').trim(),
      version: String(skill.version || '').trim(),
      appliesTo: Array.isArray(skill.appliesTo) ? skill.appliesTo.map(String) : ['skill'],
      content: String(skill.content || '').trim(),
    }))
    .filter(skill => skill.id && skill.content)
}

function skillsForEnabledIds(enabledIds) {
  const allowed = new Set((Array.isArray(enabledIds) ? enabledIds : []).map(id => String(id).trim()).filter(Boolean))
  return getSkillCatalog().filter(skill => allowed.has(skill.id))
}

module.exports = { getSkillCatalog, skillsForEnabledIds }
