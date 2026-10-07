import type { Clash, Instr, Level } from '../types'

export const ORDER: Level[] = ['managed', 'user', 'memory', 'project', 'nested']

export const sortInstr = (list: Instr[]) =>
  [...list].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level) || a.path.localeCompare(b.path))

// A memory file's /context label to a level; a Project file outside cwd's own line of folders was loaded nested.
export const levelOf = (type: string, path: string, cwd: string): Level => {
  if (type === 'Managed') return 'managed'
  if (type === 'User') return 'user'
  if (type === 'AutoMem') return 'memory'
  const dir = path.slice(0, path.lastIndexOf('/'))
  const dirClaude = dir.endsWith('/.claude') ? dir.slice(0, -8) : dir
  return cwd === dirClaude || cwd.startsWith(dirClaude + '/') ? 'project' : 'nested'
}

export const shortPath = (p: string, cwd: string, home: string) =>
  p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : home && p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p

// Keeps only well-formed clashes between two different known files; anything else the model said is dropped.
export const parseClashes = (text: string, known: string[]): Clash[] => {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('no JSON array in reply')
  const raw: unknown = JSON.parse(text.slice(start, end + 1))
  if (!Array.isArray(raw)) throw new Error('reply is not an array')
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return raw
    .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    .map(r => ({ fileA: str(r.fileA), ruleA: str(r.ruleA), fileB: str(r.fileB), ruleB: str(r.ruleB) }))
    .filter(c => known.includes(c.fileA) && known.includes(c.fileB) && c.fileA !== c.fileB && c.ruleA && c.ruleB)
}
