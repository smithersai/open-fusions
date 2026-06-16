import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

// Each step runs in a genuinely separate `bun` process — no shared module state,
// no in-process counter. This is the real test of the package's headline claim
// that a durable run is rebuilt identically on every process and survives
// restarts (the in-process "separate engine builds" test cannot prove that).
const dir = `/tmp/of-xproc-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
const script = join(import.meta.dir, "fixtures", "cross-process-step.ts");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function step(action: string, runId: string): Promise<{ phase: string; pendingGate: string | null; lgtm: boolean | null }> {
  const proc = Bun.spawn(["bun", "run", script, action, dir, runId], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const match = out.match(/__OF__(.*?)__OF__/);
  if (!match) throw new Error(`child produced no result\nstdout:\n${out}\nstderr:\n${err}`);
  return JSON.parse(match[1]!);
}

test("a durable run advances plan→implement→review→done across separate OS processes", async () => {
  const runId = "xproc-1";

  expect(await step("start", runId)).toMatchObject({ phase: "plan", pendingGate: "plan-gate" });
  expect(await step("advance", runId)).toMatchObject({ phase: "implement", pendingGate: "impl-gate" });
  expect(await step("advance", runId)).toMatchObject({ phase: "review", pendingGate: "review-0-gate", lgtm: true });
  expect(await step("advance", runId)).toMatchObject({ phase: "done", pendingGate: null });

  // A read-only state() in yet another fresh process agrees.
  expect(await step("state", runId)).toMatchObject({ phase: "done" });
}, 120_000);
