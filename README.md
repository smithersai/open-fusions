# smithers-fusions

> **Run model fusions locally.** Fan a prompt across a panel of models, let a judge find the
> blind spots, and synthesize one answer. Use the same fusion at every step of a coding loop
> — **plan → implement → review → fix** — until the panel says LGTM.

A CLI **and** TypeScript library. It fuses the coding-agent subscriptions you already have.
Built on [smithers](https://smithers.sh) (durable workflow runtime) and
[incur](https://github.com/wevm/incur) (CLI, skill, and MCP framework).

## Contents

- [What is a fusion?](#what-is-a-fusion)
- [Install](#install)
- [Quickstart](#quickstart)
- [For humans: install the skill, then ask your agent](#for-humans-install-the-skill-then-ask-your-agent)
- [For agents: the command reference](#for-agents-the-command-reference)
- [Configuration](#configuration)
- [Programmatic API](#programmatic-api)
- [How it works](#how-it-works)

## What is a fusion?

One model is one opinion. A **fusion** is many, reconciled:

1. **Panel** — your prompt goes to several models in parallel.
2. **Judge** — one model reads every response and maps the consensus, contradictions,
   unique insights, and blind spots.
3. **Synthesize** — a synthesizer writes one answer grounded in that analysis.

One model can be confidently wrong. A disagreeing panel surfaces the risk; the judge and
synthesizer turn it into a better answer than any single model gave.

## Install

Runs on [Bun](https://bun.sh) (the durable engine uses `bun:sqlite`).

```sh
bun add smithers-fusions
```

It is not a hosted router and needs no special API key. By default it fuses the
coding-agent subscriptions you already run — Claude Code, Codex, Gemini — through
[smithers](https://smithers.sh) agents. Log in to the harnesses you want on the panel:

```sh
claude   # Claude Code
codex    # OpenAI / Codex
gemini   # Google / Gemini
```

Subscription harnesses need no per-call key. For a direct API model, set that provider's
key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).

## Quickstart

### One-shot fusion

Fan one prompt across a panel, judge the answers, synthesize one:

```sh
smithers-fusions fuse "What's the safest way to add idempotency keys to this endpoint?" \
  --panel "claude-code,codex,gemini" --judge "claude-code"
# → synthesized answer + the judge's consensus/contradictions/blind-spots + each panelist
```

Add `--json` for structured output. With no `--panel` / `--judge`, your registered
subscriptions are used.

### The coding loop

Each phase is a fusion, and each phase is a separate command the driving agent runs one at
a time:

```
plan ──▶◇   implement ──▶◇   review ──▶◇
                                  │
                        lgtm? ─no─▶ fix ──▶◇ ──▶ (back to review, max 16 rounds)
                        yes──▶ done   ·   16 rounds without lgtm ──▶ exhausted
◇ = an approval gate the agent clears by calling the next command.
```

Plan with a fusion. Implement with a fusion. Review with a fusion; a failed review triggers
fixes, re-reviewed by a fusion, until the panel agrees. No single model grades its own
homework. It is one durable smithers run with `<Approval>` gates between phases, so a crash,
restart, or day-later resume picks up where it left off.

## For humans: install the skill, then ask your agent

You don't run fusions by hand. Install the skill into your coding agent (Claude Code,
Cursor, Amp, …) once, then ask in plain English. The agent discovers each phase as a tool
and drives the loop for you.

```sh
smithers-fusions skills add     # install the skill into your agent harness
smithers-fusions mcp add        # …or register as an MCP server instead
```

Then prompt your agent:

> "Use smithers-fusions to plan and implement rate limiting and audit logging, and keep
> reviewing with a fusion until the panel says LGTM."

> "Ask a fusion for the safest way to add idempotency keys to this endpoint."

The agent runs the commands, applies the edits, and loops review → fix. You stay in control
by approving its changes. You never touch the CLI.

## For agents: the command reference

> Run **one command per step**. Every response ends with a **Next:** call-to-action naming
> the exact command to run next — follow it. State lives in a durable run keyed by
> `--session`; `plan` creates it and returns the id.

### One-shot fusion

```sh
smithers-fusions fuse "Compare optimistic vs pessimistic locking for this workload"
# → synthesized answer + the judge's consensus/contradictions/blind-spots + each panelist
```

Add `--json` for structured output; `--panel "a,b,c"` / `--judge "id"` to choose agents.

### The coding loop

```sh
# 1. PLAN — a fusion drafts the plan and opens a durable run
smithers-fusions plan "add rate limiting and audit logging"
# → { session: "sf-…", phase: "plan", plan: { steps, risks, files }, cta: { … } }

# 2. IMPLEMENT — approve the plan; a fusion synthesizes the implementation (you apply it)
smithers-fusions implement --session sf-…

# 3. REVIEW — a fusion reviews the work and returns a verdict
smithers-fusions review --session sf-…
# → lgtm: false → CTA: fix     |     lgtm: true → done

# 4. FIX — a fusion synthesizes fixes for the issues (you apply them)
smithers-fusions fix --session sf-…

# 5. REVIEW again — loop until the panel agrees (bounded to 16 review→fix rounds)
smithers-fusions review --session sf-…
# → lgtm: true ✅   |   16 rounds without lgtm → phase: "exhausted" (lgtm: false)
```

### Inspect, resume, or abandon

```sh
smithers-fusions status --session sf-…   # phase, iteration, lgtm, pending gate
smithers-fusions result --session sf-…   # the current phase's synthesized output
smithers-fusions resume --session sf-…   # recover a run interrupted mid-step (crash recovery)
smithers-fusions reject --session sf-…   # deny the pending gate and stop the run
```

Any command runs in a fresh process and resumes the same run by `--session`. If a process is
killed *during* a fusion (between gates), `resume` drives the in-flight step to its next
gate; a normal command also tells you to run `resume` when it detects an interrupted run.

### Operating rules

- **One command per step.** Plan, then stop. Implement, then stop. The run carries state.
- **You make the edits.** `implement` and `fix` return guidance, not file writes — apply
  the changes, then call the next command.
- **Don't skip `review`.** Loop fix → review until LGTM; the panel catches what one model
  misses. The loop is bounded to 16 rounds — if it never agrees the run ends in the
  `exhausted` phase (`lgtm: false`) carrying the last fix, not a false `done`.
- **Follow the CTA.** Every response names the exact next command.
- **Widen the panel for hard problems** with `--panel` / `--judge`.

## Configuration

| Flag / env | Purpose |
| --- | --- |
| `--panel "a,b,c"` | Comma-separated smithers agent ids for the panel |
| `--judge "id"` | Agent that judges + synthesizes |
| `--session "id"` | Target an existing durable run (pin an id on `plan`) |
| `SMITHERS_FUSIONS_DIR` | Where durable runs are stored (default `.smithers-fusions/`) |

Panel/judge values are **smithers agent ids** — by default a registered subscription
harness, named by account label (`codex-1`) or provider (`claude-code`, `codex`, `gemini`),
optionally with a model (`codex:gpt-5.5`). Run `smithers agents add` to register one. With
no `--panel`, your registered subscriptions are used; they're persisted in the run on
`plan`, so every resume rebuilds the identical pipeline.

Prefer a hosted backend? smithers-fusions is a local alternative to a router, but the CLI
still supports them as opt-in ids:

| Id form | Backend | Auth |
| --- | --- | --- |
| `openrouter:anthropic/claude-opus-4.8` | OpenRouter | `OPENROUTER_API_KEY` |
| `compat:llama3` | any OpenAI-compatible endpoint (Ollama, vLLM, gateway) | `OPENAI_BASE_URL` + `OPENAI_API_KEY` |
| `openai:gpt-5.5` / `anthropic:claude-opus-4.8` | native provider SDK | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` |

You can also pass a constructed smithers agent (`new ClaudeCodeAgent(…)`,
`new OpenAIAgent({ baseURL, apiKey, model })`) straight into `panel` / `judge`.

## Programmatic API

```ts
import { runFusion, SmithersFusionsEngine } from "smithers-fusions";

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
const engine = new SmithersFusionsEngine();
const planned = await engine.start("add rate limiting", { panel: ["claude-code", "codex"], judge: "gemini" });
const implemented = await engine.advance(planned.runId); // approve the plan gate → implement
const reviewed = await engine.advance(implemented.runId); // → review verdict (reviewed.lgtm)
```

## How it works

- **Each phase is a fusion:** a smithers `Parallel` fan-out of panelist tasks → a judge task
  → a synthesizer task. Every output is validated by a Zod schema.
- **The loop is one durable smithers run** with `<Approval>` gates between phases. Each
  command resumes the run, advances it past one gate, and pauses. The panel/judge are
  persisted on `plan`, so every resume rebuilds the identical workflow and a crash resumes
  where it left off.
- **Models are smithers agents** — your subscription harnesses or any model smithers
  supports — chosen with `--panel` / `--judge`. No hosted router, no special key.
- **CLI, skill, and MCP packaging come from [incur](https://github.com/wevm/incur):**
  token-efficient output, on-demand skill loading, built-in MCP.

## License

MIT
