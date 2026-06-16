import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runFix, runImplement, runPlan, runReview, type PhaseFusion } from "../../src/phases";
import { fix, implementation, plan, reviewVerdict } from "../../src/schemas";
import { SessionStore } from "../../src/session";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): SessionStore {
  const dir = join("/tmp", `open-fusions-phases-${Date.now()}-${Math.random()}`);
  dirs.push(dir);
  return new SessionStore(dir);
}

function mockFusion(outputs: unknown[]): PhaseFusion {
  const queue = [...outputs];
  return async ({ schema }) => {
    const output = queue.shift();
    if (output === undefined) {
      throw new Error("No mocked phase output available");
    }
    schema.parse(output);
    return {
      output,
      judgment: {
        consensus: [],
        contradictions: [],
        uniqueInsights: [],
        blindSpots: [],
        recommendation: "mock",
        confidence: "high",
      },
      panel: [],
      status: "finished",
    };
  };
}

describe("phase runners", () => {
  test("advance plan, implement, review, fix, and review completion", async () => {
    const store = tempStore();
    const session = store.create({ task: "Add phase runners", id: "s-phases" });
    store.save(session);

    const planned = plan.parse({
      steps: [{ title: "Build", detail: "Add session and phase modules" }],
      risks: [],
      files: ["src/session.ts", "src/phases.ts"],
    });
    const implemented = implementation.parse({
      summary: "Implemented phase runners",
      changes: [{ file: "src/phases.ts", description: "Added runners" }],
    });
    const needsFix = reviewVerdict.parse({
      lgtm: false,
      summary: "Needs one fix",
      issues: [{ severity: "medium", description: "Missing export" }],
    });
    const fixed = fix.parse({
      summary: "Added missing export",
      changes: [{ file: "src/index.ts", description: "Exported phases" }],
    });
    const approved = reviewVerdict.parse({
      lgtm: true,
      summary: "Looks good",
      issues: [],
    });
    const deps = { store, fusion: mockFusion([planned, implemented, needsFix, fixed, approved]) };

    const planResult = await runPlan(session, deps);
    expect(planResult.session.plan).toEqual(planned);
    expect(planResult.session.phase).toBe("implement");

    const implementResult = await runImplement(planResult.session, deps);
    expect(implementResult.session.implementation).toEqual(implemented);
    expect(implementResult.session.phase).toBe("review");

    const reviewResult = await runReview(implementResult.session, deps, undefined, "diff");
    expect(reviewResult.session.lastReview).toEqual(needsFix);
    expect(reviewResult.session.phase).toBe("fix");

    const fixResult = await runFix(reviewResult.session, deps);
    expect(fixResult.session.phase).toBe("review");

    const doneResult = await runReview(fixResult.session, deps, undefined, "fixed diff");
    expect(doneResult.session.lastReview?.lgtm).toBe(true);
    expect(doneResult.session.phase).toBe("review");
  });
});
