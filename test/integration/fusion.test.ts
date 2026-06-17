import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fuse, runFusion } from "../../src/fusion";
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

/**
 * An AgentLike usable directly as a ModelSpec: it carries an `id` so
 * `resolveModelSpec` derives a stable display id, and passes straight through
 * `resolveAgent` (no real model/account needed).
 */
function specStub(id: string, output: unknown): AgentLike & { id: string } {
  return {
    id,
    async generate() {
      return { output };
    },
  };
}

/** An AgentLike whose generate returns a result object with NO output field. */
function emptyResultMember(id: string): PanelMember {
  const agent: AgentLike = {
    async generate() {
      return {};
    },
  };
  return { id, spec: id, agent };
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
    const dbPath = join("/tmp", `smithers-fusions-fusion-${Date.now()}-${Math.random()}.db`);
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
    const dbPath = join("/tmp", `smithers-fusions-invalid-synth-${Date.now()}-${Math.random()}.db`);
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
    const dbPath = join("/tmp", `smithers-fusions-recoverable-synth-${Date.now()}-${Math.random()}.db`);
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
    const dbPath = join("/tmp", `smithers-fusions-recoverable-object-synth-${Date.now()}-${Math.random()}.db`);
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

  test("rejects when the panel is empty", async () => {
    await expect(
      fuse({
        prompt: "q",
        panel: [],
        judge: member("judge", {
          consensus: [],
          contradictions: [],
          uniqueInsights: [],
          blindSpots: [],
          recommendation: "",
          confidence: "low",
        }),
        synthesizer: member("synthesizer", { answer: "x", caveats: [] }),
      }),
    ).rejects.toThrow(/needs at least one panel model/);
  });

  test("tolerates a panelist whose generate returns no output field", async () => {
    const dbPath = join("/tmp", `smithers-fusions-empty-output-${Date.now()}-${Math.random()}.db`);
    created.push(dbPath);
    const panel = [
      emptyResultMember("model-empty"),
      member("model-b", { model: "model-b", answer: "B", confidence: "high" }),
    ];
    const judge = member("judge", {
      consensus: ["Panel answered"],
      contradictions: [],
      uniqueInsights: [],
      blindSpots: [],
      recommendation: "Use the synthesized answer",
      confidence: "high",
    });
    const synthesizer = member("synthesizer", { answer: "Synth answer", caveats: [] });

    const result = await fuse({
      prompt: "q",
      panel,
      judge,
      synthesizer,
      dbPath,
      runId: `fusion-empty-output-${Date.now()}`,
      cleanup: true,
    });

    expect(result.answer).toBe("Synth answer");
  });
});

describe("runFusion", () => {
  test("resolves AgentLike specs through resolveAgent and returns the synthesized answer", async () => {
    const result = await runFusion({
      prompt: "q",
      panel: [
        specStub("model-a", { model: "model-a", answer: "A", confidence: "high" }),
        specStub("model-b", { model: "model-b", answer: "B", confidence: "medium" }),
      ],
      judge: specStub("judge", {
        consensus: ["All answer the question"],
        contradictions: [],
        uniqueInsights: [],
        blindSpots: [],
        recommendation: "Use the synthesized answer",
        confidence: "high",
      }),
      synthesizer: specStub("synthesizer", { answer: "Synth answer", caveats: [] }),
    });

    expect(result.status).toBe("finished");
    expect(result.panel).toHaveLength(2);
    expect(result.answer).toBe("Synth answer");
  });

  test("defaults the synthesizer to the judge spec when only a judge is given", async () => {
    const result = await runFusion({
      prompt: "q",
      panel: [specStub("model-a", { model: "model-a", answer: "A", confidence: "high" })],
      judge: specStub("judge-and-synth", { answer: "Judge-as-synth", caveats: [] }),
    });

    expect(result.answer).toBe("Judge-as-synth");
  });
});
