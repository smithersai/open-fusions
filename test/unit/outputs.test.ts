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
    const dbPath = join("/tmp", `open-fusions-outputs-${Date.now()}-${Math.random()}.db`);
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
});
