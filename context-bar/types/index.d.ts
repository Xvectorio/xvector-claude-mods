export type Usage = { ctx: number | null; fiveHour: { percent: number; resetsAt: number | null } | null }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { isOn: boolean; usage: Usage | null }
  }
}
