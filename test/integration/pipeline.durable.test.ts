import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { OpenFusionsEngine } from "../../src/engine";
import type { AgentLike } from "../../src/types";

// A single deterministic stub agent serves every role/phase by matching the
// output schema smithers passes to generate(). The review verdict flips to lgtm
// on the second review so the review→fix→review loop terminates.
function makeStubAgentFor(): () => AgentLike {
  let reviewCount = 0;
  const cannedFor = (schema: unknown): unknown => {
    const verdict = {
      lgtm: reviewCount > 0,
      summary: reviewCount > 0 ? "looks good" : "needs work",
      issues: reviewCount > 0 ? [] : [{ severity: "high", description: "handle the edge case" }],
    };
    const candidates: unknown[] = [
      { steps: [{ title: "step one", detail: "do the thing" }], risks: ["risky"], files: ["a.ts"] }, // plan
      { summary: "implemented", changes: [{ file: "a.ts", description: "added thing" }] }, // implementation / fix
      verdict, // reviewVerdict
      { model: "stub", answer: "an answer", confidence: "high" }, // panelResponse
      {
        consensus: ["c"],
        contradictions: [],
        uniqueInsights: [],
        blindSpots: [],
        recommendation: "rec",
        confidence: "high",
      }, // judgment
      { answer: "final", caveats: [] }, // finalAnswer
    ];
    const parse = (schema as { safeParse?: (v: unknown) => { success: boolean } } | undefined)?.safeParse;
    for (const candidate of candidates) {
      if (parse?.(candidate)?.success) {
        if (candidate === verdict) reviewCount += 1;
        return candidate;
      }
    }
    return {};
  };
  const agent = {
    supportsNativeStructuredOutput: true,
    async generate(args?: unknown) {
      const outputSchema = (args as { outputSchema?: unknown } | undefined)?.outputSchema;
      return { output: cannedFor(outputSchema) };
    },
  };
  return (): AgentLike => agent;
}

const dir = `/tmp/of-durable-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("durable pipeline advances plan→implement→review→fix→review→done across separate engine builds", async () => {
  // A fresh engine per call models a fresh process resuming the same durable run.
  const engineOpts = {
    dir,
    agentFor: makeStubAgentFor(),
    panel: ["model/a", "model/b"],
    judge: "model/judge",
  };
  // Reuse one stub closure (its reviewCount must persist) but rebuild the engine each step.
  const sharedAgentFor = makeStubAgentFor();
  const newEngine = () => new OpenFusionsEngine({ ...engineOpts, agentFor: sharedAgentFor });

  // PLAN
  const started = await newEngine().start("add rate limiting", "run-1");
  expect(started.phase).toBe("plan");
  expect(started.pendingGate).toBe("plan-gate");
  expect((started.output as { steps: unknown[] }).steps.length).toBeGreaterThan(0);

  // IMPLEMENT
  const implemented = await newEngine().advance("run-1");
  expect(implemented.phase).toBe("implement");
  expect(implemented.pendingGate).toBe("impl-gate");
  expect((implemented.output as { summary: string }).summary).toBeTruthy();

  // REVIEW (first → not lgtm)
  const reviewed = await newEngine().advance("run-1");
  expect(reviewed.phase).toBe("review");
  expect(reviewed.pendingGate).toBe("review-0-gate");
  expect(reviewed.lgtm).toBe(false);

  // FIX
  const fixed = await newEngine().advance("run-1");
  expect(fixed.phase).toBe("fix");
  expect(fixed.pendingGate).toBe("fix-0-gate");

  // REVIEW (second → lgtm)
  const reviewed2 = await newEngine().advance("run-1");
  expect(reviewed2.phase).toBe("review");
  expect(reviewed2.pendingGate).toBe("review-1-gate");
  expect(reviewed2.lgtm).toBe(true);

  // ACKNOWLEDGE final review → done
  const done = await newEngine().advance("run-1");
  expect(done.phase).toBe("done");
  expect(done.pendingGate).toBeNull();
  expect(done.status).toBe("finished");

  // A read-only state() call reports the same terminal state.
  const state = await newEngine().state("run-1");
  expect(state.phase).toBe("done");
}, 60_000);
