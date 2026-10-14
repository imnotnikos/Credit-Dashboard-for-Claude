export type DashboardRing = { percent: number | null; resetsAt?: string }
export type DashboardUsage = { session: DashboardRing; weekly: DashboardRing }
export type DashboardRanked = { name: string; count: number }
export type DashboardStats = {
  topics: { day: DashboardRanked[]; week: DashboardRanked[] }
  plugins: DashboardRanked[]
  connectors: DashboardRanked[]
  skills: DashboardRanked[]
}
export type DashboardRange = 'day' | 'week'

declare module 'claude-code' {
  interface PluginState {
    'home-dashboard': {
      usage: DashboardUsage | null
      stats: DashboardStats | null
      range: DashboardRange
    }
  }
}
