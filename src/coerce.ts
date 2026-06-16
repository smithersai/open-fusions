import type { z } from "zod";

/**
 * Recover a schema-valid value from the loosely-structured output a model
 * (especially a CLI harness without native structured output) produces.
 *
 * Coding-agent CLIs (codex/gemini/kimi) don't support native structured output;
 * smithers falls back to prompt-injection + text JSON extraction, which commonly
 * mangles the shape in predictable ways:
 *   - the whole value arrives as a JSON string;
 *   - the model nests the entire object inside one field
 *     (`{ answer: "{\"answer\":\"…\",\"caveats\":[]}", caveats: [] }`);
 *   - individual object/array fields arrive as JSON strings.
 *
 * This walks those recovery cases and returns the first variant that validates.
 * It only ever returns data that passes `schema` — it never fabricates fields.
 */
export function coerceToSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const recovered = tryCoerce(schema, value);
  if (recovered.ok) return recovered.data;
  // Nothing recovered — re-parse the best candidate so the caller gets a
  // precise ZodError describing exactly which field is wrong.
  return schema.parse(recovered.value);
}

/** Like {@link coerceToSchema} but returns `undefined` instead of throwing. */
export function safeCoerce<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const recovered = tryCoerce(schema, value);
  return recovered.ok ? recovered.data : undefined;
}

type CoerceResult<T> = { ok: true; data: T } | { ok: false; value: unknown };

function tryCoerce<T>(schema: z.ZodType<T>, value: unknown): CoerceResult<T> {
  let candidate = value;

  // 1. The whole value is a JSON string encoding the object.
  if (typeof value === "string") {
    const parsed = tryJson(value);
    if (parsed !== undefined) {
      const r = schema.safeParse(parsed);
      if (r.success) return { ok: true, data: r.data };
      candidate = parsed;
    }
  }

  // 2. A single field holds the ENTIRE object (as an object or a JSON string).
  //    This is the double-encoding signature, checked before the direct parse:
  //    `{ answer: "{\"answer\":…,\"caveats\":[]}", caveats: [] }` validates
  //    directly (answer is a string) yet is semantically wrong. No legitimate
  //    field is ever a complete serialization of its own schema, so unwrapping
  //    here is safe and takes precedence.
  if (isPlainObject(candidate)) {
    for (const field of Object.values(candidate)) {
      const inner = isPlainObject(field) ? field : typeof field === "string" ? tryJson(field) : undefined;
      if (isPlainObject(inner)) {
        const r = schema.safeParse(inner);
        if (r.success) return { ok: true, data: r.data };
      }
    }
  }

  // 3. Already valid as-is.
  const direct = schema.safeParse(candidate);
  if (direct.success) return { ok: true, data: direct.data };

  // 4. Individual fields arrived as JSON strings — parse them, then validate.
  if (isPlainObject(candidate)) {
    let changed = false;
    const fixed: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(candidate)) {
      if (typeof field === "string") {
        const parsed = tryJson(field);
        if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
          fixed[key] = parsed;
          changed = true;
          continue;
        }
      }
      fixed[key] = field;
    }
    if (changed) {
      const r = schema.safeParse(fixed);
      if (r.success) return { ok: true, data: r.data };
    }
  }

  return { ok: false, value: candidate };
}

function tryJson(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
