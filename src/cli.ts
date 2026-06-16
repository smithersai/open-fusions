import { existsSync } from "node:fs";
import { Cli, z } from "incur";
import { defaultJudge, defaultPanel } from "./agents";
import { OpenFusionsEngine } from "./engine";
import { runFusion, type FuseResult } from "./fusion";
import type { FusionConfig } from "./types";

export type CliDeps = {
  engine: OpenFusionsEngine;
  fuseRaw: (config: FusionConfig & { prompt: string }) => Promise<FuseResult>;
};

const looseOutput = z.unknown();

const ctaSchema = z
  .object({
    description: z.string(),
    commands: z.array(z.object({ command: z.string(), description: z.string() })),
  })
  .optional();

const baseCommandOutput = {
  session: z.string(),
  phase: z.string(),
  cta: ctaSchema,
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
    version: "0.0.0",
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
      const st = await engine.start(c.args.task, { panel, judge }, c.options.session);
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
      if (cur.phase !== "plan") {
        return wrongPhase(c, c.options.session, commandFor(cur.phase), "Run the current phase command");
      }

      const st = await engine.advance(c.options.session);
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
      if (cur.phase !== "implement" && cur.phase !== "fix") {
        return wrongPhase(c, c.options.session, commandFor(cur.phase), "Run the current phase command");
      }

      const st = await engine.advance(c.options.session);
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
      if (!(cur.phase === "review" && cur.lgtm === false)) {
        return wrongPhase(c, c.options.session, commandFor(cur.phase), "Run the current phase command");
      }

      const st = await engine.advance(c.options.session);
      return c.ok(
        { session: c.options.session, phase: st.phase, fix: st.output },
        { cta: nextCta("Next:", `review --session ${c.options.session}`, "Review the fixed changes") },
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
      const st = await engine.advance(c.options.session, "deny", c.options.note);
      return c.ok({ session: c.options.session, phase: st.phase });
    },
  });

  cli.command("status", {
    description: "Show durable run status.",
    options: z.object({ session: z.string() }),
    output: z.object({
      session: z.string(),
      phase: z.string(),
      iteration: z.number(),
      lgtm: z.boolean().nullable(),
      pendingGate: z.string().nullable(),
    }),
    examples: [{ options: { session: "of-123" }, description: "Check run status" }],
    async run(c) {
      if (!existsSync(engine.dbPathFor(c.options.session))) return missingSession(c, c.options.session);
      const st = await engine.state(c.options.session);
      return c.ok({
        session: c.options.session,
        phase: st.phase,
        iteration: st.iteration,
        lgtm: st.lgtm,
        pendingGate: st.pendingGate,
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
      try {
        panel = splitList(c.options.panel) ?? defaultPanel();
      } catch (e) {
        return noModels(c, e);
      }
      const result = await fuseRaw({
        prompt: c.args.prompt,
        panel,
        ...(c.options.judge ? { judge: c.options.judge } : undefined),
      });
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
