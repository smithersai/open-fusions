import { describe, expect, test } from "bun:test";
import { fuseWith } from "../../src/fusion";
import { plan } from "../../src/schemas";
import type { AgentLike, PanelMember } from "../../src/types";

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

describe("fuseWith", () => {
  test("runs a fusion with a custom synthesis schema", async () => {
    const panel = [
      member("model-a", { model: "model-a", answer: "A", confidence: "high" }),
      member("model-b", { model: "model-b", answer: "B", confidence: "medium" }),
    ];
    const judge = member("judge", {
      consensus: ["Both models agree"],
      contradictions: [],
      uniqueInsights: [],
      blindSpots: [],
      recommendation: "Use the plan",
      confidence: "high",
    });
    const synthesizer = member("synthesizer", {
      steps: [{ title: "Add session store", detail: "Persist sessions as JSON" }],
      risks: [],
      files: ["src/session.ts"],
    });

    const result = await fuseWith({
      prompt: "Plan a change",
      panel,
      judge,
      synthesizer,
      schema: plan,
      cleanup: true,
    });

    expect(result.status).toBe("finished");
    expect(result.output.steps).toBeArray();
  });
});
