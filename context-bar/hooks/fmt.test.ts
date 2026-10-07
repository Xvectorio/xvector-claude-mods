import { expect, test } from 'claude-code/testing'

import { meter, resets } from './fmt'

test('meter and reset text', async () => {
  expect(meter(50, 10)).toEqual(['█████', '░░░░░'])
  expect(meter(130, 4)).toEqual(['████', ''])
  const at = new Date(2026, 9, 5, 20, 40).getTime()
  expect(resets(at, at - 160 * 60000)).toBe('20:40 (in 2h 40m)')
  expect(resets(at, at - 5 * 60000)).toBe('20:40 (in 5m)')
  expect(resets(at, at + 60000)).toBe('20:40 (in 0m)')
})
