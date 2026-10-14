import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderChildren,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { DashboardMeter, DashboardRanked, DashboardRange, DashboardRing, DashboardUsage } from '../types'
import { KEEP_FOR, PICK_SYSTEM, SET_TOOL, STATUS_TOOL, handoffPrompt, parseConnectors, parsePick, plan } from './session-tools'
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
const autoConnectors = atom({ plugin: 'home-dashboard', key: 'autoConnectors' } as const, false)
const connectors = atom({ plugin: 'home-dashboard', key: 'connectors' } as const, null)
const lastSwitch = atom({ plugin: 'home-dashboard', key: 'lastSwitch' } as const, null)
const handoff = atom({ plugin: 'home-dashboard', key: 'handoff' } as const, null)

const refreshConnectors = async ($: EngineInterface) => {
  const rows = parseConnectors(await $.tool.call({ tool: STATUS_TOOL } as never))
  await update($, connectors, () => rows)

  return rows
}

// One switch for the button and /auto-connectors; remembered across chats.
const setAuto = async ($: EngineInterface, isOn: boolean) => {
  await update($, autoConnectors, () => isOn)
  await $.store.set('autoConnectors', isOn)
}

// Forks the chat into a lean handoff doc saved under handoffs/; resolves the path or why it failed.
const runHandoff = async ($: EngineInterface, focus: string) => {
  await update($, handoff, () => 'Writing…')
  const r = await $.model.fork({ prompt: handoffPrompt(focus) })
  if (!r.isAnswered) {
    await update($, handoff, () => `Failed: ${r.reason}`)
    return { error: r.reason }
  }
  const stamp = new Date(await $.clock.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const path = `${await $.session.cwd()}/handoffs/handoff-${stamp}.md`.replace(/\\/g, '/')
  await $.fs.write(path, r.text.trim() + '\n')
  await update($, handoff, () => path)

  return { path }
}

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
  let promptNo = 0
  const lastUsed = new Map<string, number>() // connector id -> prompt number it was last used in

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'home-dashboard',
      description: 'Open the dashboard: credit usage, main topics, most used tools',
    })
    await $.command.register({
      name: 'handoff',
      description: 'Write a lean markdown handoff doc for continuing in a new chat',
      argumentHint: '[what the next chat should focus on]',
    })
    await $.command.register({
      name: 'auto-connectors',
      description: 'Turn automatic connector switching on or off (one small Haiku call per prompt while on)',
      argumentHint: '[on|off]',
    })
    const isAuto = (await $.store.get('autoConnectors')) === true
    await update($, autoConnectors, () => isAuto)
    void refreshConnectors($).catch(() => undefined)
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

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const r = await runHandoff($, e.args.trim())
    if ('error' in r) return { text: `Handoff failed: ${r.error}` }

    return { text: `Handoff saved: ${r.path}\n\nIn a new chat, paste:\nRead ${r.path} and continue from where it leaves off.` }
  })

  on('command.run', { command: 'auto-connectors' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg && arg !== 'on' && arg !== 'off') return { text: 'Usage: /auto-connectors [on|off]' }
    const isOn = arg ? arg === 'on' : !(await read($, autoConnectors))
    await setAuto($, isOn)

    return {
      text: isOn
        ? 'Auto connectors: on. Before each prompt, Haiku picks the connectors it needs and the rest are switched off.'
        : 'Auto connectors: off. Connectors stay as you set them, and no Haiku calls are made.',
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, autoConnectors))) return composed

    return {
      ...composed,
      sections: [
        ...composed.sections,
        {
          id: 'home-dashboard-connectors',
          scope: 'session',
          text: `Connectors are switched off automatically when a prompt does not seem to need them. If a task needs a connector that is disabled, call ${SET_TOOL} with enabled: true, then tell the user its tools arrive next turn.`,
        },
      ],
    }
  })

  on('tool.call', ($, e, next) => {
    const id = e.tool.startsWith('mcp__') ? e.tool.split('__')[1] : undefined
    if (id && id !== 'ccd_connectors') lastUsed.set(id, promptNo)

    return next(e)
  })

  // Before each prompt, Haiku picks the connectors it needs; the rest are switched off.
  on('prompt.submit', async ($, e, next) => {
    promptNo += 1
    const text = e.text.trim()
    if (!text || text.startsWith('/') || !(await read($, autoConnectors))) return next(e)
    try {
      const rows = await refreshConnectors($)
      const names = rows.filter(r => r.kind === 'connector').map(r => r.name)
      if (names.length === 0) return next(e)
      const reply = await $.model.complete({
        model: 'haiku',
        maxTokens: 200,
        system: PICK_SYSTEM,
        prompt: `Connectors: ${names.join(', ')}\n\nRequest:\n${text.slice(0, 4000)}`,
      })
      if (!reply.isAnswered) return next(e)
      const needed = parsePick(reply.text)
      const recent = new Set([...lastUsed].filter(([, n]) => promptNo - n <= KEEP_FOR).map(([id]) => id))
      const { enable, disable } = plan(rows, needed, recent)
      for (const name of enable) await $.tool.call({ tool: SET_TOOL, connector: name, enabled: true } as never)
      for (const name of disable) await $.tool.call({ tool: SET_TOOL, connector: name, enabled: false } as never)
      if (enable.length || disable.length) {
        const summary = [enable.length && `on: ${enable.join(', ')}`, disable.length && `off: ${disable.join(', ')}`]
          .filter(Boolean)
          .join(' · ')
        await update($, lastSwitch, () => summary)
        await update($, connectors, list =>
          (list ?? []).map(r => ({ ...r, isOn: enable.includes(r.name) || (r.isOn && !disable.includes(r.name)) })),
        )
        $.ui.toast(`Connectors ${summary}`)
        if (enable.length) {
          const note = `Connectors just enabled for this request: ${enable.join(', ')}. Their tools may only appear next turn.`
          return next({ ...e, context: [...(e.context ?? []), note] })
        }
      }
    } catch (err) {
      $.ui.log(`home-dashboard: connector check skipped (${String(err)})`, { to: 'debug' })
    }

    return next(e)
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

    const isAuto = await read($, autoConnectors)
    const rowsNow = await read($, connectors)
    const switched = await read($, lastSwitch)
    const saved = await read($, handoff)

    const autoButton = (
      <Button
        key="auto-toggle"
        label={isAuto ? 'Auto: on' : 'Auto: off'}
        hotkey="a"
        variant={isAuto ? 'primary' : 'secondary'}
        onPress={() => setAuto($, !isAuto)}
      />
    )

    const connectorsCard = card(
      'Connectors',
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          {isAuto
            ? 'Before each prompt, Haiku picks the connectors it needs and the rest are switched off.'
            : 'Auto is off: connectors stay as you set them. Turn on here or with /auto-connectors on.'}
        </Text>
        {switched ? <Text>Last switch: {switched}</Text> : null}
        {!rowsNow ? (
          <Text dimColor>Reading connectors…</Text>
        ) : (
          <Box flexDirection="column">
            {rowsNow.map(r => (
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text wrap="truncate-end" dimColor={r.kind !== 'connector'}>
                  {r.kind === 'connector' ? (r.isOn ? '● ' : '○ ') : '· '}
                  {r.name}
                </Text>
                <Text dimColor>{r.kind === 'connector' ? (r.isOn ? 'on' : 'off') : 'local'}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>,
      autoButton,
    )

    const handoffCard = card(
      'Handoff',
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Saves a lean summary of this chat to handoffs/ so a new chat can pick up. Also: /handoff [focus]</Text>
        {saved ? <Text wrap="wrap">{saved}</Text> : null}
      </Box>,
      <Button key="handoff" label="Write" hotkey="h" onPress={() => void runHandoff($, '')} />,
    )

    return (
      <Box flexDirection="column" gap={1}>
        {usageCard}
        {topicsCard}
        {usedCard}
        {connectorsCard}
        {handoffCard}
      </Box>
    )
  })
}
