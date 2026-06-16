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

  test("reviewPrompt embeds task, plan, diff, and verdict field names", () => {
    const prompt = reviewPrompt("Implement schemas", plan, "diff --git a/src/schemas.ts b/src/schemas.ts");

    expect(prompt).toContain("Implement schemas");
    expect(prompt).toContain("Add schemas");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain("lgtm");
    expect(prompt).toContain("issues");
  });

  test("fixPrompt embeds task, issues, and fix field names", () => {
    const issues: ReviewVerdict["issues"] = [
      { severity: "high", file: "src/index.ts", description: "Missing exports" },
    ];
    const prompt = fixPrompt("Implement schemas", issues);

    expect(prompt).toContain("Implement schemas");
    expect(prompt).toContain("Missing exports");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("changes");
  });
});
