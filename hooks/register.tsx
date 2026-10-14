import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderChildren,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { DashboardMeter, DashboardRanked, DashboardRange, DashboardRing, DashboardUsage } from '../types'
import { parseTranscript, summarize } from './stats'
import type { Transcript } from './stats'

const PANE = 'dashboard'
const TITLE = 'Dashboard'
const MONTH = 30 * 24 * 60 * 60 * 1000
const MAX_READ = 4 * 1024 * 1024
const REFRESH_MS = 2 * 60 * 1000

// Claude's warm palette: sand for the session, clay for the week, olive for context.
const METERS: { id: DashboardMeter; name: string; color: string; radius: number; hotkey: string }[] = [
  { id: 'session', name: 'Session', color: '#E8A55A', radius: 86, hotkey: '1' },
  { id: 'weekly', name: 'Weekly', color: '#D97757', radius: 64, hotkey: '2' },
  { id: 'context', name: 'Context', color: '#788C5D', radius: 42, hotkey: '3' },
]

const RANGES: { id: DashboardRange; label: string; hotkey: string; empty: string }[] = [
  { id: 'day', label: 'Day', hotkey: 'd', empty: 'Nothing in the last 24 hours.' },
  { id: 'week', label: 'Week', hotkey: 'w', empty: 'Nothing in the last 7 days.' },
  { id: 'month', label: 'Month', hotkey: 'm', empty: 'Nothing in the last 30 days.' },
]

const usage = atom({ plugin: 'home-dashboard', key: 'usage' } as const, null)
const stats = atom({ plugin: 'home-dashboard', key: 'stats' } as const, null)
const range = atom({ plugin: 'home-dashboard', key: 'range' } as const, 'week')
const view = atom({ plugin: 'home-dashboard', key: 'view' } as const, 'rings')
const hidden = atom({ plugin: 'home-dashboard', key: 'hidden' } as const, [])

const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const toRing = (windows: SessionRateLimit[], kind: string): DashboardRing => {
  const found = windows.find(one => one.kind === kind)

  return found ? { percent: found.percentUsed, resetsAt: found.resetsAt } : { percent: null }
}

const toContext = (context: SessionContextUsage | undefined): DashboardRing =>
  context?.percent === undefined
    ? { percent: null, detail: 'no reading yet' }
    : { percent: context.percent, detail: `${tokens(context.tokens ?? 0)} of ${tokens(context.window)}` }

const toUsage = (windows: SessionRateLimit[], context?: SessionContextUsage): DashboardUsage => ({
  session: toRing(windows, 'five_hour'),
  weekly: toRing(windows, 'seven_day'),
  context: toContext(context),
})

// Parsed transcripts by path, kept while a file's size and mtime hold.
const cache = new Map<string, { key: string; transcript: Transcript }>()

const claudeDir = async ($: EngineInterface) => {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return home ? `${home}/.claude` : null
}

// Each installed plugin's name, commands and skills, mapped to the plugin.
const pluginOwners = async ($: EngineInterface, root: string) => {
  const owners: Record<string, string> = {}
  const text = await $.fs.read(`${root}/plugins/installed_plugins.json`).catch(() => null)
  if (text === null) return owners
  let registry: { plugins?: Record<string, { installPath?: string }[]> }
  try {
    registry = JSON.parse(text)
  } catch {
    return owners
  }
  for (const [id, installs] of Object.entries(registry.plugins ?? {})) {
    const plugin = id.split('@')[0] ?? id
    owners[plugin] = plugin
    const path = installs[0]?.installPath
    if (!path) continue
    for (const entry of await $.fs.list(`${path}/commands`).catch(() => [])) {
      if (entry.kind === 'file' && entry.name.endsWith('.md')) owners[entry.name.slice(0, -3)] = plugin
    }
    for (const entry of await $.fs.list(`${path}/skills`).catch(() => [])) {
      if (entry.kind === 'dir') owners[entry.name] = plugin
    }
  }

  return owners
}

const refreshStats = async ($: EngineInterface) => {
  const root = await claudeDir($)
  if (!root) return
  const now = await $.clock.now()
  const projects = await $.fs.list(`${root}/projects`).catch(() => [])
  const transcripts: Transcript[] = []

  for (const project of projects) {
    if (project.kind !== 'dir') continue
    const dir = `${root}/projects/${project.name}`
    const files = await $.fs.list(dir).catch(() => [])
    for (const file of files) {
      if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
      if (now - file.mtimeMs > MONTH || file.size > MAX_READ) continue
      const path = `${dir}/${file.name}`
      const key = `${file.size}:${file.mtimeMs}`
      const kept = cache.get(path)
      if (kept?.key === key) {
        transcripts.push(kept.transcript)
        continue
      }
      const text = await $.fs.read(path).catch(() => null)
      if (text === null) continue
      const transcript = parseTranscript(text)
      cache.set(path, { key, transcript })
      transcripts.push(transcript)
    }
  }

  const next = summarize(transcripts, now, await pluginOwners($, root))
  await update($, stats, () => next)
}

const refreshUsage = async ($: EngineInterface) => {
  const { rateLimits, context } = await $.session.usage()
  const next = toUsage(rateLimits, context)
  await update($, usage, () => next)
}

const untilReset = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return 'no reading yet'
  const ms = Date.parse(resetsAt) - now
  if (isNaN(ms)) return ''
  if (ms <= 0) return 'resets now'
  const minutes = Math.round(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`

  return `resets in ${minutes}m`
}

const label = (ring: DashboardRing) =>
  ring.percent === null ? '—' : `${Math.round(ring.percent)}%`

const share = (ring: DashboardRing) => Math.min(100, Math.max(0, ring.percent ?? 0)) / 100

const FONT = `font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"`

type Shown = { name: string; color: string; radius: number; ring: DashboardRing }

const ringsSvg = (shown: Shown[]) => {
  const arcs = shown.map(({ radius, color, ring }) => {
    const circumference = 2 * Math.PI * radius
    const filled = share(ring) * circumference
    const track = `<circle cx="100" cy="100" r="${radius}" fill="none" stroke="${color}" stroke-opacity="0.22" stroke-width="16"/>`
    const bar =
      filled > 0
        ? `<circle cx="100" cy="100" r="${radius}" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="butt" stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 100 100)"/>`
        : ''

    return track + bar
  })
  const lineHeight = 18
  const top = 100 - ((shown.length - 1) * lineHeight) / 2 + 5
  const labels = shown.map(
    ({ color, ring }, i) => `<text x="100" y="${top + i * lineHeight}" fill="${color}">${label(ring)}</text>`,
  )

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${arcs.join('')}` +
    `<g ${FONT} font-weight="700" font-size="15" text-anchor="middle">${labels.join('')}</g></svg>`
  )
}

const BAR_ROW = 34

const barsSvg = (shown: Shown[]) => {
  const rows = shown.map(({ name, color, ring }, i) => {
    const y = i * BAR_ROW
    const width = 150 * share(ring)

    return (
      `<text x="0" y="${y + 21}" font-size="13" fill="${color}" font-weight="600">${name}</text>` +
      `<rect x="66" y="${y + 10}" width="150" height="14" rx="7" fill="${color}" fill-opacity="0.22"/>` +
      (width > 0 ? `<rect x="66" y="${y + 10}" width="${width.toFixed(2)}" height="14" rx="7" fill="${color}"/>` : '') +
      `<text x="260" y="${y + 21}" font-size="13" font-weight="700" text-anchor="end" fill="${color}">${label(ring)}</text>`
    )
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 ${shown.length * BAR_ROW}"><g ${FONT}>${rows.join('')}</g></svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'home-dashboard',
      description: 'Open the dashboard: credit usage, main topics, most used tools',
    })
    void $.ui.open({ id: PANE, title: TITLE, columns: 46 })
    void refreshUsage($).catch(() => undefined)
    void refreshStats($).catch(() => undefined)
    $.clock.every(REFRESH_MS, () => {
      void refreshStats($).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'home-dashboard' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, columns: 46 })
    void refreshStats($).catch(() => undefined)

    return { text: 'Dashboard opened.' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') || e.changed.includes('context')) {
      const value = toUsage(e.rateLimits, e.context)
      await update($, usage, () => value)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const now = await $.clock.now()
    const credit = (await read($, usage)) ?? toUsage([])
    const numbers = await read($, stats)
    const shownRange = await read($, range)
    const chart = await read($, view)
    const off = await read($, hidden)

    const card = (title: string, body: RenderChildren, aside?: RenderChildren) => (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold>{title}</Text>
          {aside ?? null}
        </Box>
        {body}
      </Box>
    )

    const rows = (list: DashboardRanked[] | undefined, empty: string) =>
      !list || list.length === 0 ? (
        <Text dimColor>{numbers ? empty : 'Reading your sessions…'}</Text>
      ) : (
        <Box flexDirection="column">
          {list.map(item => (
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text wrap="truncate-end">{item.name}</Text>
              <Text dimColor>{String(item.count)}</Text>
            </Box>
          ))}
        </Box>
      )

    const shown: Shown[] = METERS.filter(m => !off.includes(m.id)).map(m => ({ ...m, ring: credit[m.id] }))

    const legend = METERS.map(m => {
      const ring = credit[m.id]
      const isOn = !off.includes(m.id)
      const detail = m.id === 'context' ? (ring.detail ?? '') : untilReset(ring.resetsAt, now)

      return (
        <Box flexDirection="row" gap={1}>
          <Button
            key={`toggle-${m.id}`}
            plain
            hotkey={m.hotkey}
            onPress={() =>
              update($, hidden, list => (list.includes(m.id) ? list.filter(id => id !== m.id) : [...list, m.id]))
            }
          >
            <Text color={isOn ? m.color : 'inactive'}>{isOn ? '◉' : '○'}</Text>
          </Button>
          <Text dimColor={!isOn}>{m.name}</Text>
          <Text bold color={isOn ? m.color : 'inactive'}>{label(ring)}</Text>
          <Text dimColor>{detail}</Text>
        </Box>
      )
    })

    const picture =
      shown.length === 0 ? (
        <Text dimColor>Every meter is off. Turn one on below.</Text>
      ) : Svg ? (
        chart === 'rings' ? (
          <Svg source={ringsSvg(shown)} alt={shown.map(s => `${s.name} ${label(s.ring)}`).join(', ')} width={160} height={160} />
        ) : (
          <Svg
            source={barsSvg(shown)}
            alt={shown.map(s => `${s.name} ${label(s.ring)}`).join(', ')}
            width={260}
            height={shown.length * BAR_ROW}
          />
        )
      ) : null

    const switcher = (
      <Button
        key="view-toggle"
        plain
        hotkey="b"
        onPress={() => update($, view, current => (current === 'rings' ? 'bars' : 'rings'))}
      >
        <Text color="claude">{chart === 'rings' ? '▂▅▇' : '◎'}</Text>
      </Button>
    )

    const usageCard = card(
      'Credit usage',
      <Box flexDirection="column" alignItems="center" gap={1}>
        {picture}
        <Box flexDirection="column">{legend}</Box>
      </Box>,
      switcher,
    )

    const toggle = (
      <Box flexDirection="row" gap={1}>
        {RANGES.map(r => (
          <Button
            key={`range-${r.id}`}
            label={r.label}
            hotkey={r.hotkey}
            variant={shownRange === r.id ? 'primary' : 'secondary'}
            onPress={() => update($, range, () => r.id)}
          />
        ))}
      </Box>
    )

    const topicsCard = card(
      'Main topics',
      rows(numbers?.topics[shownRange], RANGES.find(r => r.id === shownRange)?.empty ?? ''),
      toggle,
    )

    const group = (name: string, list: DashboardRanked[] | undefined) => (
      <Box flexDirection="column">
        <Text color="claude" bold>{name}</Text>
        {rows(list?.slice(0, 3), 'None this week')}
      </Box>
    )

    const usedCard = card(
      'Most used',
      <Box flexDirection="column" gap={1}>
        {group('Plugins', numbers?.plugins)}
        {group('Connectors', numbers?.connectors)}
        {group('Skills', numbers?.skills)}
      </Box>,
      <Text dimColor>7 days</Text>,
    )

    return (
      <Box flexDirection="column" gap={1}>
        {usageCard}
        {topicsCard}
        {usedCard}
      </Box>
    )
  })
}
