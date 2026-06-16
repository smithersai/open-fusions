import { existsSync } from "node:fs";
import { Cli, z } from "incur";
import pkg from "../package.json" with { type: "json" };
import { defaultJudge, defaultPanel } from "./agents";
import { isTerminalPhase, OpenFusionsEngine, type EngineState } from "./engine";
import { runFusion, type FuseResult } from "./fusion";
import type { FusionConfig } from "./types";

export type CliDeps = {
  engine: OpenFusionsEngine;
  fuseRaw: (config: FusionConfig & { prompt: string }) => Promise<FuseResult>;
};

const looseOutput = z.unknown();

// NOTE: the call-to-action (`cta`) is NOT part of the output *data* schema — it
// is supplied via incur's `meta` argument to `c.ok`/`c.error` and injected into
// the serialized payload at format time. Declaring it here too was dead schema.
const baseCommandOutput = {
  session: z.string(),
  phase: z.string(),
};

const judgmentOutput = z.object({
  consensus: z.array(z.string()),
  contradictions: z.array(z.object({ topic: z.string(), positions: z.array(z.string()) })),
  uniqueInsights: z.array(z.object({ model: z.string(), insight: z.string() })),
  blindSpots: z.array(z.string()),
  recommendation: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

const panelOutput = z.array(
  z.object({
    model: z.string(),
    answer: z.string(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  }),
);

export function createCli(deps?: Partial<CliDeps>) {
  const engine = deps?.engine ?? new OpenFusionsEngine();
  const fuseRaw = deps?.fuseRaw ?? runFusion;

  const cli = Cli.create("open-fusions", {
    version: pkg.version,
    description: "Run local model fusions and advance the durable plan-implement-review-fix loop.",
    sync: {
      suggestions: ["plan a change with a fusion", "review my branch with a fusion"],
    },
  });

  cli.command("plan", {
    description: "Plan a change with a fusion (starts a durable run).",
    args: z.object({ task: z.string().describe("Task to run through the coding loop") }),
    options: z.object({
      panel: z
        .string()
        .optional()
        .describe(
          "Comma-separated models: account labels, subscription providers (claude-code, codex, gemini), or openrouter:<vendor/model> / compat:<model>. Defaults to your registered subscriptions.",
        ),
      judge: z.string().optional().describe("Judge model (same id forms as --panel)"),
      session: z.string().optional().describe("Optional run id to use"),
    }),
    output: z.object({ ...baseCommandOutput, plan: looseOutput }),
    examples: [{ args: { task: "add rate limiting" }, description: "Plan a change and start a run" }],
    async run(c) {
      let panel: string[];
      let judge: string;
      try {
        panel = splitList(c.options.panel) ?? defaultPanel();
        judge = c.options.judge ?? defaultJudge();
      } catch (e) {
        return noModels(c, e);
      }
      let st: EngineState;
      try {
        st = await engine.start(c.args.task, { panel, judge }, c.options.session);
      } catch (e) {
        // start() refuses to clobber an existing run id.
        if (c.options.session && e instanceof Error && /already exists/i.test(e.message)) {
          return c.error({
            code: "RUN_EXISTS",
            message: e.message,
            retryable: false,
            cta: nextCta("Inspect it:", `status --session ${c.options.session}`, "Show the existing run's status"),
          });
        }
        throw e;
      }
      if (st.needsResume) return needsResumeError(c, st.runId);
      return c.ok(
        { session: st.runId, phase: st.phase, plan: st.output },
        { cta: nextCta("Next:", `implement --session ${st.runId}`, "Run the implementation fusion") },
      );
    },
  });

  cli.command("implement", {
    description: "Advance a durable run through implementation.",
    options: z.object({ session: z.string() }),
    output: z.object({ ...baseCommandOutput, implementation: looseOutput }),
    examples: [{ options: { session: "of-123" }, description: "Run implementation" }],
    async run(c) {
      if (!existsSync(engine.dbPathFor(c.options.session))) return missingSession(c, c.options.session);

      const cur = await engine.state(c.options.session);
      if (cur.status === "failed") return fusionFailedError(c, c.options.session, cur.phase);
      if (cur.needsResume) return needsResumeError(c, c.options.session);
      if (isTerminalPhase(cur.phase)) return terminalError(c, c.options.session, cur.phase);
      if (cur.phase !== "plan") {
        return wrongPhase(c, c.options.session, commandFor(cur.phase), "Run the current phase command");
      }

      const st = await engine.advance(c.options.session);
      if (st.status === "failed") return fusionFailedError(c, c.options.session, st.phase);
      if (st.needsResume) return needsResumeError(c, c.options.session);
      return c.ok(
        { session: c.options.session, phase: st.phase, implementation: st.output },
        { cta: nextCta("Next:", `review --session ${c.options.session}`, "Run the review fusion") },
      );
    },
  });

  cli.command("review", {
    description: "Advance a durable run through review.",
    options: z.object({ session: z.string() }),
    output: z.object({
      ...baseCommandOutput,
      verdict: looseOutput,
      lgtm: z.boolean(),
    }),
    examples: [{ options: { session: "of-123" }, description: "Run review" }],
    async run(c) {
      if (!existsSync(engine.dbPathFor(c.options.session))) return missingSession(c, c.options.session);

      const cur = await engine.state(c.options.session);
      if (cur.status === "failed") return fusionFailedError(c, c.options.session, cur.phase);
      if (cur.needsResume) return needsResumeError(c, c.options.session);
      if (isTerminalPhase(cur.phase)) return terminalError(c, c.options.session, cur.phase);
      if (cur.phase === "review" && cur.pendingGate && cur.lgtm === true) {
        const done = await engine.advance(c.options.session);
        if (done.status === "failed") return fusionFailedError(c, c.options.session, done.phase);
        return c.ok(
          { session: c.options.session, phase: done.phase, verdict: cur.output, lgtm: true },
          { cta: nextCta("Done - LGTM", `result --session ${c.options.session}`, "Show the final result") },
        );
      }
      if (cur.phase !== "implement" && cur.phase !== "fix") {
        return wrongPhase(c, c.options.session, commandFor(cur.phase), "Run the current phase command");
      }

      const st = await engine.advance(c.options.session);
      if (st.status === "failed") return fusionFailedError(c, c.options.session, st.phase);
      // No verdict produced (e.g. the review synth failed): the run is now
      // mid-flight. Don't pretend lgtm:false and send the user to `fix`.
      if (st.needsResume || st.lgtm === null) return needsResumeError(c, c.options.session);
      if (st.lgtm === true) {
        const done = await engine.advance(c.options.session);
        return c.ok(
          { session: c.options.session, phase: done.phase, verdict: st.output, lgtm: true },
          { cta: nextCta("Done - LGTM", `result --session ${c.options.session}`, "Show the final result") },
        );
      }

      return c.ok(
        { session: c.options.session, phase: "review", verdict: st.output, lgtm: false },
        { cta: nextCta("Next:", `fix --session ${c.options.session}`, "Run the fix fusion") },
      );
    },
  });

  cli.command("fix", {
    description: "Advance a durable run through fix.",
    options: z.object({ session: z.string() }),
    output: z.object({ ...baseCommandOutput, fix: looseOutput }),
    examples: [{ options: { session: "of-123" }, description: "Run fix" }],
    async run(c) {
      if (!existsSync(engine.dbPathFor(c.options.session))) return missingSession(c, c.options.session);

      const cur = await engine.state(c.options.session);
      if (cur.status === "failed") return fusionFailedError(c, c.options.session, cur.phase);
      if (cur.needsResume) return needsResumeError(c, c.options.session);
      if (isTerminalPhase(cur.phase)) return terminalError(c, c.options.session, cur.phase);
      if (!(cur.phase === "review" && cur.lgtm === false)) {
        return wrongPhase(c, c.options.session, commandFor(cur.phase), "Run the current phase command");
      }

      const st = await engine.advance(c.options.session);
      if (st.status === "failed") return fusionFailedError(c, c.options.session, st.phase);
      if (st.needsResume) return needsResumeError(c, c.options.session);
      return c.ok(
        { session: c.options.session, phase: st.phase, fix: st.output },
        { cta: nextCta("Next:", `review --session ${c.options.session}`, "Review the fixed changes") },
      );
    },
  });

  cli.command("resume", {
    description: "Resume a run interrupted mid-step (crash recovery).",
    options: z.object({ session: z.string() }),
    output: z.object({ ...baseCommandOutput, lgtm: z.boolean().nullable() }),
    examples: [{ options: { session: "of-123" }, description: "Resume an interrupted run" }],
    async run(c) {
      if (!existsSync(engine.dbPathFor(c.options.session))) return missingSession(c, c.options.session);
      let st = await engine.resume(c.options.session);
      if (st.status === "failed") return fusionFailedError(c, c.options.session, st.phase);
      // If recovery landed on an LGTM verdict awaiting acknowledgement, finish
      // it (mirrors the review command's auto-ack) so the run reaches `done`.
      if (st.phase === "review" && st.pendingGate && st.lgtm === true) {
        st = await engine.advance(c.options.session);
        if (st.status === "failed") return fusionFailedError(c, c.options.session, st.phase);
      }
      const next = nextCommandFor(c.options.session, st);
      return c.ok(
        { session: c.options.session, phase: st.phase, lgtm: st.lgtm },
        next ? { cta: nextCta(next.label, next.command, next.description) } : undefined,
      );
    },
  });

  cli.command("reject", {
    description: "Deny the pending durable gate and stop the run.",
    options: z.object({
      session: z.string(),
      note: z.string().optional(),
    }),
    output: z.object({ session: z.string(), phase: z.string() }),
    examples: [{ options: { session: "of-123" }, description: "Reject the pending gate" }],
    async run(c) {
      if (!existsSync(engine.dbPathFor(c.options.session))) return missingSession(c, c.options.session);
      const cur = await engine.state(c.options.session);
      if (cur.status === "failed") return fusionFailedError(c, c.options.session, cur.phase);
      if (cur.needsResume) return needsResumeError(c, c.options.session);
      if (isTerminalPhase(cur.phase)) return terminalError(c, c.options.session, cur.phase);
      const st = await engine.advance(c.options.session, "deny", c.options.note);
      return c.ok({ session: c.options.session, phase: st.phase });
    },
  });

  cli.command("status", {
    description: "Show durable run status.",
    options: z.object({ session: z.string() }),
    output: z.object({
      session: z.string(),
      status: z.string(),
      phase: z.string(),
      iteration: z.number(),
      lgtm: z.boolean().nullable(),
      pendingGate: z.string().nullable(),
      needsResume: z.boolean(),
    }),
    examples: [{ options: { session: "of-123" }, description: "Check run status" }],
    async run(c) {
      if (!existsSync(engine.dbPathFor(c.options.session))) return missingSession(c, c.options.session);
      const st = await engine.state(c.options.session);
      return c.ok({
        session: c.options.session,
        status: st.status,
        phase: st.phase,
        iteration: st.iteration,
        lgtm: st.lgtm,
        pendingGate: st.pendingGate,
        needsResume: st.needsResume,
      });
    },
  });

  cli.command("result", {
    description: "Show the current durable run output.",
    options: z.object({ session: z.string() }),
    output: z.object({
      session: z.string(),
      phase: z.string(),
      lgtm: z.boolean().nullable(),
      output: looseOutput,
    }),
    examples: [{ options: { session: "of-123" }, description: "Show run output" }],
    async run(c) {
      if (!existsSync(engine.dbPathFor(c.options.session))) return missingSession(c, c.options.session);
      const st = await engine.state(c.options.session);
      return c.ok({ session: c.options.session, phase: st.phase, lgtm: st.lgtm, output: st.output });
    },
  });

  cli.command("fuse", {
    description: "Run one raw fusion prompt.",
    args: z.object({ prompt: z.string().describe("Prompt to run through the fusion") }),
    options: z.object({
      panel: z
        .string()
        .optional()
        .describe(
          "Comma-separated models: account labels, subscription providers (claude-code, codex, gemini), or openrouter:<vendor/model> / compat:<model>. Defaults to your registered subscriptions.",
        ),
      judge: z.string().optional().describe("Judge model (same id forms as --panel)"),
    }),
    output: z.object({
      answer: z.string(),
      judgment: judgmentOutput,
      panel: panelOutput,
    }),
    examples: [{ args: { prompt: "Compare these approaches" }, description: "Run a raw fusion" }],
    async run(c) {
      let panel: string[];
      let judge: string;
      try {
        // Resolve BOTH here so a NO_MODELS failure (panel or judge) is caught;
        // otherwise the judge default throws deep inside runFusion, unhandled.
        panel = splitList(c.options.panel) ?? defaultPanel();
        judge = c.options.judge ?? defaultJudge();
      } catch (e) {
        return noModels(c, e);
      }
      const result = await fuseRaw({ prompt: c.args.prompt, panel, judge });
      return c.ok({ answer: result.answer, judgment: result.judgment, panel: result.panel });
    },
  });

  return cli;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
  return models.length > 0 ? models : undefined;
}

function commandFor(phase: string): string {
  if (phase === "plan") return "implement";
  if (phase === "implement" || phase === "fix") return "review";
  if (phase === "review") return "fix";
  return "result";
}

/** The command to run next given a (non-error) state, for a CTA. */
function nextCommandFor(
  id: string,
  st: EngineState,
): { label: string; command: string; description: string } | null {
  if (isTerminalPhase(st.phase)) {
    return { label: "Done:", command: `result --session ${id}`, description: "Show the final result" };
  }
  if (st.needsResume) {
    return { label: "Recover:", command: `resume --session ${id}`, description: "Resume the interrupted run" };
  }
  switch (st.phase) {
    case "plan":
      return { label: "Next:", command: `implement --session ${id}`, description: "Run the implementation fusion" };
    case "implement":
      return { label: "Next:", command: `review --session ${id}`, description: "Run the review fusion" };
    case "review":
      return st.lgtm === false
        ? { label: "Next:", command: `fix --session ${id}`, description: "Run the fix fusion" }
        : { label: "Next:", command: `review --session ${id}`, description: "Acknowledge the review" };
    case "fix":
      return { label: "Next:", command: `review --session ${id}`, description: "Review the fixed changes" };
    default:
      return null;
  }
}

type ErrorWithCta = {
  error(input: {
    code: string;
    message: string;
    retryable: boolean;
    cta: { description: string; commands: { command: string; description: string }[] };
  }): never;
};

/** A run interrupted mid-step (no pending gate but not terminal) needs `resume`. */
function needsResumeError(c: ErrorWithCta, id: string): never {
  return c.error({
    code: "NEEDS_RESUME",
    message: `Run was interrupted mid-step. Run resume --session ${id} to drive it to the next gate.`,
    retryable: true,
    cta: nextCta("Recover:", `resume --session ${id}`, "Resume the interrupted run"),
  });
}

function fusionFailedError(c: ErrorWithCta, id: string, phase: string): never {
  return c.error({
    code: "FUSION_FAILED",
    message:
      `The ${phase} fusion failed to produce valid output; this run cannot be resumed. ` +
      `Run result --session ${id} to inspect it, or start a new run.`,
    retryable: false,
    cta: nextCta("Inspect it:", `result --session ${id}`, "Show the current run output"),
  });
}

/** A finished run (done/stopped/exhausted) cannot be advanced — point to `result`. */
function terminalError(c: ErrorWithCta, id: string, phase: string): never {
  const reason =
    phase === "stopped"
      ? "Run is stopped — a gate was denied."
      : phase === "exhausted"
        ? "Run exhausted its review budget without reaching LGTM."
        : "Run is already complete.";
  return c.error({
    code: "RUN_TERMINAL",
    message: `${reason} Run result --session ${id} to view it, or start a new run.`,
    retryable: false,
    cta: nextCta("View it:", `result --session ${id}`, "Show the final result"),
  });
}

function missingSession(
  c: { error(input: { code: string; message: string; retryable: boolean }): never },
  id: string,
): never {
  return c.error({
    code: "SESSION_NOT_FOUND",
    message: `Session not found: ${id}`,
    retryable: false,
  });
}

function wrongPhase(
  c: {
    error(input: {
      code: string;
      message: string;
      retryable: boolean;
      cta: { description: string; commands: { command: string; description: string }[] };
    }): never;
  },
  id: string,
  command: string,
  description: string,
): never {
  return c.error({
    code: "WRONG_PHASE",
    message: `Wrong phase for this command. Run ${command} --session ${id}.`,
    retryable: false,
    cta: nextCta("Next:", `${command} --session ${id}`, description),
  });
}

function noModels(
  c: { error(input: { code: string; message: string; retryable: boolean }): never },
  e: unknown,
): never {
  // The message already names `smithers agents add` (a separate CLI). No `cta`
  // here: incur prefixes the bin name to cta commands, which would mislead it
  // into `open-fusions smithers agents add`.
  return c.error({
    code: "NO_MODELS",
    message: e instanceof Error ? e.message : String(e),
    retryable: false,
  });
}

function nextCta(description: string, command: string, commandDescription: string) {
  return {
    description,
    commands: [{ command, description: commandDescription }],
  };
}

export default createCli();
