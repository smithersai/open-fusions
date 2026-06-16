import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { coerceToSchema, safeCoerce } from "../../src/coerce";
import { finalAnswer, judgment } from "../../src/schemas";

const fa = finalAnswer;

describe("coerceToSchema", () => {
  test("passes a value that already matches the schema", () => {
    expect(coerceToSchema(fa, { answer: "hi", caveats: [] })).toEqual({ answer: "hi", caveats: [] });
  });

  test("parses a value that is a JSON string of the whole object", () => {
    expect(coerceToSchema(fa, JSON.stringify({ answer: "hi", caveats: ["c"] }))).toEqual({
      answer: "hi",
      caveats: ["c"],
    });
  });

  test("recovers when the model nested the whole object inside a string field (the observed synth bug)", () => {
    const mangled = {
      answer: JSON.stringify({ answer: "A mutex enforces mutual exclusion.", caveats: ["x"] }),
      caveats: [],
    };
    expect(coerceToSchema(fa, mangled)).toEqual({
      answer: "A mutex enforces mutual exclusion.",
      caveats: ["x"],
    });
  });

  test("recovers when a field holds the whole object as an already-parsed object", () => {
    // Mirrors outputs.ts parseJsonLike having already JSON-parsed the TEXT column.
    const mangled = { answer: { answer: "real", caveats: [] }, caveats: [] };
    expect(coerceToSchema(fa, mangled)).toEqual({ answer: "real", caveats: [] });
  });

  test("recovers per-field stringified JSON (array field arrives as a string)", () => {
    const schema = z.object({ tags: z.array(z.string()), n: z.number() });
    expect(coerceToSchema(schema, { tags: '["a","b"]', n: 2 })).toEqual({ tags: ["a", "b"], n: 2 });
  });

  test("recovers a complex nested judgment double-encoded into one field", () => {
    const real = {
      consensus: ["agree"],
      contradictions: [],
      uniqueInsights: [],
      blindSpots: [],
      recommendation: "ship it",
      confidence: "high" as const,
    };
    const mangled = { consensus: JSON.stringify(real) };
    expect(coerceToSchema(judgment, mangled)).toEqual(real);
  });

  test("throws a precise ZodError when nothing recovers", () => {
    expect(() => coerceToSchema(fa, { answer: 123, caveats: "nope" })).toThrow();
  });

  test("does not fabricate fields — partial data still fails", () => {
    expect(() => coerceToSchema(fa, { answer: "only answer" })).toThrow();
  });
});

describe("safeCoerce", () => {
  test("returns undefined instead of throwing on unrecoverable input", () => {
    expect(safeCoerce(fa, { totally: "wrong" })).toBeUndefined();
    expect(safeCoerce(fa, undefined)).toBeUndefined();
    expect(safeCoerce(fa, null)).toBeUndefined();
  });

  test("returns the recovered value when possible", () => {
    expect(safeCoerce(fa, { answer: "ok", caveats: [] })).toEqual({ answer: "ok", caveats: [] });
  });
});
