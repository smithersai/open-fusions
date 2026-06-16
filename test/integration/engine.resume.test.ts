import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { OpenFusionsEngine } from "../../src/engine";
import type { AgentLike } from "../../src/types";

// Stateful stub: while `failReview` is set, the review SYNTH returns an invalid
// shape (so its row never persists); flipping it off lets a resume produce it.
function makeStubAgentFor(state: { failReview: boolean }): () => AgentLike {
  const cannedFor = (schema: unknown): unknown => {
    const candidates: unknown[] = [
      { steps: [{ title: "s", detail: "d" }], risks: [], files: ["a.ts"] },
      { summary: "implemented", changes: [{ file: "a.ts", description: "x" }] },
      { lgtm: false, summary: "needs work", issues: [{ severity: "high", description: "fix it" }] },
      { model: "stub", answer: "a", confidence: "high" },
      { consensus: ["c"], contradictions: [], uniqueInsights: [], blindSpots: [], recommendation: "r", confidence: "high" },
      { answer: "final", caveats: [] },
    ];
    const parse = (schema as { safeParse?: (v: unknown) => { success: boolean } } | undefined)?.safeParse;
    // The review-synth schema accepts {lgtm,...} but not a plan; identify it so
    // we can selectively fail it without touching panel/judge.
    const isReviewVerdict =
      parse?.({ lgtm: false, summary: "x", issues: [] })?.success === true &&
      parse?.({ steps: [], risks: [], files: [] })?.success !== true;
    if (isReviewVerdict && state.failReview) return { not: "a verdict" };
    for (const c of candidates) if (parse?.(c)?.success) return c;
    return {};
  };
  const agent = {
    supportsNativeStructuredOutput: true,
    async generate(args?: unknown) {
      return { output: cannedFor((args as { outputSchema?: unknown } | undefined)?.outputSchema) };
    },
  };
  return (): AgentLike => agent;
}

const dir = `/tmp/of-resume-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a run interrupted mid-fusion (gate committed, synth missing, status running) is resumable, not stuck", async () => {
  const state = { failReview: true };
  const agentFor = makeStubAgentFor(state);
  const newEngine = () => new OpenFusionsEngine({ dir, agentFor });
  const runId = "run-crash";

  await newEngine().start("task", { panel: ["a", "b"], judge: "j" }, runId);
  await newEngine().advance(runId); // -> impl-gate
  // This advance approves impl-gate (durably committed during the resume) and
  // runs the review fusion; the synth fails permanently, so the returned state
  // is failed before the DB surgery below reconstructs a genuine crash.
  const failed = await newEngine().advance(runId);
  expect(failed.phase).toBe("review");
  expect(failed.pendingGate).toBeNull();
  expect(failed.status).toBe("failed");
  expect(failed.needsResume).toBe(false);

  // Model a genuine crash *during* the review synth: the impl-gate approval was
  // durably committed and the panel/judge finished, but the process died before
  // the synth completed — so its node/attempt records are absent (interrupted,
  // not failed-and-exhausted) and the run status was never finalized ("running").
  // continueOnFail instead records "failed/finished", which is NOT what a crash
  // leaves, so we reconstruct the true crash state here.
  const db = new Database(join(dir, `${runId}.db`));
  expect(db.query("SELECT COUNT(*) AS n FROM gate WHERE node_id='impl-gate'").get() as { n: number }).toMatchObject({ n: 1 });
  db.query("DELETE FROM _smithers_nodes WHERE run_id=? AND node_id='review-0-synth'").run(runId);
  db.query("DELETE FROM _smithers_attempts WHERE run_id=? AND node_id='review-0-synth'").run(runId);
  db.query("UPDATE _smithers_runs SET status='running', finished_at_ms=NULL WHERE run_id=?").run(runId);
  db.close();

  const stuck = await newEngine().state(runId);
  expect(stuck.phase).toBe("review");
  expect(stuck.pendingGate).toBeNull();
  expect(stuck.needsResume).toBe(true);

  // The synth would succeed now — resume() must drive the in-flight fusion
  // forward instead of doing nothing.
  state.failReview = false;
  const recovered = await newEngine().resume(runId);
  expect(recovered.phase).toBe("review");
  expect(recovered.pendingGate).toBe("review-0-gate");
  expect(recovered.needsResume).toBe(false);
  expect(recovered.lgtm).toBe(false);

  // resume() on a run that is already at a gate is a safe no-op.
  const again = await newEngine().resume(runId);
  expect(again.pendingGate).toBe("review-0-gate");
}, 60_000);

test("start() refuses to clobber an existing run id (advise resume/advance instead)", async () => {
  const agentFor = makeStubAgentFor({ failReview: false });
  const engine = new OpenFusionsEngine({ dir, agentFor });
  const runId = "run-dupe";
  await engine.start("first task", { panel: ["a"], judge: "j" }, runId);
  await expect(
    engine.start("a totally different task", { panel: ["x"], judge: "y" }, runId),
  ).rejects.toThrow(/already exists/i);
}, 60_000);

test("resume converges permanent synth failure to a non-resumable failed state", async () => {
  const agentFor = makeStubAgentFor({ failReview: true });
  const newEngine = () => new OpenFusionsEngine({ dir, agentFor });
  const runId = "run-permanent-failure";

  await newEngine().start("task", { panel: ["a"], judge: "j" }, runId);
  await newEngine().advance(runId); // -> impl-gate
  const failedAdvance = await newEngine().advance(runId); // review synth fails permanently
  expect(failedAdvance.phase).toBe("review");
  expect(failedAdvance.pendingGate).toBeNull();
  expect(failedAdvance.status).toBe("failed");
  expect(failedAdvance.needsResume).toBe(false);

  const firstResume = await newEngine().resume(runId);
  expect(firstResume.phase).toBe("review");
  expect(firstResume.status).toBe("failed");
  expect(firstResume.needsResume).toBe(false);

  const freshState = await newEngine().state(runId);
  expect(freshState.phase).toBe("review");
  expect(freshState.status).toBe("failed");
  expect(freshState.needsResume).toBe(false);

  const secondResume = await newEngine().resume(runId);
  expect(secondResume.phase).toBe("review");
  expect(secondResume.status).toBe("failed");
  expect(secondResume.needsResume).toBe(false);
}, 60_000);
