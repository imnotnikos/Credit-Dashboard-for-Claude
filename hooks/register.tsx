import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionRateLimit } from 'claude-code'

import type { DashboardRanked, DashboardRing, DashboardUsage } from '../types'
import { parseTranscript, summarize } from './stats'
import type { Transcript } from './stats'

const PANE = 'dashboard'
const TITLE = 'Dashboard'
const WEEK = 7 * 24 * 60 * 60 * 1000
const MAX_READ = 4 * 1024 * 1024
const REFRESH_MS = 2 * 60 * 1000

// Claude's warm palette: sand for the session ring, clay for the weekly one.
const SESSION_COLOR = '#E8A55A'
const WEEKLY_COLOR = '#D97757'

const usage = atom({ plugin: 'home-dashboard', key: 'usage' } as const, null)
const stats = atom({ plugin: 'home-dashboard', key: 'stats' } as const, null)
const range = atom({ plugin: 'home-dashboard', key: 'range' } as const, 'week')

const toRing = (windows: SessionRateLimit[], kind: string): DashboardRing => {
  const found = windows.find(one => one.kind === kind)

  return found ? { percent: found.percentUsed, resetsAt: found.resetsAt } : { percent: null }
}

const toUsage = (windows: SessionRateLimit[]): DashboardUsage => ({
  session: toRing(windows, 'five_hour'),
  weekly: toRing(windows, 'seven_day'),
})

// Parsed transcripts by path, kept while a file's size and mtime hold.
const cache = new Map<string, { key: string; transcript: Transcript }>()

const claudeDir = async ($: EngineInterface) => {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return home ? `${home}/.claude` : null
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
      if (now - file.mtimeMs > WEEK || file.size > MAX_READ) continue
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

  const next = summarize(transcripts, now)
  await update($, stats, () => next)
}

const refreshUsage = async ($: EngineInterface) => {
  const { rateLimits } = await $.session.usage()
  const next = toUsage(rateLimits)
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

const arc = (r: number, width: number, color: string, percent: number | null) => {
  const circumference = 2 * Math.PI * r
  const filled = (Math.min(100, Math.max(0, percent ?? 0)) / 100) * circumference
  const track = `<circle cx="100" cy="100" r="${r}" fill="none" stroke="${color}" stroke-opacity="0.22" stroke-width="${width}"/>`
  const bar =
    filled > 0
      ? `<circle cx="100" cy="100" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 100 100)"/>`
      : ''

  return track + bar
}

const rings = (value: DashboardUsage) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
  arc(84, 20, SESSION_COLOR, value.session.percent) +
  arc(58, 20, WEEKLY_COLOR, value.weekly.percent) +
  `<g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" font-weight="700" font-size="22" text-anchor="middle">` +
  `<text x="100" y="97" fill="${SESSION_COLOR}">${label(value.session)}</text>` +
  `<text x="100" y="122" fill="${WEEKLY_COLOR}">${label(value.weekly)}</text>` +
  `</g></svg>`

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
    if (e.changed.includes('rateLimits')) {
      const value = toUsage(e.rateLimits)
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
    const shown = await read($, range)

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

    const legend = (name: string, color: string, ring: DashboardRing) => (
      <Box flexDirection="row" gap={1}>
        <Text color={color}>●</Text>
        <Text>{name}</Text>
        <Text bold color={color}>{label(ring)}</Text>
        <Text dimColor>{untilReset(ring.resetsAt, now)}</Text>
      </Box>
    )

    const usageCard = card(
      'Credit usage',
      <Box flexDirection="column" alignItems="center" gap={1}>
        {Svg ? (
          <Svg
            source={rings(credit)}
            alt={`Session ${label(credit.session)} used, weekly ${label(credit.weekly)} used`}
            width={150}
            height={150}
          />
        ) : null}
        <Box flexDirection="column">
          {legend('Session', SESSION_COLOR, credit.session)}
          {legend('Weekly ', WEEKLY_COLOR, credit.weekly)}
        </Box>
      </Box>,
    )

    const toggle = (
      <Box flexDirection="row" gap={1}>
        <Button
          key="range-day"
          label="Day"
          hotkey="d"
          variant={shown === 'day' ? 'primary' : 'secondary'}
          onPress={() => update($, range, () => 'day')}
        />
        <Button
          key="range-week"
          label="Week"
          hotkey="w"
          variant={shown === 'week' ? 'primary' : 'secondary'}
          onPress={() => update($, range, () => 'week')}
        />
      </Box>
    )

    const topicsCard = card(
      'Main topics',
      rows(numbers?.topics[shown], shown === 'day' ? 'Nothing in the last 24 hours.' : 'Nothing in the last 7 days.'),
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
