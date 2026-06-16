import { describe, expect, test } from "bun:test";
import {
  type Judgment,
  type ReviewVerdict,
  type SessionState,
  finalAnswer,
  fix,
  implementation,
  judgment,
  panelResponse,
  plan,
  reviewVerdict,
  sessionState,
} from "../../src/schemas";

describe("schemas", () => {
  test("panelResponse parses valid rows and rejects invalid confidence", () => {
    expect(panelResponse.parse({ model: "openai/gpt-4.1", answer: "Use a queue." })).toEqual({
      model: "openai/gpt-4.1",
      answer: "Use a queue.",
    });

    expect(() =>
      panelResponse.parse({ model: "openai/gpt-4.1", answer: "Use a queue.", confidence: "certain" }),
    ).toThrow();
  });

  test("judgment parses valid rows and rejects malformed contradictions", () => {
    const valid: Judgment = {
      consensus: ["Use tests"],
      contradictions: [{ topic: "storage", positions: ["sqlite", "json"] }],
      uniqueInsights: [{ model: "anthropic/claude", insight: "Call out migration risk" }],
      blindSpots: ["Rollback plan"],
      recommendation: "Prefer sqlite",
      confidence: "high",
    };

    expect(judgment.parse(valid)).toEqual(valid);
    expect(() => judgment.parse({ ...valid, contradictions: [{ topic: "storage" }] })).toThrow();
  });

  test("finalAnswer parses valid rows and rejects missing caveats", () => {
    expect(finalAnswer.parse({ answer: "Ship it.", caveats: ["Needs review"] })).toEqual({
      answer: "Ship it.",
      caveats: ["Needs review"],
    });

    expect(() => finalAnswer.parse({ answer: "Ship it." })).toThrow();
  });

  test("plan parses valid rows and rejects incomplete steps", () => {
    const valid = {
      steps: [{ title: "Add schema", detail: "Create zod object" }],
      risks: ["Wrong shape"],
      files: ["src/schemas.ts"],
    };

    expect(plan.parse(valid)).toEqual(valid);
    expect(() => plan.parse({ ...valid, steps: [{ title: "Add schema" }] })).toThrow();
  });

  test("implementation parses valid rows and rejects incomplete changes", () => {
    const valid = {
      summary: "Added schemas",
      changes: [{ file: "src/schemas.ts", description: "Defined zod objects" }],
    };

    expect(implementation.parse(valid)).toEqual(valid);
    expect(() => implementation.parse({ ...valid, changes: [{ file: "src/schemas.ts" }] })).toThrow();
  });

  test("reviewVerdict parses valid rows and rejects invalid severity", () => {
    const valid: ReviewVerdict = {
      lgtm: false,
      summary: "One issue",
      issues: [{ severity: "medium", file: "src/index.ts", description: "Missing export" }],
    };

    expect(reviewVerdict.parse(valid)).toEqual(valid);
    expect(() =>
      reviewVerdict.parse({ ...valid, issues: [{ severity: "critical", description: "Nope" }] }),
    ).toThrow();
  });

  test("fix parses valid rows and rejects incomplete changes", () => {
    const valid = {
      summary: "Fixed exports",
      changes: [{ file: "src/index.ts", description: "Re-exported modules" }],
    };

    expect(fix.parse(valid)).toEqual(valid);
    expect(() => fix.parse({ ...valid, changes: [{ description: "Re-exported modules" }] })).toThrow();
  });

  test("sessionState parses valid rows and rejects invalid phase", () => {
    const valid: SessionState = {
      id: "session-1",
      task: "Add schemas",
      phase: "plan",
      iteration: 1,
      plan: {
        steps: [{ title: "Add schema", detail: "Create zod object" }],
        risks: [],
        files: ["src/schemas.ts"],
      },
      implementation: {
        summary: "Added schemas",
        changes: [{ file: "src/schemas.ts", description: "Defined zod objects" }],
      },
      lastReview: {
        lgtm: true,
        summary: "Looks good",
        issues: [],
      },
      history: [{ phase: "plan", at: "2026-06-16T00:00:00.000Z", summary: "Planned" }],
    };

    expect(sessionState.parse(valid)).toEqual(valid);
    expect(() => sessionState.parse({ ...valid, phase: "done" })).toThrow();
  });
});
