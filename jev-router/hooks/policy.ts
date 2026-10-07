// Every routing knob and the pure policy, ported from jev-router's src/config.mjs and
// src/policy.mjs. Nothing here touches `$`, so the tests exercise it directly.

export type TierName = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type Tier = { name: TierName; id: string; family: string; effort: boolean }

/** Cheapest first. `family` recognises whatever version of a tier the session runs. */
export const TIERS: readonly Tier[] = [
  { name: 'haiku', id: 'claude-haiku-5-5', family: 'haiku', effort: true },
  { name: 'sonnet', id: 'claude-sonnet-5-5', family: 'sonnet', effort: true },
  { name: 'opus', id: 'claude-opus-5-5', family: 'opus', effort: true },
  { name: 'fable', id: 'claude-fable-5-1', family: 'fable', effort: true },
]

export const TIER_NAMES: readonly TierName[] = TIERS.map(t => t.name)

export const rankOf = (name: string) => TIER_NAMES.indexOf(name as TierName)

export const tierSpec = (name: TierName) => TIERS.find(t => t.name === name)!

/** Tier of a model id the engine resolved, or null for one we don't recognise. */
export const tierOf = (model: string): TierName | null =>
  TIERS.find(t => model.includes(t.family))?.name ?? null

export const availableTiers = (allowFable: boolean): TierName[] =>
  TIER_NAMES.filter(n => n !== 'fable' || allowFable)

export const THRESHOLDS = {
  /** Below this Jev confidence: never downgrade, cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  uncertainCeiling: 'sonnet' as TierName,
  /** A model switch re-caches the whole conversation; downgrades only pay off while it is small. */
  downgradeMaxContextTokens: 20_000,
  /** Hard wall-clock deadline for the Jev call (warm ~300ms, cold ~1s). */
  jevDeadlineMs: 3_000,
}

export const CONTEXT_WINDOW_TOKENS = 200_000

const COMPLEXITY_SCALE = [
  'None', 'Very low', 'Low', 'Some', 'Moderate',
  'Moderate to high', 'High', 'Very high', 'Severe', 'Extreme',
]

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1

const OVERRIDE_WORDS: Record<TierName, string> = {
  haiku: 'haiku|fast',
  sonnet: 'sonnet|balanced',
  opus: 'opus|strong',
  fable: 'fable|long',
}

/** Phrases that mean "the human already decided", checked against the raw prompt. */
const OVERRIDE_PATTERNS = TIERS.map(t => ({
  tier: t.name,
  re: new RegExp(`\\b(?:use|switch to|with|on)\\s+(?:${OVERRIDE_WORDS[t.name]})\\b`, 'i'),
}))

export function detectOverride(prompt: string): TierName | null {
  return OVERRIDE_PATTERNS.find(p => p.re.test(prompt))?.tier ?? null
}

const score = (instructions: string) => ({ type: 'score', instructions, criteria: COMPLEXITY_SCALE })

const GUIDANCE: Record<TierName, { what: string; signals: string[]; not_for: string }> = {
  haiku: {
    what: 'Trivial, mechanical, or purely factual work.',
    signals: ['Rename, reformat, comment, or run one obvious command'],
    not_for: 'Design judgement or multi-file reasoning.',
  },
  sonnet: {
    what: 'Ordinary day-to-day engineering with a clear, bounded shape.',
    signals: ['Implement a specified function, test existing behaviour, or fix an understood local bug'],
    not_for: 'Open-ended architecture, subtle concurrency, or unknown-cause debugging.',
  },
  opus: {
    what: 'Hard reasoning, ambiguity, or high blast radius.',
    signals: ['Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations'],
    not_for: 'Routine work with a clear implementation.',
  },
  fable: {
    what: 'Very large or long-running work beyond a normal focused session.',
    signals: ['Whole-repo migration, unusually large context, or multi-hour autonomous execution'],
    not_for: 'Anything a strong model can finish in one focused session.',
  },
}

/** The System One request body, in the wire shape the TypeSafe SDK's score()/choice() build. */
export function jevRequest(prompt: string, current: TierName, contextTokens: number, tiers: TierName[]) {
  return {
    model: 'jev-latest',
    state: {
      request: prompt,
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: tiers },
    },
    questions: {
      task_complexity: score('How complex is the coding task overall, including ambiguity, scope, and blast radius?'),
      reasoning_required: score('How much reasoning is required to complete the request correctly in one pass?'),
      tool_complexity: score('How complex is the tool use required, from no tools to many coordinated or stateful operations?'),
      model: {
        type: 'choice',
        instructions: [
          'Pick the cheapest model that can fully complete this coding request in one pass, without retrying on a stronger model.',
          'Judge required reasoning, not requested reply length.',
        ],
        criteria: Object.fromEntries(
          tiers.map(name => [name, { model: tierSpec(name).id, ...GUIDANCE[name] }]),
        ),
      },
    },
  }
}

export type JevAnswer = {
  choice: string
  confidence: number
  metrics: { taskComplexity: number; reasoningRequired: number; toolComplexity: number; contextSize: number }
}

/** Reads a System One response; null when it lacks what the policy needs. */
export function parseJev(body: unknown, contextTokens: number): JevAnswer | null {
  const a = (body as { answers?: Record<string, { choice?: unknown; confidence?: unknown; score?: unknown }> })?.answers
  if (typeof a?.model?.choice !== 'string') return null
  const norm = (k: string) => Number(a[k]?.score) / COMPLEXITY_MAX_SCORE
  return {
    choice: a.model.choice,
    confidence: Number(a.model.confidence ?? 0),
    metrics: {
      taskComplexity: norm('task_complexity'),
      reasoningRequired: norm('reasoning_required'),
      toolComplexity: norm('tool_complexity'),
      contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
    },
  }
}

/** Nearest runnable tier: steps up rather than down, never up into fable unless asked for. */
function clampToAvailable(tier: TierName, available: TierName[]): TierName | null {
  if (available.includes(tier)) return tier
  const rank = rankOf(tier)
  const up = TIER_NAMES.filter((t, i) => i > rank && available.includes(t) && (t !== 'fable' || tier === 'fable'))
  if (up.length) return up[0]!
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t))
  return down.at(-1) ?? null
}

export type Decision = { tier: TierName; reason: string; changed: boolean }

/** Pure and total: any missing or unusable input keeps the current tier. */
export function decide(input: {
  prompt: string
  jev: JevAnswer | null
  current: TierName
  available: TierName[]
  contextTokens: number
}): Decision {
  const { prompt, jev, current, available, contextTokens } = input
  const settle = (tier: TierName, reason: string): Decision => {
    const final = clampToAvailable(tier, available) ?? current
    const why = final === tier ? reason : `${reason}+unavailable`
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current }
  }

  const override = detectOverride(prompt)
  if (override) return settle(override, 'override')

  if (!jev || !TIER_NAMES.includes(jev.choice as TierName)) return settle(current, 'jev-unavailable')
  const target = jev.choice as TierName

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, 'low-confidence-no-downgrade')
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling))
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling]!, 'low-confidence-capped')
  }

  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, 'downgrade-not-worth-cache-rebuild')
  }

  return settle(target, 'jev')
}

export type Record_ = {
  prompt: string
  current: TierName
  contextTokens: number
  jev: JevAnswer | null
  decision: Decision
  model: string
  ms: number
  error?: string
}

const WIDTH = 33
const row = (text = '') => `│ ${text.slice(0, WIDTH - 2).padEnd(WIDTH - 2)} │`
const metric = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const wrapped = (label: string, value: string) => {
  const lines: string[] = []
  for (const word of `${label}${value}`.replace(/\s+/g, ' ').trim().split(' ')) {
    if (!lines.length || `${lines.at(-1)} ${word}`.length > WIDTH - 2) lines.push(word)
    else lines[lines.length - 1] += ` ${word}`
  }
  return lines.slice(0, 4).map(row)
}

const reasonText = (reason: string) => {
  if (reason.includes('override')) return 'prompt override'
  if (reason.includes('jev-unavailable')) return 'Jev unavailable; held'
  if (reason.includes('low-confidence-no-downgrade')) return 'low confidence; held'
  if (reason.includes('low-confidence-capped')) return 'low confidence; capped'
  if (reason.includes('cache-rebuild')) return 'cache rebuild avoided'
  if (reason.includes('unavailable')) return 'nearest available tier'
  return 'Jev recommendation'
}

/** The /jev explain box, rendered from what was saved when routing happened. */
export function formatExplanation(r: Record_ | undefined): string {
  if (!r) return 'Jev Router: no routing decision has been recorded for this session.'
  const m = r.jev?.metrics
  return [
    `┌${'─'.repeat(WIDTH)}┐`,
    row('Jev Router'),
    row(),
    row('Jev request'),
    ...wrapped('Prompt: ', r.prompt || '(empty)'),
    row(`Current tier: ${r.current.toUpperCase()}`),
    row(`Context tokens: ${r.contextTokens}`),
    row(),
    row(`Jev response (${r.ms} ms)`),
    row(`Task complexity     ${metric(m?.taskComplexity)}`),
    row(`Reasoning required  ${metric(m?.reasoningRequired)}`),
    row(`Tool complexity     ${metric(m?.toolComplexity)}`),
    row(`Context size        ${metric(m?.contextSize)}`),
    row(),
    row(`Recommended tier: ${(r.jev?.choice ?? 'none').toUpperCase()}`),
    row(`Selected model: ${r.model}`),
    row(),
    row(`Confidence: ${r.jev ? `${Math.round(r.jev.confidence * 100)}%` : 'n/a'}`),
    row(`Decision: ${reasonText(r.decision.reason)}`),
    ...(r.error ? [row(`Error: ${r.error}`)] : []),
    `└${'─'.repeat(WIDTH)}┘`,
  ].join('\n')
}

/** Reads KEY=value lines; the first key of `names` present wins. */
export function keyFromEnvFile(text: string, names: readonly string[]): string | undefined {
  const vars = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) vars.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2'))
  }
  return names.map(n => vars.get(n)).find(v => v)
}

/** The /jev help text. */
export function helpText(allowFable: boolean): string {
  const tiers = TIERS.filter(t => t.name !== 'fable' || allowFable)
    .map(t => `  ${t.name.padEnd(7)} ${t.id}`)
    .join('\n')
  return [
    'Jev Router: Jev picks the model for each prompt.',
    '',
    'Commands',
    '  /jev            explain the last routing decision',
    '  /jev explain    same',
    '  /jev history    the last 20 decisions',
    '  /jev on         turn routing on (also re-reads the API key)',
    '  /jev off        turn routing off; turns run on the session model',
    '  /jev help       this text',
    '',
    'Tiers',
    tiers,
    allowFable ? '' : '  (fable is off: enable "Allow Fable" in /config)',
    '',
    'Ask for a tier yourself: "use haiku ...", "switch to opus ...", "with strong ...".',
    '(fast = haiku, balanced = sonnet, strong = opus, long = fable.) Jev is skipped.',
    '',
    'Rules',
    `  - Jev is asked once per prompt; the model is kept for the turn's tool calls.`,
    `  - Jev failing or timing out (${THRESHOLDS.jevDeadlineMs / 1000} s) keeps the current model.`,
    `  - Confidence below ${THRESHOLDS.minConfidence}: no downgrade, upgrades stop at ${THRESHOLDS.uncertainCeiling}.`,
    `  - No downgrade past ${THRESHOLDS.downgradeMaxContextTokens.toLocaleString('en-US')} context tokens (it would re-cache the conversation).`,
    '  - Picking a model with /model pauses routing; /jev on resumes it.',
    '  - Subagents are not routed.',
    '',
    'Status line: "⚡ haiku p=0.92" is the tier and Jev\'s confidence. "⏸" means paused.',
    'API key: /config, else JEV_API_KEY / TYPESAFE_API_KEY / TYPESAVEAI_KEY, the project .env, ~/.jev-router.env.',
  ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n')
}
