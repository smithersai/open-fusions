import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createCli } from "../../src/cli";
import type { FuseResult } from "../../src/fusion";
import type { PhaseFusion } from "../../src/phases";
import { fix, implementation, judgment, plan, reviewVerdict } from "../../src/schemas";
import type { Fix, Implementation, Plan, ReviewVerdict, SessionState } from "../../src/schemas";
import { SessionStore } from "../../src/session";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): SessionStore {
  const dir = join("/tmp", `open-fusions-cli-${Date.now()}-${Math.random()}`);
  dirs.push(dir);
  return new SessionStore(dir);
}

const judged = judgment.parse({
  consensus: ["consistent"],
  contradictions: [],
  uniqueInsights: [],
  blindSpots: [],
  recommendation: "mock",
  confidence: "high",
});

function mockFusion(): PhaseFusion {
  let reviewCount = 0;

  return async ({ schema }) => {
    let output: unknown;
    if (schema === plan) {
      output = {
        steps: [{ title: "Add logging", detail: "Thread logging through the command path" }],
        risks: ["Noisy output"],
        files: ["src/cli.ts"],
      };
    } else if (schema === implementation) {
      output = {
        summary: "Implemented logging",
        changes: [{ file: "src/cli.ts", description: "Added command logging" }],
      };
    } else if (schema === reviewVerdict) {
      reviewCount += 1;
      output =
        reviewCount === 1
          ? {
              lgtm: false,
              summary: "Needs a fix",
              issues: [{ severity: "medium", description: "Missing edge case" }],
            }
          : {
              lgtm: true,
              summary: "Looks good",
              issues: [],
            };
    } else if (schema === fix) {
      output = {
        summary: "Fixed edge case",
        changes: [{ file: "src/cli.ts", description: "Handled the missing edge case" }],
      };
    } else {
      throw new Error("Unexpected schema");
    }

    schema.parse(output);
    return {
      output,
      judgment: judged,
      panel: [{ model: "mock-panel", answer: "panel answer", confidence: "high" }],
      status: "finished",
    };
  };
}

const mockFuseRaw = async (): Promise<FuseResult> => ({
  answer: "final",
  judgment: judged,
  panel: [{ model: "mock-panel", answer: "panel answer", confidence: "high" }],
  status: "finished",
});

describe("cli", () => {
  test("runs the plan, implement, review, fix loop one command at a time", async () => {
    const store = tempStore();
    const cli = createCli({
      fusion: mockFusion(),
      store,
      fuseRaw: mockFuseRaw,
      getDiff: () => "diff --git a/src/cli.ts b/src/cli.ts",
    });
    const run = createRunner(cli);

    const planned = await run<PlanCommand>(["plan", "add logging"]);
    expect(planned.session).toStartWith("s-");
    expect(planned.phase).toBe("implement");
    expect(planned.plan.steps[0].title).toBe("Add logging");
    expect(planned.cta.commands[0].command).toBe(`open-fusions implement --session ${planned.session}`);

    const implemented = await run<ImplementCommand>(["implement", "--session", planned.session]);
    expect(implemented.session).toBe(planned.session);
    expect(implemented.phase).toBe("review");
    expect(implemented.implementation.summary).toBe("Implemented logging");
    expect(implemented.cta.commands[0].command).toBe(
      `open-fusions review --session ${planned.session}`,
    );

    const reviewed = await run<ReviewCommand>(["review", "--session", planned.session]);
    expect(reviewed.session).toBe(planned.session);
    expect(reviewed.phase).toBe("fix");
    expect(reviewed.lgtm).toBe(false);
    expect(reviewed.verdict.summary).toBe("Needs a fix");
    expect(reviewed.cta.commands[0].command).toBe(`open-fusions fix --session ${planned.session}`);

    const fixed = await run<FixCommand>(["fix", "--session", planned.session]);
    expect(fixed.session).toBe(planned.session);
    expect(fixed.phase).toBe("review");
    expect(fixed.fix.summary).toBe("Fixed edge case");
    expect(fixed.cta.commands[0].command).toBe(`open-fusions review --session ${planned.session}`);

    const approved = await run<ReviewCommand>(["review", "--session", planned.session]);
    expect(approved.session).toBe(planned.session);
    expect(approved.phase).toBe("review");
    expect(approved.lgtm).toBe(true);
    expect(approved.cta.commands[0].command).toBe(`open-fusions result --session ${planned.session}`);

    const status = await run<StatusCommand>(["status", "--session", planned.session]);
    expect(status).toMatchObject({
      session: planned.session,
      task: "add logging",
      phase: "review",
      iteration: 2,
      lgtm: true,
    });

    const result = await run<CompleteSession>(["result", "--session", planned.session]);
    expect(result.id).toBe(planned.session);
    expect(result.plan.steps[0].title).toBe("Add logging");
    expect(result.implementation.summary).toBe("Implemented logging");
    expect(result.lastReview.lgtm).toBe(true);
    expect(result.history).toHaveLength(5);
  });

  test("runs a raw fusion command", async () => {
    const cli = createCli({
      fusion: mockFusion(),
      store: tempStore(),
      fuseRaw: mockFuseRaw,
      getDiff: () => "",
    });

    const fused = await createRunner(cli)<FuseCommand>(["fuse", "q"]);

    expect(fused.answer).toBe("final");
    expect(fused.judgment).toEqual(judged);
    expect(fused.panel).toHaveLength(1);
    expect(fused.cta).toBeUndefined();
  });
});

type Cta = {
  commands: { command: string; description?: string }[];
  description: string;
};

type PlanCommand = { session: string; phase: string; plan: Plan; cta: Cta };
type ImplementCommand = {
  session: string;
  phase: string;
  implementation: Implementation;
  cta: Cta;
};
type ReviewCommand = {
  session: string;
  phase: string;
  verdict: ReviewVerdict;
  lgtm: boolean;
  cta: Cta;
};
type FixCommand = { session: string; phase: string; fix: Fix; cta: Cta };
type StatusCommand = {
  session: string;
  task: string;
  phase: string;
  iteration: number;
  lgtm: boolean | null;
};
type FuseCommand = Omit<FuseResult, "status"> & { cta?: Cta };
type CompleteSession = SessionState & {
  plan: Plan;
  implementation: Implementation;
  lastReview: ReviewVerdict;
};

function createRunner(cli: ReturnType<typeof createCli>): <T>(argv: string[]) => Promise<T> {
  return async <T>(argv: string[]) => {
    let out = "";
    await cli.serve([...argv, "--json"], {
      stdout: (s) => {
        out += s;
      },
      exit: () => {},
      env: {},
    });
    return JSON.parse(out) as T;
  };
}
