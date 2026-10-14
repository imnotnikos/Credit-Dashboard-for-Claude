import type { DashboardRanked, DashboardStats } from '../types'

const DAY = 24 * 60 * 60 * 1000
const WEEK = 7 * DAY
const TOP = 5

// What one transcript file holds that the dashboard needs.
export type Transcript = {
  title: string | null
  prompts: number[]
  skills: { at: number; name: string }[]
  mcp: { at: number; name: string }[]
}

type Block = { type?: string; name?: string; input?: Record<string, unknown>; text?: string }
type Line = {
  type?: string
  customTitle?: string
  aiTitle?: string
  summary?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  message?: { content?: string | Block[] }
}

const isInteresting = (raw: string) =>
  raw.includes('"type":"user"') ||
  raw.includes('"type":"assistant"') ||
  raw.includes('"type":"custom-title"') ||
  raw.includes('"type":"ai-title"') ||
  raw.includes('"type":"summary"')

const textOf = (content: string | Block[] | undefined): string | null => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  if (content.some(block => block.type === 'tool_result')) return null
  const text = content.find(block => block.type === 'text')?.text

  return typeof text === 'string' ? text : ''
}

export function parseTranscript(text: string): Transcript {
  const out: Transcript = { title: null, prompts: [], skills: [], mcp: [] }
  let aiTitle: string | null = null
  let firstPrompt: string | null = null

  for (const raw of text.split('\n')) {
    if (!raw || !isInteresting(raw)) continue
    let line: Line
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    const at = line.timestamp ? Date.parse(line.timestamp) : NaN

    if (line.type === 'custom-title' && line.customTitle) out.title = line.customTitle
    else if (line.type === 'ai-title' && line.aiTitle) aiTitle = line.aiTitle
    else if (line.type === 'summary' && line.summary) aiTitle ??= line.summary
    else if (line.type === 'user' && !line.isMeta && !line.isSidechain && !isNaN(at)) {
      const said = textOf(line.message?.content)
      if (said === null) continue
      const command = said.match(/<command-name>\/?([^<\s]+)<\/command-name>/)
      if (command) {
        out.skills.push({ at, name: command[1] ?? '' })
      } else if (said.trimStart().startsWith('<')) {
        continue
      }
      out.prompts.push(at)
      if (firstPrompt === null && !command && said.trim()) firstPrompt = said.trim()
    } else if (line.type === 'assistant' && !line.isSidechain && !isNaN(at)) {
      const content = line.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type !== 'tool_use' || !block.name) continue
        if (block.name === 'Skill') {
          const skill = block.input?.skill ?? block.input?.command
          if (typeof skill === 'string') out.skills.push({ at, name: skill.replace(/^\//, '') })
        } else if (block.name.startsWith('mcp__')) {
          out.mcp.push({ at, name: block.name })
        }
      }
    }
  }

  out.title ??= aiTitle ?? (firstPrompt ? clip(firstPrompt.split('\n')[0] ?? '', 48) : null)

  return out
}

const clip = (text: string, room: number) =>
  text.length > room ? text.slice(0, room - 1).trimEnd() + '…' : text

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
const GENERIC = new Set([
  'get', 'list', 'create', 'update', 'delete', 'execute', 'read', 'write', 'search',
  'set', 'show', 'run', 'find', 'add', 'send', 'fetch', 'action', 'actions', 'tool',
  'tools', 'file', 'files', 'info', 'select', 'enable', 'disable', 'inspect',
])

// claude.ai connectors are named by id in tool names: name one by the word
// its tool names share most (firecrawl_search, firecrawl_scrape: Firecrawl).
const connectorLabel = (server: string, tools: string[]) => {
  if (!UUID.test(server)) return server.replace(/^claude_ai_/, '').replace(/_/g, ' ')
  const seen = new Map<string, number>()
  for (const tool of new Set(tools)) {
    for (const word of new Set(tool.toLowerCase().split(/[_-]/))) {
      if (word.length > 3 && !GENERIC.has(word)) seen.set(word, (seen.get(word) ?? 0) + 1)
    }
  }
  const best = [...seen].sort((a, b) => b[1] - a[1])[0]

  const word = best?.[0]

  return word ? word.charAt(0).toUpperCase() + word.slice(1) : `Connector ${server.slice(0, 6)}`
}

const rank = (counts: Map<string, number>): DashboardRanked[] =>
  [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP)

const bump = (counts: Map<string, number>, name: string, by = 1) =>
  counts.set(name, (counts.get(name) ?? 0) + by)

export function summarize(transcripts: Transcript[], now: number): DashboardStats {
  const day = new Map<string, number>()
  const week = new Map<string, number>()
  const plugins = new Map<string, number>()
  const skills = new Map<string, number>()
  const servers = new Map<string, { count: number; tools: string[] }>()

  for (const t of transcripts) {
    const title = t.title ?? 'Untitled session'
    const inDay = t.prompts.filter(at => now - at <= DAY).length
    const inWeek = t.prompts.filter(at => now - at <= WEEK).length
    if (inDay) bump(day, title, inDay)
    if (inWeek) bump(week, title, inWeek)

    for (const { at, name } of t.skills) {
      if (now - at > WEEK) continue
      const colon = name.indexOf(':')
      bump(skills, colon > 0 ? name.slice(colon + 1) : name)
      if (colon > 0) bump(plugins, name.slice(0, colon))
    }

    for (const { at, name } of t.mcp) {
      if (now - at > WEEK) continue
      const [server = '', tool = ''] = name.slice('mcp__'.length).split('__')
      if (server.startsWith('ccd_')) continue
      if (server.startsWith('plugin_')) {
        const rest = server.slice('plugin_'.length)
        const cut = rest.lastIndexOf('_')
        bump(plugins, cut > 0 ? rest.slice(0, cut) : rest)
        continue
      }
      const entry = servers.get(server) ?? { count: 0, tools: [] }
      entry.count += 1
      entry.tools.push(tool)
      servers.set(server, entry)
    }
  }

  const connectors = new Map<string, number>()
  for (const [server, { count, tools }] of servers) bump(connectors, connectorLabel(server, tools), count)

  return {
    topics: { day: rank(day), week: rank(week) },
    plugins: rank(plugins),
    connectors: rank(connectors),
    skills: rank(skills),
  }
}
