import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fuse } from "../../src/fusion";
import { safeCoerce } from "../../src/coerce";
import { finalAnswer } from "../../src/schemas";
import type { AgentLike, PanelMember } from "../../src/types";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) {
        unlinkSync(candidate);
      }
    }
  }
});

function stub(output: unknown): AgentLike & { supportsNativeStructuredOutput: true } {
  return {
    supportsNativeStructuredOutput: true,
    async generate() {
      return { output };
    },
  };
}

function member(id: string, output: unknown): PanelMember {
  return {
    id,
    spec: id,
    agent: stub(output),
  };
}

function countingMember(id: string, output: unknown, calls: { count: number }): PanelMember {
  const agent: AgentLike & { supportsNativeStructuredOutput: true } = {
    supportsNativeStructuredOutput: true,
    async generate() {
      calls.count += 1;
      return { output };
    },
  };

  return {
    id,
    spec: id,
    agent,
  };
}

describe("fuse", () => {
  test("runs panel, judge, and synthesizer through smithers with stub agents", async () => {
    const dbPath = join("/tmp", `open-fusions-fusion-${Date.now()}-${Math.random()}.db`);
    created.push(dbPath);
    const panel = [
      member("model-a", { model: "model-a", answer: "A", confidence: "high" }),
      member("model-b", { model: "model-b", answer: "B", confidence: "medium" }),
      member("model-c", { model: "model-c", answer: "C", confidence: "low" }),
    ];
    const judge = member("judge", {
      consensus: ["All answer the question"],
      contradictions: [],
      uniqueInsights: [{ model: "model-b", insight: "B adds nuance" }],
      blindSpots: [],
      recommendation: "Use the synthesized answer",
      confidence: "high",
    });
    const synthesizer = member("synthesizer", {
      answer: "Synth answer",
      caveats: ["Stubbed integration"],
    });

    const result = await fuse({
      prompt: "q",
      panel,
      judge,
      synthesizer,
      dbPath,
      runId: `fusion-test-${Date.now()}`,
      cleanup: true,
    });

    expect(result.status).toBe("finished");
    expect(result.panel).toHaveLength(3);
    expect(result.answer).toBe("Synth answer");
    expect(result.judgment.consensus).toBeArray();
  });

  test("does not retry deterministic schema-validation failures", async () => {
    const dbPath = join("/tmp", `open-fusions-invalid-synth-${Date.now()}-${Math.random()}.db`);
    created.push(dbPath);
    const calls = { count: 0 };
    const panel = [member("model-a", { model: "model-a", answer: "A", confidence: "high" })];
    const judge = member("judge", {
      consensus: ["Panel answered"],
      contradictions: [],
      uniqueInsights: [],
      blindSpots: [],
      recommendation: "Use the synthesized answer",
      confidence: "high",
    });
    const synthesizer = countingMember("synthesizer", { malformed: true }, calls);

    await expect(
      fuse({
        prompt: "q",
        panel,
        judge,
        synthesizer,
        dbPath,
        runId: `fusion-invalid-synth-${Date.now()}`,
        cleanup: true,
        retries: 2,
      }),
    ).rejects.toThrow(/produced no synthesized output|did not match/);

    expect(calls.count).toBe(1);
  });

  test("allows recoverable raw JSON string structured output through fail-fast proxy", async () => {
    const dbPath = join("/tmp", `open-fusions-recoverable-synth-${Date.now()}-${Math.random()}.db`);
    created.push(dbPath);
    const panel = [member("model-a", { model: "model-a", answer: "A", confidence: "high" })];
    const judge = member("judge", {
      consensus: ["Panel answered"],
      contradictions: [],
      uniqueInsights: [],
      blindSpots: [],
      recommendation: "Use the synthesized answer",
      confidence: "high",
    });
    const synthesizer = member("synthesizer", JSON.stringify({ answer: "recovered", caveats: [] }));

    const result = await fuse({
      prompt: "q",
      panel,
      judge,
      synthesizer,
      dbPath,
      runId: `fusion-recoverable-synth-${Date.now()}`,
      cleanup: true,
      retries: 2,
    });

    expect(result.answer).toBe("recovered");
  });

  test("persists recovered structured synth output instead of the original invalid object", async () => {
    const dbPath = join("/tmp", `open-fusions-recoverable-object-synth-${Date.now()}-${Math.random()}.db`);
    created.push(dbPath);
    const panel = [member("model-a", { model: "model-a", answer: "A", confidence: "high" })];
    const judge = member("judge", {
      consensus: ["Panel answered"],
      contradictions: [],
      uniqueInsights: [],
      blindSpots: [],
      recommendation: "Use the synthesized answer",
      confidence: "high",
    });
    const rawSynthOutput = { answer: { port: 8080 }, caveats: [] };
    const expected = safeCoerce(finalAnswer, rawSynthOutput);
    if (!expected) throw new Error("Expected finalAnswer schema recovery to succeed");
    const synthesizer = member("synthesizer", rawSynthOutput);

    const result = await fuse({
      prompt: "q",
      panel,
      judge,
      synthesizer,
      dbPath,
      runId: `fusion-recoverable-object-synth-${Date.now()}`,
      cleanup: true,
      retries: 2,
    });

    expect(result.answer).toBe(expected.answer);
  });
});
