export type DashboardRing = { percent: number | null; resetsAt?: string; detail?: string }
export type DashboardUsage = { session: DashboardRing; weekly: DashboardRing; context: DashboardRing }
export type DashboardRanked = { name: string; count: number }
export type DashboardStats = {
  topics: { day: DashboardRanked[]; week: DashboardRanked[]; month: DashboardRanked[] }
  plugins: DashboardRanked[]
  connectors: DashboardRanked[]
  skills: DashboardRanked[]
}
export type DashboardRange = 'day' | 'week' | 'month'
export type DashboardMeter = 'session' | 'weekly' | 'context'
export type DashboardView = 'rings' | 'bars'
export type DashboardConnector = { name: string; id?: string; kind: string; isOn: boolean }

declare module 'claude-code' {
  interface PluginState {
    'home-dashboard': {
      usage: DashboardUsage | null
      stats: DashboardStats | null
      range: DashboardRange
      view: DashboardView
      hidden: DashboardMeter[]
      autoConnectors: boolean
      connectors: DashboardConnector[] | null
      lastSwitch: string | null
      handoff: string | null
    }
  }
}
