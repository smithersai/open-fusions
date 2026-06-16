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
  const p = join("/tmp", `open-fusions-hardening-${Date.now()}-${Math.random()}.db`);
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
    // The malformed row is filtered; only the valid panelist survives.
    expect(result.panel.every((p) => typeof p.answer === "string")).toBe(true);
    expect(result.panel.some((p) => p.model === "good")).toBe(true);
  });
});
