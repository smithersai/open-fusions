import { describe, expect, test } from "bun:test";
import {
  type Judgment,
  type ReviewVerdict,
  finalAnswer,
  fix,
  implementation,
  judgment,
  panelResponse,
  plan,
  reviewVerdict,
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

  test("reviewVerdict supports a 'critical' issue severity and rejects unknown ones", () => {
    const valid: ReviewVerdict = {
      lgtm: false,
      summary: "One issue",
      issues: [{ severity: "medium", file: "src/index.ts", description: "Missing export" }],
    };

    expect(reviewVerdict.parse(valid)).toEqual(valid);
    // A reviewer must be able to mark a blocking defect distinctly from a
    // high-confidence-but-minor one — 'critical' is its own severity tier.
    expect(
      reviewVerdict.parse({ ...valid, issues: [{ severity: "critical", description: "Blocker" }] }),
    ).toMatchObject({ issues: [{ severity: "critical" }] });
    // But severity is still a closed set.
    expect(() =>
      reviewVerdict.parse({ ...valid, issues: [{ severity: "blocker", description: "Nope" }] }),
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
});
