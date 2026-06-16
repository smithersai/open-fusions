# open-fusions

> **Run model fusions locally.** Fan a prompt across a panel of models, let a judge find
> the agreements and blind spots, and synthesize one answer. Then use the same fusion at
> every step of a coding loop — **plan → implement → review → fix** — until the panel says LGTM.

Powered by [smithers](https://smithers.sh) (durable workflow runtime) and
[incur](https://github.com/wevm/incur) (CLI framework for agents and humans).

---

## What is a fusion?

A single model is one opinion. A **fusion** is many, reconciled:

1. **Panel** — your prompt goes to several different models in parallel.
2. **Judge** — a judge model reads every response and maps the consensus,
   contradictions, unique insights, and blind spots.
3. **Synthesize** — a synthesizer writes one final answer grounded in that analysis.

One model can be confidently wrong. A panel that disagrees surfaces the risk; the judge and
synthesizer turn that disagreement into a better answer than any single model gave.

## Fuse the agents you already have

open-fusions is **not** a hosted router and needs **no special API key**. By default it
fuses the coding-agent **subscriptions you already run** — Claude Code, Codex, Gemini, and
friends — through [smithers](https://smithers.sh) agents, riding the logins you already
have. Point `--panel` / `--judge` at any smithers agent id to mix and match, including
direct API models when you want them.

```sh
open-fusions fuse "What's the safest way to add idempotency keys to this endpoint?" \
  --panel "claude-code,codex,gemini" --judge "claude-code"
```

## Every step is a fusion

open-fusions ships a coding loop where **each phase is a fusion** and **each phase is a
separate command** the driving agent calls one at a time:

```
plan ──▶◇   implement ──▶◇   review ──▶◇
                                  │
                        lgtm? ─no─▶ fix ──▶◇ ──▶ (back to review, max 5 rounds)
                        yes──▶ done   ·   5 rounds without lgtm ──▶ exhausted
◇ = an approval gate the agent clears by calling the next command.
```

Plan with a fusion. Implement with a fusion. Review with a fusion, which triggers fixes —
re-reviewed by a fusion — until the panel agrees. No single model grades its own homework.

Under the hood this is **one durable smithers run** with `<Approval>` gates between phases.
Each command resumes the run, advances it past exactly one gate, and pauses — so a crash,
restart, or a day-later resume picks up exactly where it left off.

## Install

open-fusions runs on [Bun](https://bun.sh) (the durable engine uses `bun:sqlite`).

```sh
bun add open-fusions
```

Authenticate the harnesses you want on the panel — the ones you already use:

```sh
claude   # log in to your Claude subscription (Claude Code)
codex    # log in to your OpenAI/Codex subscription
gemini   # log in to your Google/Gemini subscription
```

No per-call API key is required for subscription harnesses. If you put a direct API model
on the panel instead, set that provider's key (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

---

## For humans: install the skill, then ask your agent

You don't run fusions by hand. Install the skill into your coding agent (Claude Code,
Cursor, Amp, …) once, then ask — in plain English — for what you want. The agent discovers
each fusion phase as a tool and drives the plan → implement → review → fix loop for you.

```sh
open-fusions skills add     # install the skill into your agent harness
open-fusions mcp add        # …or register as an MCP server instead
```

Then just prompt your agent:

> "Use open-fusions to plan and implement rate limiting and audit logging, and keep
> reviewing with a fusion until the panel says LGTM."

> "Ask a fusion for the safest way to add idempotency keys to this endpoint."

The agent runs the commands, applies the edits, and loops review → fix on your behalf. You
stay in control by approving the changes it makes. You never touch the CLI directly.

---

## For agents: the command reference

> The agent driving open-fusions runs **one command per step**. Every response ends with a
> **Next:** call-to-action naming the exact command to run next — follow it. State lives in
> a durable run keyed by `--session`; `plan` creates it and returns the id.

### One-shot fusion

```sh
open-fusions fuse "Compare optimistic vs pessimistic locking for this workload"
# → synthesized answer + the judge's consensus/contradictions/blind-spots + each panelist
```

Add `--json` for structured output; `--panel "a,b,c"` / `--judge "id"` to choose agents.

### The coding loop

```sh
# 1. PLAN — a fusion drafts the plan and opens a durable run
open-fusions plan "add rate limiting and audit logging"
# → { session: "of-…", phase: "plan", plan: { steps, risks, files }, cta: { … } }

# 2. IMPLEMENT — approve the plan; a fusion synthesizes the implementation (you apply it)
open-fusions implement --session of-…

# 3. REVIEW — a fusion reviews the work and returns a verdict
open-fusions review --session of-…
# → lgtm: false → CTA: fix     |     lgtm: true → done

# 4. FIX — a fusion synthesizes fixes for the issues (you apply them)
open-fusions fix --session of-…

# 5. REVIEW again — loop until the panel agrees (bounded to 5 review→fix rounds)
open-fusions review --session of-…
# → lgtm: true ✅   |   5 rounds without lgtm → phase: "exhausted" (lgtm: false)
```

### Inspect, resume, or abandon

```sh
open-fusions status --session of-…   # phase, iteration, lgtm, pending gate
open-fusions result --session of-…   # the current phase's synthesized output
open-fusions reject --session of-…   # deny the pending gate and stop the run
```

Because the run is durable, any command runs in a fresh process and resumes the same run by
`--session`.

### Operating rules

- **One command per step.** Plan, then stop. Implement, then stop. The run carries state.
- **You make the edits.** `implement` and `fix` return synthesized guidance, not file
  writes — apply the changes, then call the next command.
- **Don't skip `review`.** Loop fix → review until LGTM; the panel catches what one model
  misses. The loop is bounded to 5 review→fix rounds — if it never agrees the run ends in
  the `exhausted` phase (`lgtm: false`) carrying the last fix, not a false `done`.
- **Follow the CTA.** Every response names the exact next command.
- **Widen the panel for hard problems** with `--panel` / `--judge`.

## Configuration

| Flag / env | Purpose |
| --- | --- |
| `--panel "a,b,c"` | Comma-separated smithers agent ids for the panel |
| `--judge "id"` | Agent that judges + synthesizes |
| `--session "id"` | Target an existing durable run (pin an id on `plan`) |
| `OPEN_FUSIONS_DIR` | Where durable runs are stored (default `.open-fusions/`) |

Panel/judge values are **smithers agent ids** — by default a registered subscription
harness, named by account label (`codex-1`) or provider (`claude-code`, `codex`, `gemini`),
optionally with a model (`codex:gpt-5.5`). Run `smithers agents add` to register one. With
no `--panel`, open-fusions uses your registered subscriptions; they're persisted in the run
on `plan`, so every resume rebuilds the identical pipeline.

Prefer a hosted backend instead? open-fusions is a local **alternative** to a router, but
the CLI still supports them as opt-in ids:

| Id form | Backend | Auth |
| --- | --- | --- |
| `openrouter:anthropic/claude-opus-4.8` | OpenRouter | `OPENROUTER_API_KEY` |
| `compat:llama3` | any OpenAI-compatible endpoint (Ollama, vLLM, gateway) | `OPENAI_BASE_URL` + `OPENAI_API_KEY` |
| `openai:gpt-5.5` / `anthropic:claude-opus-4.8` | native provider SDK | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` |

Programmatically, you can also pass any constructed smithers agent (`new ClaudeCodeAgent(…)`,
`new OpenAIAgent({ baseURL, apiKey, model })`) straight into `panel` / `judge`.

## Programmatic API

```ts
import { runFusion, OpenFusionsEngine } from "open-fusions";

// one-shot fusion: fan a prompt across a panel, judge, synthesize
const r = await runFusion({
  prompt: "What's the safest way to add idempotency keys to this endpoint?",
  panel: ["claude-code", "codex", "gemini"],
  judge: "claude-code",
});
console.log(r.answer); // synthesized answer
console.log(r.judgment); // consensus / contradictions / blind spots
console.log(r.panel); // each model's raw response

// the durable coding loop, advanced one phase at a time
const engine = new OpenFusionsEngine();
const planned = await engine.start("add rate limiting", { panel: ["claude-code", "codex"], judge: "gemini" });
const implemented = await engine.advance(planned.runId); // approve the plan gate → implement
const reviewed = await engine.advance(implemented.runId); // → review verdict (reviewed.lgtm)
```

## How it works

- **Each phase is a fusion:** a smithers `Parallel` fan-out of panelist tasks → a judge
  task → a synthesizer task, with every output validated by a Zod schema.
- **The loop is one durable smithers run** with `<Approval>` gates between phases. Each
  command resumes the run, advances it past one gate (running that phase's fusion), and
  pauses. The panel/judge are persisted in the run, so every resume rebuilds the identical
  workflow and a crash resumes exactly where it left off.
- **Models are smithers agents** — your subscription coding harnesses or any model smithers
  supports — selected with `--panel` / `--judge`. No hosted router, no special key.
- **The CLI and skill packaging come from [incur](https://github.com/wevm/incur):**
  token-efficient output, on-demand skill loading, and built-in MCP.

## Durable by design

The plan → implement → review → fix loop is **one durable smithers run**: each phase is a
fusion, `<Approval>` gates sit between phases, and the run is resumable across processes by
session id — so a crash, restart, or a day-later resume picks up exactly where it left off.

## License

MIT
