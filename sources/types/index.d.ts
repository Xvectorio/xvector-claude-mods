export type Level = 'managed' | 'user' | 'memory' | 'project' | 'nested'
export type Instr = { path: string; level: Level; trigger: string | null }
export type Answer = { id: number; prompt: string; instr: string[]; reads: string[] }
export type Clash = { fileA: string; ruleA: string; fileB: string; ruleB: string }
export type Check = { sig: string; status: 'checking' | 'done' | 'failed'; clashes: Clash[] }

declare module 'claude-code' {
  interface PluginState {
    sources: {
      instr: Record<string, Instr>
      answers: Answer[]
      check: Check | null
      open: number[]
    }
  }
}
