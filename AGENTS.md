# open-fusions — build guide for coding agents

> Read this fully before writing code. It encodes the architecture and the exact
> `smithers-orchestrator` + `incur` APIs you must build against. These APIs are
> non-obvious; do not guess — follow the cheat-sheets here.

## What we are building

`open-fusions` runs **model fusions locally** and ships a coding loop where **every
step is a fusion**. A "fusion" = fan one prompt across a **panel** of different
models in parallel → a **judge** model analyzes consensus/contradictions/blind-spots
→ a **synthesizer** writes one final answer. open-fusions is a **local alternative to a
hosted router** like OpenRouter: it runs the fusion on your machine against your own
**smithers agents** — the subscription harnesses you're already logged into — with no
special API key.

It is consumed two ways:
1. **CLI**: `open-fusions <command>` (built with `incur`).
2. **Agent skill**: `open-fusions skills add` installs it into any harness; a driving
   agent calls each phase as a **separate tool call**, advancing the pipeline one
   step at a time.

The coding loop, each phase a fusion, each phase a separate CLI/tool call:

```
start(task) → PLAN ─▶◇ → IMPLEMENT ─▶◇ → REVIEW ─▶◇
                                            │
                                  lgtm? ─no→ FIX ─▶◇ → (loop back to REVIEW)
                                  yes→ done
◇ = a gate the driving agent clears with the next CLI call.
```

## Golden rules

- **Bun-first.** Runtime is Bun (smithers uses `bun:sqlite`). Tests use `bun:test`.
- **TDD.** Write a failing `bun:test` first, then implement to green. Never write
  implementation before its test.
- **No network in unit tests.** Inject **stub `AgentLike`** objects with deterministic
  `generate()`. Real model calls only happen behind config defaults, never in tests.
- **Public APIs only.** Depend on the **public `smithers-orchestrator` barrel**,
  `incur`, `zod`, `effect`. Do **NOT** import internal subpackages like
  `@smithers-orchestrator/engine` — they don't exist for published consumers.
- **Every phase is a fusion.** plan/implement/review/fix each go through the fusion
  (panel→judge→synth). Nothing calls a single model directly for a phase.
- **TypeScript strict.** Avoid `any`. Export types from `src/index.ts`.
- Keep modules small and individually unit-tested.

## Commands

```sh
bun test                 # all tests
bun test test/unit       # fast unit tests (no smithers runtime)
bun run typecheck        # tsc --noEmit
bun run build            # tsup -> dist + bin
bun run dev -- <args>    # run the CLI from source (bun src/bin.ts)
```

## Module layout (create these)

```
src/
  index.ts             # public exports (fuse, Session, types, schemas)
  bin.ts               # #!/usr/bin/env bun  -> import cli; cli.serve()
  cli.ts               # incur Cli: commands start/plan/implement/review/fix/status/result/fuse
  schemas.ts           # zod schemas (panelResponse, judgment, finalAnswer, plan, implementation, reviewVerdict, fix, session)
  types.ts             # TS types: ModelSpec, PanelMember, FusionConfig, FusionResult, Phase, SessionState, Engine
  agents.ts            # resolveAgent(spec) -> AgentLike; buildPanel(config) -> PanelMember[]
  fusion.tsx           # <Fusion> JSX subtree + fuse() programmatic wrapper
  prompts/
    panelist.ts judge.ts synthesize.ts plan.ts implement.ts review.ts fix.ts   # pure prompt builders
  outputs.ts           # readOutputs(dbPath, runId, table) via bun:sqlite (loadOutputs is NOT in the barrel)
  engine/
    types.ts           # Engine interface (start/advance/approve/status/outputs)
    smithers-cli.ts    # CliEngine: drives the bundled `smithers` CLI via Bun.spawn
    mock.ts            # MockEngine for unit tests
  session.ts           # SessionStore: persist SessionState keyed by id (json under .open-fusions/)
test/
  unit/*.test.ts        # bun:test, stub agents + MockEngine, no network/smithers runtime
  integration/*.test.ts # bun:test, real smithers via stub agents + temp db (guarded)
```

## smithers-orchestrator — public barrel cheat-sheet (verified, v0.24)

```ts
import {
  createSmithers, runWorkflow,
  Workflow, Sequence, Parallel, Task, Loop, Ralph, Branch,
  Approval, ApprovalGate, approvalDecisionSchema,
  OpenAIAgent, AnthropicAgent, // also ClaudeCodeAgent etc.
} from "smithers-orchestrator";
import { Effect } from "effect";
import { z } from "zod"; // zod v4 — schemas MUST be v4 (smithers reads schema._zod.def)
```

- `createSmithers(schemas, opts?)` → `{ Workflow, Task, Sequence, Parallel, Loop, Ralph, Branch, Approval, ApprovalGate, smithers, outputs, db, tables }`.
  - `schemas`: `Record<string, z.ZodObject>`. Reserved key `input` declares run input → `ctx.input`.
  - `opts`: `{ dbPath?: string (FILE path, no :memory:), journalMode?: string, readableName?, description? }`.
  - Each schema key `k` → durable SQLite table (snake_cased) + `outputs.k` (pass to a Task's `output`).
- JSX pragma per file: `/** @jsxImportSource smithers-orchestrator */`.
- Components:
  - `<Workflow name="..."> ...children </Workflow>` (name required).
  - `<Sequence>` run in order. `<Parallel maxConcurrency={n} continueOnFail>` fan-out.
  - `<Task id output agent? deps? needsApproval? continueOnFail? timeoutMs? retries?>`.
    - `output={outputs.k}` (required). `agent={agentLike}`.
    - children (prompt) forms: `string` | a plain object Row (static output, **no agent runs**) |
      `(deps) => string | Row | ReactNode` when using `deps`.
    - `deps={{ alias: outputs.k }}` — alias key must equal the upstream **task id** (or remap with `needs`).
  - `<Approval id output={outputs.decisionKey} request={{title, summary}} onDeny="fail|continue|skip" />`
    persists a typed `approvalDecisionSchema` row; run pauses → `waiting-approval`.
  - `<Task ... needsApproval />` = pure pause before a task, no decision payload.
- `ctx` in `smithers((ctx) => jsx)`: `ctx.input`, `ctx.outputs.<key>` (→ **array** of all rows for that key),
  `ctx.outputMaybe(outputs.k, { nodeId })`, `ctx.output(...)`, `ctx.runId`, `ctx.iteration`.
- Agents — default to the user's **subscription harnesses** via the `smithers agents`
  account registry (`@smithers-orchestrator/accounts`); opt-in API backends are explicit:
  ```ts
  import { listAccounts, getAccount } from "@smithers-orchestrator/accounts";
  // subscription harness from a registered account (no API key — spawns the local CLI):
  new ClaudeCodeAgent({ model, configDir: account.configDir, cwd: process.cwd() })
  // opt-in OpenRouter / any OpenAI-compatible endpoint:
  new OpenAIAgent({ model: "anthropic/claude-...", baseURL: "https://openrouter.ai/api/v1",
                    apiKey: process.env.OPENROUTER_API_KEY, nativeStructuredOutput: false })
  new AnthropicAgent({ model: "claude-...", instructions })
  ```
  `src/agents.ts` centralizes this: `resolveAgent(spec)` passes an `AgentLike` straight
  through, resolves a string/object via the registry + provider grammar (subscriptions,
  `openrouter:`, `openai:`/`anthropic:`, `compat:`), and `defaultPanel()`/`defaultJudge()`
  read `listAccounts()`. An **AgentLike** is any `{ generate(args?) => Promise<{ output }> }`. Stub it in tests:
  ```ts
  const stub = (out) => ({ async generate() { return { output: out }; } });
  ```
- Run programmatically:
  ```ts
  const res = await Effect.runPromise(runWorkflow(wf, { input, runId, resume? }));
  // res.status ∈ "finished"|"failed"|"cancelled"|"continued"|"waiting-approval"|"waiting-event"|"waiting-timer"
  // res.output is populated ONLY if a schema key is literally named `output`.
  ```
- **Reading node outputs** (`loadOutputs` is NOT in the public barrel): read SQLite directly.
  Table name = snake_case of the schema key; columns = the schema fields plus `run_id`, `iteration`.
  ```ts
  import { Database } from "bun:sqlite";
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query(`SELECT * FROM ${table} WHERE run_id = ? ORDER BY iteration ASC`).all(runId);
  ```
  Put this in `src/outputs.ts` as `readOutputs(dbPath, runId, table)` and JSON-parse object columns.
- **Cross-process approve/resume** (no programmatic approveNode in the public barrel): drive the bundled
  `smithers` CLI via `Bun.spawn` inside `CliEngine`:
  - start:   `smithers up <pipeline.js> --run-id <id> --input <json>`  (runs to first gate, exits waiting-approval)
  - resume:  `smithers up <pipeline.js> --resume <id>`
  - approve: `smithers approve <id> [--node <nodeId>] [--note ...]`   /  `smithers deny <id>`
  - status:  `smithers inspect <id> --format json`  /  `smithers ps --format json`
  Resolve the `smithers` bin from the `smithers-orchestrator` dependency.

## incur — cheat-sheet (verified, v0.4.8)

```ts
import { Cli, z, middleware, error } from "incur"; // z is zod v4
const cli = Cli.create("open-fusions", {
  version: "0.0.0",
  description: "...",
  sync: { suggestions: ["plan a change", "review my branch with a fusion"] },
});
cli.command("plan", {
  description: "...",
  args: z.object({ task: z.string().describe("...") }),
  options: z.object({ session: z.string().optional() }),
  output: z.object({ /* shape run() returns */ }),
  examples: [{ args: { task: "add rate limiting" }, description: "Plan a change" }],
  run(c) {
    // c.args, c.options, c.env, c.var, c.agent (true when piped/non-TTY)
    return c.ok(data, { cta: { description: "Next:", commands: [{ command: "implement", description: "..." }] } });
    // or: return c.error({ code, message, retryable, cta })
  },
});
cli.serve();
export default cli;
```

- **Testing a command (no process spawn):**
  ```ts
  let out = "";
  await cli.serve(["plan", "add logging", "--json"], { stdout: (s) => { out += s; }, exit: () => {}, env: {} });
  const data = JSON.parse(out);
  ```
- Built-ins you get free: `--json`, `--format`, `--llms`, `--mcp`, `skills add`, `mcp add`, `--help`.
- `src/bin.ts`: `#!/usr/bin/env bun` then `import cli from "./cli.js"; cli.serve();`.

## The fusion (src/fusion.tsx)

`<Fusion>` builds: `<Sequence>` → `<Parallel continueOnFail>` of N panelist `<Task output={outputs.panelResponse}>`
(same prompt, different agent each) → judge `<Task output={outputs.judgment}>` (reads `ctx.outputs.panelResponse`)
→ synthesizer `<Task output={outputs.finalAnswer}>` (reads judgment + responses).

`fuse(config)` (programmatic wrapper) builds a `createSmithers({ panelResponse, judgment, finalAnswer })`
workflow with one `<Fusion>`, runs via `runWorkflow` on a **temp dbPath**, reads outputs via `readOutputs`,
cleans up the temp db, returns `FusionResult = { answer, judgment, panel }`.

`fuse` must accept **injected agents** (the panel/judge/synth `AgentLike`s) so tests pass stubs. It may also
accept an injected `run` function so a unit test can avoid the smithers runtime entirely; default uses smithers.

## Schemas (src/schemas.ts) — zod v4

- `panelResponse`: `{ model: string, answer: string, confidence?: "low"|"medium"|"high" }`
- `judgment`: `{ consensus: string[], contradictions: {topic,positions:string[]}[], uniqueInsights: {model,insight}[], blindSpots: string[], recommendation: string, confidence: "low"|"medium"|"high" }`
- `finalAnswer`: `{ answer: string, caveats: string[] }`
- `plan`: `{ steps: {title,detail}[], risks: string[], files: string[] }`
- `implementation`: `{ summary: string, changes: {file,description}[] }`
- `reviewVerdict`: `{ lgtm: boolean, summary: string, issues: {severity:"low"|"medium"|"high", file?:string, description:string}[] }`
- `fix`: `{ summary: string, changes: {file,description}[] }`
- `sessionState`: `{ id, task, phase, iteration, plan?, implementation?, lastReview?, history: {phase, at, summary}[] }`

## Env / config

- **No key by default.** Subscription harnesses authenticate via their own CLI login
  (`smithers agents add`); the agent classes spawn those CLIs. Keys are only for opt-in
  backends: `OPENROUTER_API_KEY` (`openrouter:`), `OPENAI_BASE_URL` + `OPENAI_API_KEY`
  (`compat:`), `ANTHROPIC_API_KEY` (`anthropic:`).
- Default panel = the user's **registered subscription accounts** (`listAccounts()`, capped);
  judge prefers a `claude-code` account, else the strongest available. Zero accounts → a
  clear error pointing at `smithers agents add`. All overridable via CLI options / `FusionConfig`.
  The judge choice matters (swings quality), so keep it configurable.

## Definition of done for any module

1. Unit tests written first and passing (`bun test test/unit`).
2. `bun run typecheck` clean.
3. Public surface exported from `src/index.ts`.
4. No internal smithers subpackage imports; no network in unit tests.
