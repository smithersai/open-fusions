import { describe, expect, test } from "bun:test";
import { composeReviewContext } from "../../src/pipeline";
import type { Fix, Implementation } from "../../src/schemas";

describe("composeReviewContext", () => {
  const impl: Implementation = {
    summary: "Implemented the rate limiter",
    changes: [{ file: "src/limit.ts", description: "added token bucket" }],
  };

  test("with no fixes yet, the context is just the implementation", () => {
    const ctx = composeReviewContext(impl, []);
    expect(ctx).toContain("Implemented the rate limiter");
    expect(ctx).toContain("src/limit.ts: added token bucket");
  });

  test("accumulates fixes WITHOUT discarding the original implementation", () => {
    // Regression for the loop bug: after a fix, the next review must still see
    // what was implemented, not only the latest fix in isolation.
    const fix0: Fix = { summary: "Handled the burst edge case", changes: [{ file: "src/limit.ts", description: "clamp" }] };
    const ctx = composeReviewContext(impl, [fix0]);
    expect(ctx).toContain("Implemented the rate limiter"); // implementation retained
    expect(ctx).toContain("Handled the burst edge case"); // plus the fix
  });

  test("keeps every fix across multiple iterations", () => {
    const fixes: Fix[] = [
      { summary: "fix one", changes: [] },
      { summary: "fix two", changes: [] },
    ];
    const ctx = composeReviewContext(impl, fixes);
    expect(ctx).toContain("Implemented the rate limiter");
    expect(ctx).toContain("fix one");
    expect(ctx).toContain("fix two");
  });
});
