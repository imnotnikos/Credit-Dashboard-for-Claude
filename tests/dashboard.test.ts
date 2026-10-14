import { expect, mock, test } from 'claude-code/testing'

import { parseTranscript, summarize } from '../hooks/stats'

const NOW = Date.parse('2026-10-14T03:00:00.000Z')
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString()

const line = (value: unknown) => JSON.stringify(value)
const prompt = (hoursAgo: number, text: string) =>
  line({ type: 'user', timestamp: at(hoursAgo), message: { role: 'user', content: text } })
const tools = (hoursAgo: number, ...uses: { name: string; input?: unknown }[]) =>
  line({
    type: 'assistant',
    timestamp: at(hoursAgo),
    message: { content: uses.map(use => ({ type: 'tool_use', id: 'x', input: {}, ...use })) },
  })

const roblox = [
  prompt(30, 'connect to roblox studio'),
  prompt(2, 'now add a part'),
  line({ type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  tools(2, { name: 'mcp__Roblox_Studio__insert_asset' }, { name: 'mcp__Roblox_Studio__get_studio_state' }),
  tools(1, { name: 'Skill', input: { skill: 'anthropic-skills:pdf' } }, { name: 'mcp__ccd_session__mark_chapter' }),
  line({ type: 'custom-title', customTitle: 'Roblox Studio connection' }),
].join('\n')

const search = [
  prompt(100, 'research mods'),
  tools(100,
    { name: 'mcp__1a2b3c4d-0000-1111-2222-333344445555__firecrawl_search' },
    { name: 'mcp__1a2b3c4d-0000-1111-2222-333344445555__firecrawl_scrape' },
    { name: 'mcp__plugin_effortless_effortless__stats' },
  ),
  prompt(400, 'too old to count'),
].join('\n')

test('a bare command counts toward the installed plugin that ships it', async () => {
  const used = [line({ type: 'user', timestamp: at(1), message: { content: '<command-name>/home-dashboard</command-name>' } })].join('')
  const stats = summarize([parseTranscript(used)], NOW, { 'home-dashboard': 'home-dashboard' })
  expect(stats.plugins).toEqual([{ name: 'home-dashboard', count: 1 }])
  expect(stats.skills).toEqual([{ name: 'home-dashboard', count: 1 }])
})

test('a transcript yields its title, human prompts and tool uses', async () => {
  const t = parseTranscript(roblox)
  expect(t.title).toBe('Roblox Studio connection')
  expect(t.prompts.length).toBe(2)
  expect(t.mcp.length).toBe(3)
  expect(t.skills.map(s => s.name)).toEqual(['anthropic-skills:pdf'])
  expect(parseTranscript(search).title).toBe('research mods')
})

test('topics rank by prompts in the day, week or month, tools by the week', async () => {
  const stats = summarize([parseTranscript(roblox), parseTranscript(search)], NOW)
  expect(stats.topics.day).toEqual([{ name: 'Roblox Studio connection', count: 1 }])
  expect(stats.topics.week).toEqual([
    { name: 'Roblox Studio connection', count: 2 },
    { name: 'research mods', count: 1 },
  ])
  expect(stats.topics.month).toEqual([
    { name: 'research mods', count: 2 },
    { name: 'Roblox Studio connection', count: 2 },
  ])
  expect(stats.connectors).toEqual([
    { name: 'Firecrawl', count: 2 },
    { name: 'Roblox Studio', count: 2 },
  ])
  expect(stats.plugins).toEqual([
    { name: 'anthropic-skills', count: 1 },
    { name: 'effortless', count: 1 },
  ])
  expect(stats.skills).toEqual([{ name: 'pdf', count: 1 }])
})

const PANE = {
  title: 'Dashboard',
  isFocused: false,
  bodyColumns: 46,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('the pane draws three cards; ranges, meters and chart view toggle', async ($, on) => {
  mock.clock(on, { now: NOW })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'home-dashboard', surface, component: 'Pane', requestId: 'dashboard', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'Credit usage' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Main topics' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Most used' })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    expect((await ui.find({ key: 'range-week' }))?.props.variant).toBe('primary')
    await ui.press({ key: 'range-day' })
    expect((await ui.find({ key: 'range-day' }))?.props.variant).toBe('primary')
    await ui.press({ key: 'range-month' })
    expect((await ui.find({ key: 'range-month' }))?.props.variant).toBe('primary')
    await ui.press({ key: 'range-week' })

    // Each meter toggles off and back on.
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    await ui.press({ key: 'toggle-context' })
    expect((await ui.find({ key: 'toggle-context' }))?.text).toBe('○')
    await ui.press({ key: 'toggle-context' })
    expect((await ui.find({ key: 'toggle-context' }))?.text).toBe('◉')

    // The chart icon switches rings to bars and back.
    expect((await ui.find({ key: 'view-toggle' }))?.text).toBe('▂▅▇')
    await ui.press({ key: 'view-toggle' })
    expect((await ui.find({ key: 'view-toggle' }))?.text).toBe('◎')
    if (surface === 'desktop') expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('<rect')
    await ui.press({ key: 'view-toggle' })
    await ui.unmount()
  }
})
