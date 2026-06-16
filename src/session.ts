import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionState } from "./schemas";
import type { SessionState } from "./schemas";

export class SessionStore {
  readonly dir: string;

  constructor(dir = process.env.OPEN_FUSIONS_DIR ?? ".open-fusions") {
    this.dir = dir;
  }

  create(input: { task: string; id?: string }): SessionState {
    return {
      id: input.id ?? `s-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      task: input.task,
      phase: "plan",
      iteration: 0,
      history: [],
    };
  }

  load(id: string): SessionState | undefined {
    const file = this.path(id);
    if (!existsSync(file)) {
      return undefined;
    }

    return sessionState.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  save(state: SessionState): void {
    const parsed = sessionState.parse(state);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(parsed.id), `${JSON.stringify(parsed, null, 2)}\n`);
  }

  list(): SessionState[] {
    if (!existsSync(this.dir)) {
      return [];
    }

    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => sessionState.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8"))));
  }

  path(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
