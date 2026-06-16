# open-fusions

> Run model **fusions** locally. Fan a prompt across a panel of models, let a judge
> find the agreements and blind spots, and synthesize one answer. Then use the same
> fusion at every step of a coding loop: **plan → implement → review → fix**, until LGTM.

Powered by [smithers](https://smithers.sh) (durable workflow runtime) and
[incur](https://github.com/wevm/incur) (CLI framework for agents and humans).

---

## What is a fusion?

A single model is one opinion. A **fusion** is many.

1. **Panel** — your prompt is sent to several different models in parallel.
2. **Judge** — a judge model reads every response and maps the consensus,
   contradictions, unique insights, and blind spots.
3. **Synthesize** — a synthesizer writes one final answer grounded in that analysis.

This is the approach OpenRouter reported beating a single frontier model on deep
research, and matching it at roughly half the cost with a budget panel. `open-fusions`
runs it on your machine, against any models you can reach (OpenRouter by default, so a
single key reaches the whole catalog).

## Every step is a fusion

`open-fusions` ships a coding loop where **each phase is a fusion** and **each phase is
a separate command** the driving agent calls one at a time:

```
plan ──▶◇   implement ──▶◇   review ──▶◇
                                  │
                        lgtm? ─no─▶ fix ──▶◇ ──▶ (back to review)
                        yes──▶ done
◇ = a gate the agent clears by calling the next command.
```

Plan with a fusion. Implement with a fusion. Review with a fusion, which triggers fixes,
re-reviewed by a fusion, until the panel says LGTM. No single model is trusted to grade
its own homework.

## Install

`open-fusions` runs on [Bun](https://bun.sh) (the durable engine uses `bun:sqlite`).

```sh
bun add open-fusions
```

Set at least one model key. OpenRouter is the default route (one key, every model):

```sh
export OPENROUTER_API_KEY=sk-or-...
# optional native providers, used only when a model targets them explicitly:
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

## Quickstart: a one-shot fusion

```sh
open-fusions fuse "What's the best caching strategy for a read-heavy JSON API?"
```

You get back the synthesized answer, plus the judge's breakdown (consensus,
contradictions, blind spots) and every panelist's raw take. Add `--json` for structured
output, or `--panel` / `--judge` to choose models:

```sh
open-fusions fuse "Design a rate limiter" \
  --panel "openai/gpt-5.5,anthropic/claude-opus-4.8,google/gemini-3-pro" \
  --judge "anthropic/claude-opus-4.8" --json
```

## The coding loop

Each command runs a fusion for one phase and persists a **session** so the next command
picks up where the last left off. The agent (or you) calls them one at a time.

```sh
# 1. PLAN — a fusion drafts the plan, returns a session id
open-fusions plan "add rate limiting and audit logging"
# → { session: "s-...", phase: "implement", plan: { steps, risks, files } }

# 2. IMPLEMENT — a fusion synthesizes implementation guidance
open-fusions implement --session s-...

# 3. REVIEW — a fusion reviews the working diff (auto-detected via `git diff`)
open-fusions review --session s-...
# → lgtm: false, issues: [...]   (CTA points you to `fix`)

# 4. FIX — a fusion synthesizes fixes for the issues
open-fusions fix --session s-...

# 5. REVIEW again — loop until the panel agrees
open-fusions review --session s-...
# → lgtm: true   ✅ done
```

Inspect or resume any time:

```sh
open-fusions status --session s-...   # phase, iteration, lgtm
open-fusions result --session s-...   # full plan + implementation + last review
```

Every command prints a **call-to-action** naming the exact next command, so an agent
can drive the whole loop without memorizing the flow.

## Use it as an agent skill

`open-fusions` is built with [incur](https://github.com/wevm/incur), so it installs into
any harness as a skill and exposes itself over MCP:

```sh
open-fusions skills add     # install the skill into Claude Code, Cursor, Amp, ...
open-fusions mcp add        # or register as an MCP server
open-fusions --llms         # machine-readable command manifest
```

Once installed, the agent discovers each phase as a tool and runs the plan → implement →
review → fix loop on your behalf, one fusion per step.

## Configuration

| Flag / env | Purpose |
| --- | --- |
| `--panel "a,b,c"` | Comma-separated model ids for the panel |
| `--judge "id"` | Model that judges and synthesizes |
| `--session "id"` | Target an existing session |
| `--diff "..."` | Provide the diff for `review` (defaults to `git diff`) |
| `OPENROUTER_API_KEY` | Default routing for every model |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Native providers (opt-in) |
| `OPEN_FUSIONS_DIR` | Where sessions are stored (default `.open-fusions/`) |

Model ids are [OpenRouter](https://openrouter.ai) `vendor/model` strings by default
(e.g. `anthropic/claude-opus-4.8`). To hit a provider's native API directly, pass an
object spec with an explicit `provider` in the programmatic API.

## Programmatic API

```ts
import { runFusion, fuse, fuseWith, SessionStore, runPlan } from "open-fusions";

// one-shot fusion
const r = await runFusion({
  prompt: "What's the best caching strategy for a read-heavy API?",
  panel: ["openai/gpt-5.5", "anthropic/claude-opus-4.8", "google/gemini-3-pro"],
  judge: "anthropic/claude-opus-4.8",
});
console.log(r.answer);     // synthesized answer
console.log(r.judgment);   // consensus / contradictions / blindSpots
console.log(r.panel);      // each model's raw response

// fusion with a custom structured output schema
import { z } from "zod";
const out = await fuseWith({ /* ... */, schema: z.object({ steps: z.array(z.string()) }) });
```

## How it works

- Each fusion is a [smithers](https://smithers.sh) workflow: a `Parallel` fan-out of
  panelist tasks → a judge task → a synthesizer task, with every output validated by a
  Zod schema and persisted to SQLite.
- Models are reached through smithers agents over the Vercel AI SDK, defaulting to
  OpenRouter's OpenAI-compatible endpoint so one key covers the whole catalog.
- The coding loop persists `SessionState` as JSON between commands, so the agent
  advances the pipeline one tool call at a time.
- The CLI and skill packaging come from [incur](https://github.com/wevm/incur):
  token-efficient output, on-demand skill loading, and built-in MCP.

## Status

`open-fusions` is early. The session-driven loop above is the stable path today. A fully
durable single-run mode (one smithers run gated by `Approval` nodes, resumed across
processes) is on the roadmap and lands once the programmatic approval API ships in the
published `smithers-orchestrator`.

## License

MIT
