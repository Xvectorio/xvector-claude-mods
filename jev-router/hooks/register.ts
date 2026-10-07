import type { EngineInterface, Register } from 'claude-code'
import {
  THRESHOLDS,
  availableTiers,
  decide,
  detectOverride,
  formatExplanation,
  helpText,
  jevRequest,
  keyFromEnvFile,
  parseJev,
  tierOf,
  tierSpec,
  type JevAnswer,
  type Record_,
  type TierName,
} from './policy'

// The jev-router launcher put a loopback proxy in front of Claude Code to rewrite the
// request's model. A mod rewrites it at `turn.step` instead: Jev is asked once, on the first
// request of a fresh user turn, and that model is pinned for the turn's tool loop. Subagents
// keep their own models.

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const KEY_NAMES = ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAVEAI_KEY'] as const
const HISTORY = 20

/** What the module keeps for the session; reset when the module reloads. */
type State = {
  allowFable: boolean
  configuredKey: string | undefined
  routing: boolean
  apiKey: string | null | undefined // undefined: not looked up yet; null: none found
  lastModel: string | undefined // what the previous routed turn ran on
  contextTokens: number
  turnText: Map<string, string>
  pinned: Map<string, string>
  history: Record_[]
}

async function findKey($: EngineInterface, s: State): Promise<string | null> {
  if (s.apiKey !== undefined) return s.apiKey
  const fromEnv =
    (await $.env.get('JEV_API_KEY')) ??
    (await $.env.get('TYPESAFE_API_KEY')) ??
    (await $.env.get('TYPESAVEAI_KEY'))
  let found = s.configuredKey || fromEnv
  // Same precedence as jev-router: environment, then the project's .env, then ~/.jev-router.env.
  const home = await $.env.get('HOME')
  for (const file of [`${await $.session.root()}/.env`, home && `${home}/.jev-router.env`]) {
    if (found || !file) break
    try {
      found = keyFromEnvFile(await $.fs.read(file), KEY_NAMES)
    } catch {
      // missing or unreadable: try the next one
    }
  }
  s.apiKey = found || null
  return s.apiKey
}

async function askJev($: EngineInterface, s: State, key: string, prompt: string, current: TierName, tiers: TierName[]) {
  const stop = new AbortController()
  const deadline = $.clock
    .sleep(THRESHOLDS.jevDeadlineMs, { signal: stop.signal })
    .then(() => 'timeout' as const, () => 'cancelled' as const)
  try {
    const res = await Promise.race([
      $.http.fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(jevRequest(prompt, current, s.contextTokens, tiers)),
      }),
      deadline,
    ])
    if (typeof res === 'string') throw new Error(`Jev ${res} after ${THRESHOLDS.jevDeadlineMs} ms`)
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}`)
    const answer = parseJev(JSON.parse(res.text), s.contextTokens)
    if (!answer) throw new Error('Jev response had no model answer')
    return answer
  } finally {
    stop.abort()
  }
}

/** Picks the model for a fresh turn. Fail-open: any failure keeps the current model. */
async function route($: EngineInterface, s: State, prompt: string, sessionModel: string): Promise<string> {
  const currentModel = s.lastModel ?? sessionModel
  const current = tierOf(currentModel) ?? 'opus'
  const available = availableTiers(s.allowFable)
  // Keep the session's exact id (a [1m] variant, an older version) when its tier is chosen.
  const modelFor = (tier: TierName) =>
    tierOf(currentModel) === tier ? currentModel : tierOf(sessionModel) === tier ? sessionModel : tierSpec(tier).id

  const started = await $.clock.now()
  let jev: JevAnswer | null = null
  let error: string | undefined
  if (!detectOverride(prompt)) {
    const key = await findKey($, s)
    if (!key) error = 'no API key (set JEV_API_KEY or /config)'
    else {
      try {
        jev = await askJev($, s, key, prompt, current, available)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }
  }
  const decision = decide({ prompt, jev, current, available, contextTokens: s.contextTokens })
  const model = modelFor(decision.tier)
  const ms = (await $.clock.now()) - started

  s.history.push({ prompt, current, contextTokens: s.contextTokens, jev, decision, model, ms, error })
  if (s.history.length > HISTORY) s.history.shift()

  const p = jev ? ` p=${jev.confidence.toFixed(2)}` : ''
  $.ui.status(`⚡ ${decision.tier}${p}${error ? ' (held)' : ''}`)
  return model
}


export const register: Register = (on, options) => {
  const s: State = {
    allowFable: options.allowFable === true,
    configuredKey: (options.apiKey as string | undefined) || undefined,
    routing: options.routeOnStart !== false,
    apiKey: undefined,
    lastModel: undefined,
    contextTokens: 0,
    turnText: new Map(),
    pinned: new Map(),
    history: [],
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev',
      description: 'Jev Router: explain the last routing decision, or turn routing on / off',
      argumentHint: '[on|off|explain|history|help]',
      immediate: true,
    })
    $.ui.status(s.routing ? '⚡ jev' : '⏸ jev off')
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    s.turnText.set(e.turnId, e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !s.routing) return yield* next(e)

    let model = s.pinned.get(e.turnId)
    if (model === undefined) {
      const text = s.turnText.get(e.turnId)
      s.turnText.delete(e.turnId)
      if (e.index !== 0 || text === undefined) return yield* next(e) // began before routing was on
      // A turn with no typed prompt (a continuation) stays on the model the last turn chose.
      model = text.trim() ? await route($, s, text, e.model) : (s.lastModel ?? e.model)
      s.pinned.set(e.turnId, model)
      s.lastModel = model
    }

    const tier = tierOf(model)
    const step =
      model === e.model
        ? e
        : { ...e, model, ...(tier && !tierSpec(tier).effort ? { effort: undefined } : {}) }
    const result = yield* next(step)
    if (result.usage) {
      const u = result.usage
      s.contextTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
    }
    return result
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) s.pinned.delete(e.turnId)
    return next(e)
  })

  // Picking a model yourself pauses routing, as choosing another row in jev-router's picker did.
  on('classic.PostModelSwitch', ($, e, next) => {
    if (s.routing && (e.source === 'command' || e.source === 'picker')) {
      s.routing = false
      s.lastModel = undefined
      $.ui.status(`⏸ manual ${e.to_model}`)
      $.ui.toast('Jev routing paused for your model choice. /jev on resumes it.')
    }
    return next(e)
  })

  on('command.run', { command: 'jev' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on') {
      s.routing = true
      s.lastModel = undefined
      s.apiKey = undefined // look again, in case a key was added since
      const key = await findKey($, s)
      $.ui.status('⚡ jev')
      return { text: key ? 'Jev routing on.' : 'Jev routing on, but no API key was found: every turn stays on the current model.' }
    }
    if (arg === 'off') {
      s.routing = false
      $.ui.status('⏸ jev off')
      return { text: `Jev routing off. Turns run on ${await $.session.model()}.` }
    }
    if (arg === 'history') {
      if (!s.history.length) return { text: 'Jev Router: no routing decisions yet.' }
      return {
        text: s.history
          .map(r => `${r.decision.tier.padEnd(6)} ${(r.jev ? r.jev.confidence.toFixed(2) : ' n/a').padStart(4)}  ${r.decision.reason.padEnd(30)} ${r.prompt.replace(/\s+/g, ' ').slice(0, 50)}`)
          .join('\n'),
      }
    }
    if (arg === '' || arg === 'explain') {
      const state = s.routing ? '' : 'Routing is off (/jev on resumes it).\n'
      return { text: state + formatExplanation(s.history.at(-1)) }
    }
    // Anything else: /jev help, or a word we don't know. The help names the commands.
    return { text: (arg === 'help' ? '' : `Unknown argument "${arg.slice(0, 30)}".\n\n`) + helpText(s.allowFable) }
  })
}
