import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Usage } from '../types'
import { meter, resets } from './fmt'

const isOn = atom({ plugin: 'context-bar', key: 'isOn' } as const, false)
const usage = atom({ plugin: 'context-bar', key: 'usage' } as const, null)

// The plain usage() call is free: the status line's figures, rate limits from the last API response.
const refresh = async ($: EngineInterface) => {
  if (!(await read($, isOn))) return
  const u = await $.session.usage()
  const five = u.rateLimits.find(r => r.kind === 'five_hour')
  const next: Usage = {
    ctx: u.context.percent ?? null,
    fiveHour: five ? { percent: five.percentUsed, resetsAt: five.resetsAt ? Date.parse(five.resetsAt) : null } : null,
  }
  await update($, usage, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'context-bar', description: 'Toggle the context and 5-hour limit bar above the prompt' })
    const ran = await next(e)
    void refresh($)
    return ran
  })

  on('command.run', { command: 'context-bar' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)
    if (now) await refresh($)
    return { text: `Context bar ${now ? 'on' : 'off'}.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    void refresh($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    return ran
  })

  on('session.compact', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || !u || !(await read($, isOn))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const w = Math.max(5, Math.min(20, Math.floor(e.props.bodyColumns / 5)))
    const now = await $.clock.now()

    const gauge = (label: string, percent: number | null) => {
      if (percent === null) return <Text dimColor>{label} —</Text>
      const [full, empty] = meter(percent, w)
      return (
        <Text>
          {label} {full}<Text dimColor>{empty}</Text> {Math.round(percent)}%
        </Text>
      )
    }

    return (
      <Box>
        <Text wrap="truncate">
          {gauge('Context', u.ctx)}
          {'   '}
          {gauge('5h limit', u.fiveHour?.percent ?? null)}
          {u.fiveHour?.resetsAt != null && <Text dimColor> · resets {resets(u.fiveHour.resetsAt, now)}</Text>}
        </Text>
      </Box>
    )
  })
}
