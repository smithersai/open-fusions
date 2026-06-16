---
name: open-fusions
description: Run model fusions for planning, implementing, and reviewing code. Use when one model's opinion isn't enough — open-fusions fans a prompt across a panel of models, judges the responses, and synthesizes one answer. Drives a plan → implement → review → fix loop, one fusion per step, until the panel says LGTM.
command: open-fusions
---

# open-fusions

A **fusion** asks several models the same thing, has a judge find the consensus and the
blind spots, and synthesizes one answer. `open-fusions` makes that a local CLI, then uses
it at every step of a coding loop.

Use it when a change is worth more than one model's opinion: non-trivial features,
risky refactors, security-sensitive code, or anything where you want a second (and third)
set of eyes before and after you write it.

## One-shot fusion (a single question)

```sh
open-fusions fuse "What's the safest way to add idempotency keys to this endpoint?"
```

Returns the synthesized answer plus the judge's breakdown. Pass `--json` for structured
output, `--panel "a,b,c"` and `--judge "id"` to pick models.

## The coding loop (one fusion per step)

You apply the edits. open-fusions is the fusion brain: it plans, it reviews your diff,
and it synthesizes fixes. Call one command per step. Each command prints a **Next:**
call-to-action with the exact command to run next — follow it.

1. **Plan.** A fusion drafts the plan and opens a session.
   ```sh
   open-fusions plan "add rate limiting and audit logging"
   ```
   Note the returned `session` id; pass it to every later command.

2. **Implement.** A fusion synthesizes implementation guidance from the plan. Read it,
   then make the actual code changes yourself.
   ```sh
   open-fusions implement --session <id>
   ```

3. **Review.** A fusion reviews your working diff (auto-detected via `git diff`, or pass
   `--diff`). It returns `lgtm` plus a list of issues.
   ```sh
   open-fusions review --session <id>
   ```

4. **Fix.** If `lgtm` is false, a fusion synthesizes fixes for the issues. Apply them,
   then go back to review.
   ```sh
   open-fusions fix --session <id>
   ```

5. **Loop** review → fix until `review` returns `lgtm: true`. Then you're done.

Check state any time:

```sh
open-fusions status --session <id>    # phase, iteration, lgtm
open-fusions result --session <id>    # full plan + implementation + last review
```

## Operating rules for the agent

- **One command per step.** Don't try to run the whole loop in one shot. Plan, then stop.
  Implement, then stop. The session carries state between calls.
- **You make the edits.** `implement` and `fix` return synthesized guidance, not file
  writes. Apply the changes to the repo, then call the next command.
- **Trust the panel, not one model.** Don't skip `review`. Loop fix → review until LGTM;
  the panel catches what a single model misses.
- **Follow the CTA.** Every response ends with the exact next command. Use it.
- **Pick models when it matters.** For hard problems, widen the panel and use a strong
  judge: `--panel "claude-code,codex,gemini" --judge "claude-code"` (smithers agent ids —
  your subscription harnesses, or any model smithers supports).

## Requirements

- Runs on [Bun](https://bun.sh).
- Fuses the coding-agent subscriptions you already have (Claude Code, Codex, Gemini, …)
  through smithers agents — no special API key. Log in once with each harness's CLI
  (`claude`, `codex`, `gemini`). If you put a direct API model on the panel, set that
  provider's key.
