import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { decide, detectOverride, keyFromEnvFile, parseJev } from '../hooks/policy'

const jevSays = (choice: string, confidence: number) =>
  JSON.stringify({
    answers: {
      model: { choice, confidence },
      task_complexity: { score: 3 },
      reasoning_required: { score: 2 },
      tool_complexity: { score: 1 },
    },
  })

/** The engine beneath the plugin: a session on Opus, Jev answering `reply`, every step recorded. */
function world(on: On, reply: () => { status: number; text: string }) {
  const steps: { index: number; model: string; effort?: unknown }[] = []
  const jevBodies: string[] = []
  mock.clock(on)
  mock.env(on, { JEV_API_KEY: 'test-key' })
  on('session.root', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('http.fetch', (_$, e) => {
    jevBodies.push(e.init?.body ?? '')
    const r = reply()
    return { value: { status: r.status, ok: r.status < 300, headers: {}, text: r.text } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    steps.push({ index: e.index, model: e.model, effort: e.effort })
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  })
  return { steps, jevBodies }
}

async function runTurn($: Engine, turnId: string, text: string, stepsInTurn = 2) {
  await $.turn.start({ text, turnId })
  for (let index = 0; index < stepsInTurn; index++) {
    const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 + index })
    for await (const _ of stream) { /* drain */ }
  }
}

describe('policy', () => {
  test('explicit requests win', () => {
    expect(detectOverride('please use haiku for this')).toBe('haiku')
    expect(detectOverride('switch to strong and fix it')).toBe('opus')
    expect(detectOverride('the haiku poem is nice')).toBe(null)
  })

  test('low confidence never downgrades', () => {
    const jev = parseJev(JSON.parse(jevSays('haiku', 0.1)), 0)
    const d = decide({ prompt: 'x', jev, current: 'opus', available: ['haiku', 'sonnet', 'opus'], contextTokens: 0 })
    expect(d).toEqual({ tier: 'opus', reason: 'low-confidence-no-downgrade/no-change', changed: false })
  })

  test('large conversations refuse downgrades', () => {
    const jev = parseJev(JSON.parse(jevSays('haiku', 0.9)), 50_000)
    const d = decide({ prompt: 'x', jev, current: 'opus', available: ['haiku', 'sonnet', 'opus'], contextTokens: 50_000 })
    expect(d.reason).toBe('downgrade-not-worth-cache-rebuild/no-change')
  })

  test('fable steps down to the nearest tier when not allowed', () => {
    const jev = parseJev(JSON.parse(jevSays('fable', 0.9)), 0)
    const d = decide({ prompt: 'x', jev, current: 'sonnet', available: ['haiku', 'sonnet', 'opus'], contextTokens: 0 })
    expect(d.tier).toBe('opus')
  })

  test('reads keys from an env file', () => {
    expect(keyFromEnvFile('FOO=1\nexport TYPESAVEAI_KEY="abc"\n', ['JEV_API_KEY', 'TYPESAVEAI_KEY'])).toBe('abc')
  })
})

describe('routing', () => {
  test('a simple prompt runs the whole turn on haiku, keeping effort', async ($, on) => {
    const { steps, jevBodies } = world(on, () => ({ status: 200, text: jevSays('haiku', 0.95) }))
    await runTurn($, 't1', 'rename foo to bar in utils.js')
    expect(jevBodies.length).toBe(1) // asked once per turn, not per step
    expect(steps.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
    expect(steps[0]!.effort).toBe('high')
    expect(JSON.parse(jevBodies[0]!).state.request).toBe('rename foo to bar in utils.js')
  })

  test('Jev failing keeps the current model', async ($, on) => {
    const { steps } = world(on, () => ({ status: 500, text: 'down' }))
    await runTurn($, 't1', 'refactor the scheduler')
    expect(steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  })

  test('an explicit request skips Jev', async ($, on) => {
    const { steps, jevBodies } = world(on, () => ({ status: 200, text: jevSays('haiku', 0.95) }))
    await runTurn($, 't1', 'use sonnet: add a test for parseDate', 1)
    expect(jevBodies.length).toBe(0)
    expect(steps[0]!.model).toBe('claude-sonnet-5-5')
  })

  test('/jev off leaves turns alone, /jev explains the last decision', async ($, on) => {
    const { steps, jevBodies } = world(on, () => ({ status: 200, text: jevSays('haiku', 0.95) }))
    const presentation = { layout: 'main', columns: 100 } as never
    const origin = { kind: 'composer' } as never
    await runTurn($, 't1', 'rename foo', 1)
    const explained = await $.command.run({ command: 'jev', args: '', origin, presentation })
    expect(explained.text).toContain('Recommended tier: HAIKU')
    await $.command.run({ command: 'jev', args: 'off', origin, presentation })
    await runTurn($, 't2', 'rename bar', 1)
    expect(jevBodies.length).toBe(1)
    expect(steps.at(-1)!.model).toBe('claude-opus-5-5')
  })

  test('/jev help lists the commands; an unknown word gets the help too', async ($, on) => {
    world(on, () => ({ status: 200, text: jevSays('haiku', 0.95) }))
    const presentation = { layout: 'main', columns: 100 } as never
    const origin = { kind: 'composer' } as never
    const help = await $.command.run({ command: 'jev', args: 'help', origin, presentation })
    expect(help.text).toContain('/jev history')
    expect(help.text).toContain('claude-haiku-5-5')
    expect(help.text).not.toContain('claude-fable-5-1') // fable is off by default
    const unknown = await $.command.run({ command: 'jev', args: 'create a commit message', origin, presentation })
    expect(unknown.text).toContain('Unknown argument')
    expect(unknown.text).toContain('/jev off')
  })
})
