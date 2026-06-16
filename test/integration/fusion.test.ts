import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fuse } from "../../src/fusion";
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
});
