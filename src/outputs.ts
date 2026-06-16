import { Database } from "bun:sqlite";

export function tableNameFor(schemaKey: string): string {
  return schemaKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function readOutputs(dbPath: string, runId: string, table: string): Record<string, unknown>[] {
  assertSafeTableName(table);

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(`SELECT * FROM ${table} WHERE run_id = ? ORDER BY iteration ASC`).all(runId);
    return rows.map((row) => parseJsonLikeColumns(row as Record<string, unknown>));
  } finally {
    db.close();
  }
}

export function readLatest(
  dbPath: string,
  runId: string,
  table: string,
): Record<string, unknown> | undefined {
  return readOutputs(dbPath, runId, table).at(-1);
}

function parseJsonLikeColumns(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? parseJsonLike(value) : value]),
  );
}

function parseJsonLike(value: string): unknown {
  const trimmed = value.trim();
  if (!looksLikeJson(trimmed)) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function looksLikeJson(value: string): boolean {
  return (
    value.startsWith("{") ||
    value.startsWith("[") ||
    (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
  );
}

function assertSafeTableName(table: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`Unsafe SQLite table name: ${table}`);
  }
}
