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
  //    directly (answer is a string) yet is semantically wrong.
  //
  //    Two guards keep this from silently destroying real data (it runs before
  //    the direct parse, so it must be conservative):
  //      - AMBIGUITY: if more than one field's value validates against the whole
  //        schema, which one is the "real" payload is undecidable — fall through
  //        to the direct parse instead of picking by key order.
  //      - DATA LOSS: only unwrap when every OTHER field is empty/degenerate.
  //        In a genuine double-encode the model dumped everything into one field
  //        and left the siblings empty; if a sibling carries real content,
  //        unwrapping would drop it, so the top-level object is kept as-is.
  if (isPlainObject(candidate)) {
    const matches: { key: string; inner: Record<string, unknown> }[] = [];
    for (const [key, field] of Object.entries(candidate)) {
      const inner = isPlainObject(field) ? field : typeof field === "string" ? tryJson(field) : undefined;
      if (isPlainObject(inner) && schema.safeParse(inner).success) matches.push({ key, inner });
    }
    if (matches.length === 1) {
      const { key, inner } = matches[0]!;
      // "Empty siblings" considers only schema-declared fields — persisted rows
      // carry non-schema metadata columns (run_id, node_id, iteration) that are
      // not part of the payload and must not block a genuine unwrap.
      const fieldKeys = schemaFieldKeys(schema);
      const isSibling = (k: string): boolean => k !== key && (fieldKeys.size === 0 || fieldKeys.has(k));
      const siblingsEmpty = Object.entries(candidate).every(([k, v]) => !isSibling(k) || isEmptyish(v));
      if (siblingsEmpty) return { ok: true, data: schema.parse(inner) };
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

  // 5. The inverse of step 4: a field the schema declares as a string arrived as
  //    an object/array. This is what `outputs.parseJsonLike` does to a column
  //    whose value is legitimately JSON text (e.g. an `answer` that is itself a
  //    JSON snippet) — it eagerly parses it to an object. Re-stringify those
  //    fields so the schema's string requirement is satisfied again.
  if (isPlainObject(candidate)) {
    const stringKeys = stringFieldKeys(schema);
    if (stringKeys.size > 0) {
      let changed = false;
      const fixed: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(candidate)) {
        if (stringKeys.has(key) && (isPlainObject(field) || Array.isArray(field))) {
          fixed[key] = JSON.stringify(field);
          changed = true;
        } else {
          fixed[key] = field;
        }
      }
      if (changed) {
        const r = schema.safeParse(fixed);
        if (r.success) return { ok: true, data: r.data };
      }
    }
  }

  return { ok: false, value: candidate };
}

/** A value carrying no real information — safe to discard when unwrapping. */
function isEmptyish(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** The zod v4 object shape (`_zod.def.shape`), or undefined for non-objects. */
function objectShape(schema: z.ZodType<unknown>): Record<string, unknown> | undefined {
  return (schema as { _zod?: { def?: { shape?: Record<string, unknown> } } })._zod?.def?.shape;
}

/** All declared field keys; empty for non-object schemas. */
function schemaFieldKeys(schema: z.ZodType<unknown>): Set<string> {
  const shape = objectShape(schema);
  return new Set(shape ? Object.keys(shape) : []);
}

/**
 * Keys whose schema field is (possibly optional/nullable) a string. Reads the
 * zod v4 internal `_zod.def` shape — the same surface smithers depends on — and
 * degrades to an empty set for non-object schemas.
 */
function stringFieldKeys(schema: z.ZodType<unknown>): Set<string> {
  const keys = new Set<string>();
  const shape = objectShape(schema);
  if (!shape) return keys;
  for (const [key, field] of Object.entries(shape)) {
    if (isStringSchema(field)) keys.add(key);
  }
  return keys;
}

function isStringSchema(field: unknown): boolean {
  let def = (field as { _zod?: { def?: { type?: string; innerType?: unknown } } })._zod?.def;
  // Unwrap optional/nullable/default wrappers to reach the inner type.
  while (def && (def.type === "optional" || def.type === "nullable" || def.type === "default") && def.innerType) {
    def = (def.innerType as { _zod?: { def?: { type?: string; innerType?: unknown } } })._zod?.def;
  }
  return def?.type === "string";
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
