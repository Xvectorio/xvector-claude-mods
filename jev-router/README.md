# jev-router

Per-prompt model routing for Claude Code. [TypeSafe Jev](https://docs.typesafe.ai) reads each
prompt and picks the cheapest Claude model that can do the job: Haiku for mechanical work,
Sonnet for ordinary engineering, Opus for hard reasoning. A rebuild of
[gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) as a Claude Code mod: no
proxy, no wrapper command, the model is swapped inside the session.

## Install and load

```
/plugin marketplace add Xvectorio/xvector-claude-mods
/plugin install jev-router@jelcke-mods
```

Or try a checkout for one session: `claude --plugin-dir ./jev-router`.

## API key

The first of these that is set wins:

1. the plugin's **API key** option in `/config`
2. `JEV_API_KEY`, `TYPESAFE_API_KEY` or `TYPESAVEAI_KEY` in the environment
3. the same names in the project's `.env`
4. `~/.jev-router.env`

Without a key nothing breaks: every turn stays on the session's model and `/jev` shows why.

### Local, no key: clev

clev runs Cloudflare's [clef-flash](https://huggingface.co/Cloudflare/clef-flash), a
SystemOne-compatible model, on your own GPU (about 20 GB VRAM). Start it with `uv run server.py`
and set the **Endpoint** option to `http://127.0.0.1:8787/v1/systemone`: no API key is needed,
and prompts stay on your machine.

> **Privacy:** each prompt you type is sent to the endpoint (TypeSafe by default) so Jev can score it. Nothing else is.

## Using it

Routing is on from session start (turn it off by default with the **Route from session start**
option). The status line shows the last choice:

```
⚡ haiku p=0.92     routed to Haiku, Jev's confidence 0.92
⏸ manual <model>    paused because you picked a model with /model
⏸ jev off           paused with /jev off
```

| Command | Does |
| --- | --- |
| `/jev` or `/jev explain` | Box with the last decision: prompt, complexity scores, recommended tier, model, reason |
| `/jev history` | The last 20 decisions, one line each |
| `/jev on` / `/jev off` | Resume / pause routing (also re-reads the API key) |
| `/jev help` | Commands, tiers, rules |

`/jev` is a command, not a prompt: `/jev fix the bug` does not route anything. Send the request
as a normal prompt.

Name a tier yourself and Jev is skipped: `use haiku ...`, `switch to opus ...`, `with sonnet ...`
(`fast`, `balanced`, `strong` and `long` work as aliases for haiku, sonnet, opus and fable).

## Tiers

| Tier | Model | Used for |
| --- | --- | --- |
| haiku | `claude-haiku-5-5` | Trivial, mechanical, factual |
| sonnet | `claude-sonnet-5-5` | Ordinary, well-bounded engineering |
| opus | `claude-opus-5-5` | Hard reasoning, ambiguity, high blast radius |
| fable | `claude-fable-5-1` | Very large or long-running work. Off by default: it bills extra usage credits (**Allow Fable** option) |

## Rules

- Jev is asked once per prompt. The chosen model is kept for that turn's tool calls.
- Jev failing, an error, or no answer within 3 s keeps the current model. Routing never blocks a prompt.
- Confidence below 0.3: never downgrade, and upgrades stop at Sonnet.
- No downgrade while the prompt cache is warm and the conversation is past 20,000 tokens: caches
  are per model, so switching re-caches the whole conversation, which costs more than the cheaper
  model saves. After `/clear`, or once the cache has lapsed from sitting idle for an hour, there is
  nothing to lose and the downgrade goes ahead.
- A tier that isn't available is replaced by the nearest one above it (never Fable unless allowed).
- If the chosen tier is the one the session already runs, the session's exact model id is kept.
- Subagents keep their own models.
- Picking a model with `/model` pauses routing; `/jev on` resumes it. Pausing and resuming last
  until you restart Claude Code.

## Options (`/config`)

| Option | Default | |
| --- | --- | --- |
| API key | none | See *API key* |
| Endpoint | TypeSafe | SystemOne URL, e.g. a local clev server |
| Allow Fable | off | Let Jev route to Fable |
| Route from session start | on | Off: start paused and use `/jev on` |

## How it differs from jev-router

| jev-router | This mod |
| --- | --- |
| Loopback proxy and `jev-claude` launcher, `ANTHROPIC_BASE_URL` | A `turn.step` hook rewrites the model on each request |
| "Jev Router" row in `/model` | `/jev on` and `/jev off` |
| Injected status-line script | The plugin status line |
| `/jev-explain` skill | `/jev` |
| Codex support | Claude Code only |
| TypeSafe SDK | The same HTTP API, called through `$.http.fetch` |

## Files

```
.claude-plugin/plugin.json   manifest and options
hooks/register.ts            events: turn.start, turn.step, turn.complete, /jev, model-switch pause
hooks/policy.ts              tiers, Jev request and response, decision rules, help and explain text
tests/router.test.ts         claude plugin test .
```

## Troubleshooting

Run `claude --debug --plugin-dir ./jev-router`, or add `--debug-file <path>`. Without
`--debug-file`, the log is `~/.claude/debug/<session>.txt` (the newest file; `latest` points at
it), not stderr. Search it for `jev-router`:

- `$.http.fetch (jev-router): 200 in 277ms` followed by `$.ui.status (jev-router): ⚡ haiku`: the
  Jev call worked.
- `dispatching to firstParty model=claude-haiku-5-5` with `source=repl_main_thread`: the request
  really went out on that model.
- A `hook was skipped` line names the hook and the error.
- `/jev` shows `Error: …` when a Jev call failed and the model was held.

## Tests

```bash
claude plugin test ./jev-router
claude plugin validate ./jev-router
```
