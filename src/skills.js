const db = require('./db')
const anthropic = require('./anthropic')

const DEFAULT_SKILL_CATALOG = []
const MAX_SKILL_BYTES = 256 * 1024

async function getSkillCatalog() {
  try {
    const result = await db.query(`
      SELECT id, name, description, version, source_url, data_source, content, summary, status, created_at, updated_at
      FROM v2_skills
      WHERE status = 'active'
      ORDER BY name ASC
    `)
    if (Array.isArray(result?.rows)) return normalizeCatalog(result.rows)
  } catch {
    // Fall back to env-based catalog for local/dev compatibility.
  }

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
      sourceUrl: String(skill.sourceUrl || skill.source_url || '').trim(),
      dataSource: String(skill.dataSource || skill.data_source || '').trim() || undefined,
      appliesTo: Array.isArray(skill.appliesTo) ? skill.appliesTo.map(String) : ['skill'],
      content: String(skill.content || '').trim(),
      summary: String(skill.summary || '').trim(),
      status: String(skill.status || 'active').trim(),
    }))
    .filter(skill => skill.id && skill.content && skill.status !== 'archived')
}

async function skillsForEnabledIds(enabledIds) {
  const allowed = new Set((Array.isArray(enabledIds) ? enabledIds : []).map(id => String(id).trim()).filter(Boolean))
  const catalog = await getSkillCatalog()
  return catalog.filter(skill => allowed.has(skill.id))
}

async function fetchSkillMarkdown(sourceUrl) {
  const url = String(sourceUrl || '').trim()
  if (!url) throw Object.assign(new Error('sourceUrl is required.'), { status: 400 })
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw Object.assign(new Error('Skill URL must be a valid http(s) URL.'), { status: 400 })
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('Skill URL must use http or https.'), { status: 400 })
  }

  const response = await fetch(url)
  if (!response.ok) throw Object.assign(new Error(`Could not fetch skill: ${response.status}`), { status: 400 })
  const contentType = response.headers.get('content-type') || ''
  if (contentType && !/text|markdown|plain|octet-stream|json/i.test(contentType)) {
    throw Object.assign(new Error('Skill URL must return text or markdown.'), { status: 400 })
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) {
    throw Object.assign(new Error('Skill markdown is too large.'), { status: 400 })
  }
  return text
}

async function previewSkill(input = {}) {
  const sourceUrl = String(input.sourceUrl || input.source_url || '').trim()
  const content = sourceUrl ? await fetchSkillMarkdown(sourceUrl) : String(input.content || '').trim()
  const parsed = parseSkillMarkdown(content, sourceUrl)
  const summary = await summarizeSkill(parsed)
  return { ...parsed, sourceUrl, summary }
}

async function installSkill(input = {}) {
  const preview = {
    id: String(input.id || '').trim(),
    name: String(input.name || '').trim(),
    description: String(input.description || '').trim(),
    version: String(input.version || '').trim(),
    sourceUrl: String(input.sourceUrl || input.source_url || '').trim(),
    dataSource: String(input.dataSource || input.data_source || '').trim(),
    content: String(input.content || '').trim(),
    summary: String(input.summary || '').trim(),
  }
  const parsed = parseSkillMarkdown(preview.content, preview.sourceUrl)
  const skill = {
    ...parsed,
    ...Object.fromEntries(Object.entries(preview).filter(([, value]) => value)),
    status: 'active',
  }
  if (!skill.summary) skill.summary = await summarizeSkill(skill)

  const result = await db.query(
    `INSERT INTO v2_skills (id, name, description, version, source_url, data_source, content, summary, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       version = EXCLUDED.version,
       source_url = EXCLUDED.source_url,
       data_source = EXCLUDED.data_source,
       content = EXCLUDED.content,
       summary = EXCLUDED.summary,
       status = 'active',
       updated_at = now()
     RETURNING id, name, description, version, source_url, data_source, content, summary, status, created_at, updated_at`,
    [skill.id, skill.name, skill.description, skill.version, skill.sourceUrl, String(skill.dataSource || '').trim(), skill.content, skill.summary],
  )
  return normalizeCatalog(result.rows)[0]
}

function parseSkillMarkdown(content, sourceUrl = '') {
  const markdown = String(content || '').trim()
  if (!markdown) throw Object.assign(new Error('Skill markdown is required.'), { status: 400 })
  if (Buffer.byteLength(markdown, 'utf8') > MAX_SKILL_BYTES) {
    throw Object.assign(new Error('Skill markdown is too large.'), { status: 400 })
  }
  if (!/(^|\n)#|\bskill\b/i.test(markdown)) {
    throw Object.assign(new Error('This does not look like a SKILL.md file.'), { status: 400 })
  }

  const frontmatter = parseFrontmatter(markdown)
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const filename = sourceUrl ? sourceUrl.split('/').pop()?.replace(/\.md$/i, '') : ''
  const name = String(frontmatter.name || frontmatter.title || heading || filename || 'Untitled Skill').trim()
  const description = String(frontmatter.description || firstParagraph(markdown) || '').trim()
  const id = slugify(frontmatter.id || name)
  if (!id) throw Object.assign(new Error('Skill id could not be derived.'), { status: 400 })
  return {
    id,
    name,
    description,
    version: String(frontmatter.version || '').trim(),
    sourceUrl: String(sourceUrl || '').trim(),
    content: markdown,
  }
}

async function summarizeSkill(skill) {
  if (typeof anthropic.summarizeSkill === 'function') {
    try {
      const summary = await anthropic.summarizeSkill(skill)
      if (summary) return summary
    } catch {
      // Keep owner import usable even if Maude summary generation is unavailable.
    }
  }
  return [
    `${skill.name} is an isolated ClarityMode skill chat.`,
    skill.description || 'Use it when its instructions match the situation you are working through.',
    'It can advise and guide inside its own routine, but it does not write to the vault.',
  ].join('\n\n')
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*/)
  if (!match) return {}
  return match[1].split(/\r?\n/).reduce((acc, line) => {
    const parts = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (parts) acc[parts[1]] = parts[2].replace(/^['"]|['"]$/g, '').trim()
    return acc
  }, {})
}

function firstParagraph(markdown) {
  return markdown
    .replace(/^---\s*\n[\s\S]*?\n---\s*/, '')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .find(block => block && !block.startsWith('#') && !block.startsWith('```'))
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

module.exports = {
  getSkillCatalog,
  installSkill,
  parseSkillMarkdown,
  previewSkill,
  skillsForEnabledIds,
}
