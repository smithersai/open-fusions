import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readLatest, readOutputs, tableNameFor } from "../../src/outputs";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
});

describe("outputs", () => {
  test("tableNameFor converts camelCase schema keys to snake_case", () => {
    expect(tableNameFor("panelResponse")).toBe("panel_response");
  });

  test("readOutputs returns ordered rows and readLatest returns the last row", () => {
    const dbPath = join("/tmp", `smithers-fusions-outputs-${Date.now()}-${Math.random()}.db`);
    created.push(dbPath);
    const db = new Database(dbPath);
    db.exec(
      "CREATE TABLE tiny_output (run_id TEXT, iteration INTEGER, payload TEXT, label TEXT, quoted TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO tiny_output (run_id, iteration, payload, label, quoted) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("run-1", 2, "[1,2]", "second", '"json string"');
    insert.run("run-1", 1, '{"ok":true}', "first", "raw");
    insert.run("run-2", 1, '{"ignored":true}', "other", "raw");
    db.close();

    const rows = readOutputs(dbPath, "run-1", "tiny_output");

    expect(rows).toEqual([
      { run_id: "run-1", iteration: 1, payload: { ok: true }, label: "first", quoted: "raw" },
      { run_id: "run-1", iteration: 2, payload: [1, 2], label: "second", quoted: "json string" },
    ]);
    expect(readLatest(dbPath, "run-1", "tiny_output")).toEqual(rows[1]);
  });

  test("tableNameFor handles acronym boundaries", () => {
    expect(tableNameFor("reviewVerdict")).toBe("review_verdict");
    expect(tableNameFor("finalAnswer")).toBe("final_answer");
    expect(tableNameFor("plan")).toBe("plan");
  });

  test("rejects an unsafe table name before touching the database (SQL-injection guard)", () => {
    expect(() => readOutputs("/tmp/whatever.db", "run-1", "tiny; DROP TABLE x")).toThrow(/Unsafe SQLite table name/);
    expect(() => readOutputs("/tmp/whatever.db", "run-1", "1bad")).toThrow(/Unsafe SQLite table name/);
  });

  test("throws on a missing table rather than returning garbage", () => {
    const dbPath = join("/tmp", `smithers-fusions-outputs-missing-${Date.now()}-${Math.random()}.db`);
    created.push(dbPath);
    new Database(dbPath).close();
    expect(() => readOutputs(dbPath, "run-1", "nope_table")).toThrow();
  });

  test("leaves malformed JSON-looking strings as raw text", () => {
    const dbPath = join("/tmp", `smithers-fusions-outputs-bad-${Date.now()}-${Math.random()}.db`);
    created.push(dbPath);
    const db = new Database(dbPath);
    db.exec("CREATE TABLE tiny_output (run_id TEXT, iteration INTEGER, payload TEXT)");
    db.prepare("INSERT INTO tiny_output (run_id, iteration, payload) VALUES (?, ?, ?)").run("run-1", 1, "{not json");
    db.close();
    expect(readOutputs(dbPath, "run-1", "tiny_output")[0]?.payload).toBe("{not json");
  });
});
