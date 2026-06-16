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

  // [8] An already-valid object must NOT be silently replaced by an inner
  // self-similar object when a sibling field carries real data. Here `answer`
  // legitimately holds JSON of the same shape, but `caveats` has real content —
  // unwrapping would drop it. The faithful reading keeps the top-level object.
  test("keeps an already-valid object when a sibling field carries real data", () => {
    const innerJson = JSON.stringify({ answer: "x", caveats: [] });
    const value = { answer: innerJson, caveats: ["a real caveat"] };
    expect(coerceToSchema(fa, value)).toEqual(value);
  });

  // [9] outputs.parseJsonLike eagerly turns a JSON-looking string column into an
  // object before coerce runs. When the schema field is a string, coerce must
  // re-stringify it back rather than failing — a legitimately JSON answer.
  test("re-stringifies an object that arrived where the schema expects a string", () => {
    const value = { answer: { port: 8080, host: "localhost" }, caveats: [] };
    expect(coerceToSchema(fa, value)).toEqual({
      answer: JSON.stringify({ port: 8080, host: "localhost" }),
      caveats: [],
    });
  });

  // [10] When more than one sibling field validates against the whole schema the
  // unwrap is ambiguous; coerce must be deterministic and fall through to the
  // direct parse rather than silently picking the first key.
  test("does not silently unwrap when two sibling fields both validate (ambiguous)", () => {
    const permissive = z.object({ a: z.string().optional(), b: z.string().optional() });
    const value = { a: "{}", b: "{}" }; // both parse to {}, which validates
    // Deterministic: the top-level object is itself valid, so it is returned as-is.
    expect(coerceToSchema(permissive, value)).toEqual({ a: "{}", b: "{}" });
  });

  // [11] A whole-value JSON string that parses to an object which does NOT validate
  // directly (its `answer` field is an object, not a string). Step 1 parses it but
  // the direct parse of step 1 fails, so the parsed object becomes the candidate
  // and step 5 re-stringifies the object-valued string field to recover. (lines 43-44)
  test("parses a JSON string whose object needs step-5 re-stringification to validate", () => {
    const value = JSON.stringify({ answer: { port: 8080 }, caveats: [] });
    expect(coerceToSchema(fa, value)).toEqual({
      answer: JSON.stringify({ port: 8080 }),
      caveats: [],
    });
  });

  // [12] The step-2 "siblings empty" check must treat "" , null, and {} as empty so
  // a genuine single-field unwrap still proceeds when siblings are degenerate.
  // (isEmptyish lines 136-137 and the "" / null branches of 134)
  test("unwraps a single nested field even when siblings are empty-string/null/empty-object", () => {
    const schema = z.object({
      payload: z.string(),
      a: z.string().optional(),
      b: z.string().optional(),
      c: z.record(z.string(), z.unknown()).optional(),
    });
    const inner = { payload: "real", a: undefined, b: undefined, c: undefined };
    // Put the whole valid object (as JSON) in `payload`; siblings are "", null, {}.
    const value = {
      payload: JSON.stringify(inner),
      a: "",
      b: null,
      c: {},
    };
    expect(coerceToSchema(schema, value)).toEqual(inner);
  });

  // [13] isStringSchema must unwrap an optional() wrapper to find the inner string,
  // so step 5 re-stringifies an object that arrived in an optional string field.
  // (the unwrap loop body, line 170)
  test("re-stringifies an object in an OPTIONAL string field (unwraps the optional wrapper)", () => {
    const schema = z.object({ note: z.string().optional(), n: z.number() });
    const value = { note: { a: 1 }, n: 3 };
    expect(coerceToSchema(schema, value)).toEqual({ note: JSON.stringify({ a: 1 }), n: 3 });
  });

  // [14] tryJson must swallow a SyntaxError from malformed JSON that starts with a
  // JSON-ish character, returning the original string unchanged. (catch, lines 182-183)
  test("leaves a malformed JSON-looking string field untouched (tryJson catch path)", () => {
    const value = { answer: "{ not valid json", caveats: [] };
    expect(coerceToSchema(fa, value)).toEqual({ answer: "{ not valid json", caveats: [] });
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
