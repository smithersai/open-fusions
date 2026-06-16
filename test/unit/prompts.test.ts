import { describe, expect, test } from "bun:test";
import { fixPrompt } from "../../src/prompts/fix";
import { implementPrompt } from "../../src/prompts/implement";
import { judgePrompt } from "../../src/prompts/judge";
import { panelistPrompt } from "../../src/prompts/panelist";
import { planPrompt } from "../../src/prompts/plan";
import { reviewPrompt } from "../../src/prompts/review";
import { synthesizePrompt } from "../../src/prompts/synthesize";
import type { Judgment, PanelResponse, Plan, ReviewVerdict } from "../../src/schemas";

const plan: Plan = {
  steps: [{ title: "Add schemas", detail: "Define zod objects" }],
  risks: ["Shape drift"],
  files: ["src/schemas.ts"],
};

const responses: PanelResponse[] = [
  { model: "openai/gpt-4.1", answer: "Use zod objects.", confidence: "high" },
  { model: "anthropic/claude", answer: "Export inferred types.", confidence: "medium" },
];

const judgment: Judgment = {
  consensus: ["Use zod"],
  contradictions: [{ topic: "naming", positions: ["camelCase", "snake_case"] }],
  uniqueInsights: [{ model: "anthropic/claude", insight: "Include session history" }],
  blindSpots: ["No CLI yet"],
  recommendation: "Implement pure schemas first",
  confidence: "high",
};

describe("prompts", () => {
  test("panelistPrompt embeds the question and role", () => {
    const prompt = panelistPrompt("How should we plan?", "skeptical reviewer");

    expect(prompt).toContain("How should we plan?");
    expect(prompt).toContain("skeptical reviewer");
  });

  test("judgePrompt embeds responses and judgment field names", () => {
    const prompt = judgePrompt("Choose an approach", responses);

    expect(prompt).toContain("Choose an approach");
    expect(prompt).toContain("openai/gpt-4.1");
    expect(prompt).toContain("Use zod objects.");
    for (const field of [
      "consensus",
      "contradictions",
      "uniqueInsights",
      "blindSpots",
      "recommendation",
      "confidence",
    ]) {
      expect(prompt).toContain(field);
    }
  });

  test("synthesizePrompt embeds question, judgment, responses, and final answer fields", () => {
    const prompt = synthesizePrompt("Choose an approach", judgment, responses);

    expect(prompt).toContain("Choose an approach");
    expect(prompt).toContain("Implement pure schemas first");
    expect(prompt).toContain("Use zod objects.");
    expect(prompt).toContain("answer");
    expect(prompt).toContain("caveats");
  });

  test("planPrompt embeds task and plan field names", () => {
    const prompt = planPrompt("Implement schemas");

    expect(prompt).toContain("Implement schemas");
    expect(prompt).toContain("steps");
    expect(prompt).toContain("risks");
    expect(prompt).toContain("files");
  });

  test("implementPrompt embeds task and plan details", () => {
    const prompt = implementPrompt("Implement schemas", plan);

    expect(prompt).toContain("Implement schemas");
    expect(prompt).toContain("Add schemas");
    expect(prompt).toContain("src/schemas.ts");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("changes");
  });

  test("reviewPrompt embeds task, plan, the change context, and verdict field names", () => {
    const prompt = reviewPrompt("Implement schemas", plan, "- src/schemas.ts: defined zod objects");

    expect(prompt).toContain("Implement schemas");
    expect(prompt).toContain("Add schemas");
    expect(prompt).toContain("- src/schemas.ts: defined zod objects");
    expect(prompt).toContain("lgtm");
    expect(prompt).toContain("issues");
    // The change context is a prose summary, not a code diff — don't mislabel it.
    expect(prompt).not.toContain("Diff:");
  });

  test("fixPrompt embeds task, plan, the change context, issues, and fix field names", () => {
    const issues: ReviewVerdict["issues"] = [
      { severity: "high", file: "src/index.ts", description: "Missing exports" },
    ];
    const context = "- src/schemas.ts: defined zod objects";
    const prompt = fixPrompt("Implement schemas", plan, context, issues);

    expect(prompt).toContain("Implement schemas");
    expect(prompt).toContain("Missing exports");
    // The fix synthesizer must see the plan and what was implemented, not just
    // the issue list, so its changes target the real implementation.
    expect(prompt).toContain("Add schemas"); // plan detail
    expect(prompt).toContain(context); // implementation/diff context
    expect(prompt).toContain("summary");
    expect(prompt).toContain("changes");
  });
});
