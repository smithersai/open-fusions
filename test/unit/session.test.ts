import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../../src/session";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = join("/tmp", `open-fusions-session-${Date.now()}-${Math.random()}`);
  dirs.push(dir);
  return dir;
}

describe("SessionStore", () => {
  test("creates, saves, loads, and lists sessions", () => {
    const store = new SessionStore(tempDir());
    const session = store.create({ task: "Add phase runners", id: "s-test" });

    store.save(session);

    expect(store.load("s-test")).toEqual(session);
    expect(store.list()).toEqual([session]);
    expect(store.load("missing")).toBeUndefined();
  });
});
