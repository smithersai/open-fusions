import { describe, expect, test } from "bun:test";
import { deriveStateFromOutputs } from "../../src/engine";
import { MAX_REVIEW_ITERATIONS } from "../../src/pipeline";

type Row = Record<string, unknown> & { nodeId?: string };
type Outputs = Record<string, Row[] | undefined>;

const planRow = { nodeId: "plan-synth", steps: [{ title: "step", detail: "d" }], risks: [], files: [] };
const implRow = { nodeId: "impl-synth", summary: "impl", changes: [] };
const review = (k: number, lgtm: boolean): Row => ({ nodeId: `review-${k}-synth`, lgtm, summary: "r", issues: [] });
const fixRow = (k: number): Row => ({ nodeId: `fix-${k}-synth`, summary: "fix", changes: [] });
const gate = (nodeId: string, approved: boolean): Row => ({ nodeId, approved });

const derive = (outs: Outputs) => deriveStateFromOutputs("run-1", "waiting-approval", outs);

describe("deriveStateFromOutputs", () => {
  test("no outputs → plan phase, no gate", () => {
    expect(derive({})).toMatchObject({ phase: "plan", pendingGate: null, lgtm: null, output: undefined });
  });

  test("plan synthesized but not gated → pending plan-gate", () => {
    expect(derive({ plan: [planRow] })).toMatchObject({ phase: "plan", pendingGate: "plan-gate" });
  });

  test("needsResume: true for a mid-flight phase with no pending gate, false otherwise", () => {
    // Impl approved but no implementation output yet → in-flight, must resume.
    expect(
      derive({ plan: [planRow], gate: [gate("plan-gate", true)] }),
    ).toMatchObject({ phase: "implement", pendingGate: null, needsResume: true });
    // Sitting at a gate → nothing to resume.
    expect(derive({ plan: [planRow] })).toMatchObject({ pendingGate: "plan-gate", needsResume: false });
    // Terminal → nothing to resume.
    expect(
      derive({ plan: [planRow], gate: [gate("plan-gate", false)] }),
    ).toMatchObject({ phase: "stopped", needsResume: false });
  });

  test("status reflects the lifecycle, never the fabricated 'loaded' placeholder", () => {
    expect(derive({}).status).not.toBe("loaded");
    expect(derive({ plan: [planRow] }).status).toBe("waiting-approval");
    const doneOuts = {
      plan: [planRow],
      implementation: [implRow],
      reviewVerdict: [review(0, true)],
      gate: [gate("plan-gate", true), gate("impl-gate", true), gate("review-0-gate", true)],
    };
    expect(deriveStateFromOutputs("r", "finished", doneOuts).status).toBe("finished");
  });

  test("output strips run/node/iteration metadata", () => {
    const out = derive({ plan: [{ ...planRow, runId: "x", iteration: 3 }] }).output as Record<string, unknown>;
    expect(out).not.toHaveProperty("nodeId");
    expect(out).not.toHaveProperty("runId");
    expect(out).not.toHaveProperty("iteration");
    expect(out).toMatchObject({ steps: planRow.steps });
  });

  test("plan gate denied → stopped", () => {
    expect(derive({ plan: [planRow], gate: [gate("plan-gate", false)] })).toMatchObject({ phase: "stopped" });
  });

  test("plan approved, no implementation yet → implement phase", () => {
    expect(derive({ plan: [planRow], gate: [gate("plan-gate", true)] })).toMatchObject({
      phase: "implement",
      pendingGate: null,
    });
  });

  test("implementation synthesized → pending impl-gate", () => {
    const outs = { plan: [planRow], implementation: [implRow], gate: [gate("plan-gate", true)] };
    expect(derive(outs)).toMatchObject({ phase: "implement", pendingGate: "impl-gate" });
  });

  test("impl gate denied → stopped", () => {
    const outs = {
      plan: [planRow],
      implementation: [implRow],
      gate: [gate("plan-gate", true), gate("impl-gate", false)],
    };
    expect(derive(outs)).toMatchObject({ phase: "stopped" });
  });

  test("impl approved, review produced → pending review-0-gate carrying lgtm", () => {
    const outs = {
      plan: [planRow],
      implementation: [implRow],
      reviewVerdict: [review(0, false)],
      gate: [gate("plan-gate", true), gate("impl-gate", true)],
    };
    expect(derive(outs)).toMatchObject({ phase: "review", pendingGate: "review-0-gate", lgtm: false, iteration: 0 });
  });

  test("review LGTM acknowledged → done", () => {
    const outs = {
      plan: [planRow],
      implementation: [implRow],
      reviewVerdict: [review(0, true)],
      gate: [gate("plan-gate", true), gate("impl-gate", true), gate("review-0-gate", true)],
    };
    expect(derive(outs)).toMatchObject({ phase: "done", lgtm: true });
  });

  test("review found issues, acknowledged → fix phase", () => {
    const outs = {
      plan: [planRow],
      implementation: [implRow],
      reviewVerdict: [review(0, false)],
      gate: [gate("plan-gate", true), gate("impl-gate", true), gate("review-0-gate", true)],
    };
    expect(derive(outs)).toMatchObject({ phase: "fix", lgtm: false });
  });

  test("second review LGTM after a fix → done", () => {
    const outs = {
      plan: [planRow],
      implementation: [implRow],
      reviewVerdict: [review(0, false), review(1, true)],
      fix: [fixRow(0)],
      gate: [
        gate("plan-gate", true),
        gate("impl-gate", true),
        gate("review-0-gate", true),
        gate("fix-0-gate", true),
        gate("review-1-gate", true),
      ],
    };
    expect(derive(outs)).toMatchObject({ phase: "done", lgtm: true, iteration: 1 });
  });

  test("exhausting the review→fix budget without LGTM → exhausted, NOT a false done", () => {
    const reviewVerdict: Row[] = [];
    const fix: Row[] = [];
    const gates: Row[] = [gate("plan-gate", true), gate("impl-gate", true)];
    for (let k = 0; k < MAX_REVIEW_ITERATIONS; k++) {
      reviewVerdict.push(review(k, false));
      fix.push(fixRow(k));
      gates.push(gate(`review-${k}-gate`, true));
      gates.push(gate(`fix-${k}-gate`, true));
    }
    const state = derive({ plan: [planRow], implementation: [implRow], reviewVerdict, fix, gate: gates });
    expect(state.phase).toBe("exhausted");
    expect(state.lgtm).toBe(false);
    expect(state.phase).not.toBe("done");
  });
});
