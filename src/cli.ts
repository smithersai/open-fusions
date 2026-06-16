import { Cli, z } from "incur";
import { defaultPanel } from "./agents";
import { runFusion, type FuseResult } from "./fusion";
import {
  defaultPhaseFusion,
  runFix,
  runImplement,
  runPlan,
  runReview,
  type PhaseFusion,
} from "./phases";
import { fix, implementation, plan, reviewVerdict, sessionState } from "./schemas";
import { SessionStore } from "./session";
import type { FusionConfig } from "./types";

export type CliDeps = {
  fusion: PhaseFusion;
  store: SessionStore;
  fuseRaw: (config: FusionConfig & { prompt: string }) => Promise<FuseResult>;
  getDiff: (cwd?: string) => string;
};

const panelOutput = z.array(
  z.object({
    model: z.string(),
    answer: z.string(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  }),
);

const judgmentOutput = z.object({
  consensus: z.array(z.string()),
  contradictions: z.array(
    z.object({
      topic: z.string(),
      positions: z.array(z.string()),
    }),
  ),
  uniqueInsights: z.array(
    z.object({
      model: z.string(),
      insight: z.string(),
    }),
  ),
  blindSpots: z.array(z.string()),
  recommendation: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

export function createCli(deps?: Partial<CliDeps>) {
  const resolved: CliDeps = {
    fusion: deps?.fusion ?? defaultPhaseFusion,
    store: deps?.store ?? new SessionStore(),
    fuseRaw: deps?.fuseRaw ?? runFusion,
    getDiff: deps?.getDiff ?? defaultGetDiff,
  };

  const cli = Cli.create("open-fusions", {
    version: "0.0.0",
    description: "Run local model fusions and advance the plan-implement-review-fix loop.",
    sync: {
      suggestions: ["plan a change with a fusion", "review my branch with a fusion"],
    },
  });

  cli.command("fuse", {
    description: "Run one raw fusion prompt.",
    args: z.object({ prompt: z.string().describe("Prompt to run through the fusion") }),
    options: z.object({
      panel: z.string().optional().describe("Comma-separated model ids"),
      judge: z.string().optional().describe("Judge model id"),
    }),
    output: z.object({
      answer: z.string(),
      judgment: judgmentOutput,
      panel: panelOutput,
    }),
    examples: [{ args: { prompt: "Compare these approaches" }, description: "Run a raw fusion" }],
    async run(c) {
      const config: FusionConfig & { prompt: string } = {
        prompt: c.args.prompt,
        panel: c.options.panel ? splitPanel(c.options.panel) : defaultPanel(),
        ...(c.options.judge ? { judge: c.options.judge } : undefined),
      };
      const result = await resolved.fuseRaw(config);

      return c.ok({
        answer: result.answer,
        judgment: result.judgment,
        panel: result.panel,
      });
    },
  });

  cli.command("plan", {
    description: "Plan a change with a fusion.",
    args: z.object({ task: z.string().describe("Task to plan") }),
    options: z.object({ session: z.string().optional() }),
    output: z.object({
      session: z.string(),
      phase: z.string(),
      plan,
    }),
    examples: [{ args: { task: "add rate limiting" }, description: "Plan a change" }],
    async run(c) {
      const session = c.options.session
        ? resolved.store.load(c.options.session)
        : resolved.store.create({ task: c.args.task });
      if (!session) {
        return missingSession(c, c.options.session);
      }

      const result = await runPlan(session, resolved);
      const id = result.session.id;
      return c.ok(
        {
          session: id,
          phase: result.session.phase,
          plan: result.session.plan!,
        },
        { cta: nextCta("Next:", `implement --session ${id}`, "Run the implementation fusion") },
      );
    },
  });

  cli.command("implement", {
    description: "Implement the current session plan with a fusion.",
    options: z.object({ session: z.string() }),
    output: z.object({
      session: z.string(),
      phase: z.string(),
      implementation,
    }),
    examples: [
      { options: { session: "s-123" }, description: "Implement the next session phase" },
    ],
    async run(c) {
      const session = resolved.store.load(c.options.session);
      if (!session) {
        return missingSession(c, c.options.session);
      }

      const result = await runImplement(session, resolved);
      const id = result.session.id;
      return c.ok(
        {
          session: id,
          phase: result.session.phase,
          implementation: result.session.implementation!,
        },
        { cta: nextCta("Next:", `review --session ${id}`, "Run the review fusion") },
      );
    },
  });

  cli.command("review", {
    description: "Review the current implementation diff with a fusion.",
    options: z.object({
      session: z.string(),
      diff: z.string().optional(),
    }),
    output: z.object({
      session: z.string(),
      phase: z.string(),
      verdict: reviewVerdict,
      lgtm: z.boolean(),
    }),
    examples: [{ options: { session: "s-123" }, description: "Review the session changes" }],
    async run(c) {
      const session = resolved.store.load(c.options.session);
      if (!session) {
        return missingSession(c, c.options.session);
      }

      const diff = c.options.diff ?? resolved.getDiff();
      const result = await runReview(session, resolved, undefined, diff);
      const id = result.session.id;
      const verdict = result.session.lastReview!;
      const command = verdict.lgtm ? `result --session ${id}` : `fix --session ${id}`;
      const description = verdict.lgtm ? "LGTM - done" : "Run the fix fusion";

      return c.ok(
        {
          session: id,
          phase: result.session.phase,
          verdict,
          lgtm: verdict.lgtm,
        },
        { cta: nextCta("Next:", command, description) },
      );
    },
  });

  cli.command("fix", {
    description: "Fix review issues with a fusion.",
    options: z.object({ session: z.string() }),
    output: z.object({
      session: z.string(),
      phase: z.string(),
      fix,
    }),
    examples: [{ options: { session: "s-123" }, description: "Fix the session review issues" }],
    async run(c) {
      const session = resolved.store.load(c.options.session);
      if (!session) {
        return missingSession(c, c.options.session);
      }

      const result = await runFix(session, resolved);
      const id = result.session.id;
      return c.ok(
        {
          session: id,
          phase: result.session.phase,
          fix: fix.parse(result.output),
        },
        { cta: nextCta("Next:", `review --session ${id}`, "Review the fixed changes") },
      );
    },
  });

  cli.command("status", {
    description: "Show the current session status.",
    options: z.object({ session: z.string() }),
    output: z.object({
      session: z.string(),
      task: z.string(),
      phase: z.string(),
      iteration: z.number(),
      lgtm: z.boolean().nullable(),
    }),
    examples: [{ options: { session: "s-123" }, description: "Check session status" }],
    run(c) {
      const session = resolved.store.load(c.options.session);
      if (!session) {
        return missingSession(c, c.options.session);
      }

      return c.ok({
        session: session.id,
        task: session.task,
        phase: session.phase,
        iteration: session.iteration,
        lgtm: session.lastReview?.lgtm ?? null,
      });
    },
  });

  cli.command("result", {
    description: "Show the full session result.",
    options: z.object({ session: z.string() }),
    output: sessionState,
    examples: [{ options: { session: "s-123" }, description: "Show final session result" }],
    run(c) {
      const session = resolved.store.load(c.options.session);
      if (!session) {
        return missingSession(c, c.options.session);
      }

      return c.ok(session);
    },
  });

  return cli;
}

function splitPanel(panel: string): string[] {
  return panel
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}

function defaultGetDiff(cwd?: string): string {
  try {
    const result = Bun.spawnSync(["git", "diff"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      return "";
    }

    return new TextDecoder().decode(result.stdout);
  } catch {
    return "";
  }
}

function missingSession(
  c: { error(input: { code: string; message: string; retryable: boolean }): never },
  id: string | undefined,
): never {
  return c.error({
    code: "SESSION_NOT_FOUND",
    message: `Session not found: ${id ?? "(missing)"}`,
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
