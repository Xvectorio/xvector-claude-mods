export const meter = (percent: number, width: number) => {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
  return ['█'.repeat(filled), '░'.repeat(width - filled)] as const
}

// "20:40 (in 2h 40m)"; the clock time is local, which hooks get.
export const resets = (at: number, now: number) => {
  const d = new Date(at)
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const mins = Math.max(0, Math.round((at - now) / 60000))
  const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
  return `${clock} (in ${left})`
}
