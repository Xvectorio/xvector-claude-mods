import { expect, test } from 'claude-code/testing'

import { levelOf, parseClashes, shortPath, sortInstr } from './logic'

test('levels, order and paths', async () => {
  expect(levelOf('Project', '/r/CLAUDE.md', '/r')).toBe('project')
  expect(levelOf('Project', '/r/.claude/CLAUDE.md', '/r/sub')).toBe('project')
  expect(levelOf('Project', '/r/pkg/CLAUDE.md', '/r')).toBe('nested')
  expect(levelOf('User', '/h/.claude/CLAUDE.md', '/r')).toBe('user')
  const sorted = sortInstr([
    { path: 'n', level: 'nested', trigger: 'x' },
    { path: 'p', level: 'project', trigger: null },
    { path: 'u', level: 'user', trigger: null },
  ])
  expect(sorted.map(s => s.level)).toEqual(['user', 'project', 'nested'])
  expect(shortPath('/r/a/b.ts', '/r', '/h')).toBe('a/b.ts')
  expect(shortPath('/h/x.md', '/r', '/h')).toBe('~/x.md')
})

test('clash parsing keeps only real pairs of known files', async () => {
  const known = ['/a.md', '/b.md']
  const text = `Here: [{"fileA":"/a.md","ruleA":"use tabs","fileB":"/b.md","ruleB":"use spaces"},
    {"fileA":"/a.md","ruleA":"x","fileB":"/a.md","ruleB":"y"},
    {"fileA":"/z.md","ruleA":"x","fileB":"/b.md","ruleB":"y"},
    {"fileA":"/a.md","ruleA":"","fileB":"/b.md","ruleB":"y"}]`
  expect(parseClashes(text, known)).toEqual([{ fileA: '/a.md', ruleA: 'use tabs', fileB: '/b.md', ruleB: 'use spaces' }])
  expect(parseClashes('[]', known)).toEqual([])
  expect(() => parseClashes('none', known)).toThrow()
})
