import type { DashboardConnector } from '../types'

export const STATUS_TOOL = 'mcp__ccd_connectors__session_connectors_status'
export const SET_TOOL = 'mcp__ccd_connectors__set_session_connector_enabled'
// A connector the model used within this many prompts stays on, so follow-ups ("now do it") keep their tools.
export const KEEP_FOR = 3

export const PICK_SYSTEM =
  'You route a coding assistant request to the external connectors it needs. Answer with a JSON array of connector names only, [] when none are needed. Be conservative: include a connector only when the request clearly calls for it.'

const HANDOFF_PROMPT = `Write a handoff document so a fresh Claude Code chat can continue this work with no other context.
Output ONLY the markdown document. Be dense: no narration, no pleasantries, no tool-output dumps, no history of dead ends unless they constrain what to do next.
Use these sections (omit any that would be empty):
# Handoff: <short title>
## Goal — what the user wants, in their terms, including explicit preferences and constraints.
## Current state — what is done and verified, what is half-done.
## Key decisions — each with a one-line why.
## Files — absolute paths (with line numbers where useful) and what each holds or what changed.
## Essential code — only snippets the next chat needs verbatim (signatures, config, tricky logic), fenced with language tags.
## Commands & environment — exact commands to build/run/test, env details, versions.
## Open problems — bugs, failing tests, unknowns, with exact error text.
## Next steps — numbered, concrete, in order.
## Gotchas — anything that would waste the next chat's time.`

export const handoffPrompt = (focus: string) =>
  focus ? `${HANDOFF_PROMPT}\n\nThe next chat should focus on: ${focus}` : HANDOFF_PROMPT

// Pulls the text out of whatever shape an MCP tool result arrives in.
const textOf = (r: unknown): string => {
  if (!r || typeof r !== 'object' || ('deny' in r && (r as { deny?: string }).deny)) return ''
  const { text, result } = r as { text?: unknown; result?: unknown }
  if (typeof text === 'string') return text
  const blocks = Array.isArray(result) ? result : (result as { content?: unknown } | undefined)?.content
  if (Array.isArray(blocks)) return blocks.map(b => (b as { text?: string }).text ?? '').join('')

  return typeof result === 'string' ? result : ''
}

/** The connector rows out of a session_connectors_status result. */
export const parseConnectors = (r: unknown): DashboardConnector[] => {
  const raw = textOf(r)
  const servers: { name: string; id?: string; kind: string; status: string }[] =
    JSON.parse(raw.slice(raw.indexOf('{'))).servers ?? []

  return servers.map(s => ({ name: s.name, id: s.id, kind: s.kind, isOn: s.status !== 'disabled' }))
}

/** The names in Haiku's reply: the strings in its first JSON array, [] when it gave none. */
export const parsePick = (reply: string): string[] => {
  const match = reply.match(/\[[\s\S]*?\]/)
  const picked: unknown = match ? JSON.parse(match[0]) : []

  return Array.isArray(picked) ? picked.filter((x): x is string => typeof x === 'string') : []
}

/** The handle to switch a connector by: names can repeat (two "Higgsfield AI"), ids can't. */
export const connectorKey = (row: DashboardConnector) => row.id ?? row.name

/** Decides which connectors to switch: only claude.ai connectors (kind "connector") can be. */
export const plan = (rows: DashboardConnector[], needed: string[], recent: Set<string>) => {
  const want = new Set(needed.map(n => n.toLowerCase()))
  const enable: DashboardConnector[] = []
  const disable: DashboardConnector[] = []
  for (const row of rows) {
    if (row.kind !== 'connector') continue
    const isNeeded = want.has(row.name.toLowerCase())
    // Tool calls name a server by id or, for some connectors, by name (mcp__visualize__…).
    const isRecent = recent.has(connectorKey(row)) || recent.has(row.name)
    if (isNeeded && !row.isOn) enable.push(row)
    if (!isNeeded && row.isOn && !isRecent) disable.push(row)
  }

  return { enable, disable }
}
