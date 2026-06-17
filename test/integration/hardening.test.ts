import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fuse } from "../../src/fusion";
import { FusionError } from "../../src/errors";
import type { AgentLike, PanelMember } from "../../src/types";

const created: string[] = [];
afterEach(() => {
  for (const path of created.splice(0)) {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) unlinkSync(candidate);
    }
  }
});

function stub(output: unknown): AgentLike & { supportsNativeStructuredOutput: true } {
  return { supportsNativeStructuredOutput: true, async generate() { return { output }; } };
}
function member(id: string, output: unknown): PanelMember {
  return { id, spec: id, agent: stub(output) };
}
const judge = () =>
  member("judge", {
    consensus: ["c"],
    contradictions: [],
    uniqueInsights: [],
    blindSpots: [],
    recommendation: "use it",
    confidence: "high",
  });
function dbPath(): string {
  const p = join("/tmp", `smithers-fusions-hardening-${Date.now()}-${Math.random()}.db`);
  created.push(p);
  return p;
}

describe("fusion hardening", () => {
  test("recovers a double-encoded synthesizer answer (CLI-harness shape mangling)", async () => {
    // The synthesizer nested the whole finalAnswer inside the `answer` field —
    // exactly the failure observed live against the codex subscription.
    const synthesizer = member("synth", {
      answer: JSON.stringify({ answer: "A mutex enforces mutual exclusion.", caveats: ["c"] }),
      caveats: [],
    });
    const result = await fuse({
      prompt: "q",
      panel: [member("a", { model: "a", answer: "A", confidence: "high" })],
      judge: judge(),
      synthesizer,
      dbPath: dbPath(),
      runId: `harden-recover-${Date.now()}`,
    });
    expect(result.answer).toBe("A mutex enforces mutual exclusion.");
  });

  test("throws a FusionError (not a raw ZodError) when synth output can't be coerced", async () => {
    const synthesizer = member("synth", { totally: "wrong", shape: 1 });
    const promise = fuse({
      prompt: "q",
      panel: [member("a", { model: "a", answer: "A" })],
      judge: judge(),
      synthesizer,
      dbPath: dbPath(),
      runId: `harden-bad-${Date.now()}`,
    });
    await expect(promise).rejects.toBeInstanceOf(FusionError);
  });

  test("rejects an empty panel before running anything", async () => {
    const promise = fuse({
      prompt: "q",
      panel: [],
      judge: judge(),
      synthesizer: member("synth", { answer: "x", caveats: [] }),
      dbPath: dbPath(),
      runId: `harden-empty-${Date.now()}`,
    });
    await expect(promise).rejects.toBeInstanceOf(FusionError);
  });

  test("returns panel responses in input order even when panelists finish out of order", async () => {
    // `a` resolves slower than `b`, so by completion time the rows are [b, a];
    // the result must still be [a, b] (the order the caller listed the panel).
    const slow = (id: string, ms: number): PanelMember => ({
      id,
      spec: id,
      agent: {
        supportsNativeStructuredOutput: true,
        async generate() {
          await new Promise((r) => setTimeout(r, ms));
          return { output: { model: id, answer: id, confidence: "high" } };
        },
      } as AgentLike & { supportsNativeStructuredOutput: true },
    });
    const result = await fuse({
      prompt: "q",
      panel: [slow("a", 60), slow("b", 0)],
      judge: judge(),
      synthesizer: member("synth", { answer: "done", caveats: [] }),
      dbPath: dbPath(),
      runId: `harden-order-${Date.now()}`,
    });
    expect(result.panel.map((p) => p.model)).toEqual(["a", "b"]);
  });

  test("drops a malformed panel row but still synthesizes from the valid ones", async () => {
    const result = await fuse({
      prompt: "q",
      panel: [
        member("good", { model: "good", answer: "valid", confidence: "low" }),
        member("bad", { not: "a panel response" }),
      ],
      judge: judge(),
      synthesizer: member("synth", { answer: "done", caveats: [] }),
      dbPath: dbPath(),
      runId: `harden-drop-${Date.now()}`,
    });
    expect(result.answer).toBe("done");
    // The malformed row is filtered out entirely — only the valid panelist
    // survives (stronger than "some good exists": asserts the bad one is gone).
    expect(result.panel).toHaveLength(1);
    expect(result.panel[0]?.model).toBe("good");
    expect(result.panel.every((p) => p.model !== "bad")).toBe(true);
  });
});
