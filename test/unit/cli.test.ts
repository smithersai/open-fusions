import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsFilePath } from "@smithers-orchestrator/accounts";
import { createCli } from "../../src/cli";
import type { EngineState, OpenFusionsEngine } from "../../src/engine";
import type { FuseResult } from "../../src/fusion";

const judged = {
  consensus: ["consistent"],
  contradictions: [],
  uniqueInsights: [],
  blindSpots: [],
  recommendation: "mock",
  confidence: "high" as const,
};

const fuseRaw = async (): Promise<FuseResult> => ({
  answer: "final",
  judgment: judged,
  panel: [{ model: "mock-panel", answer: "panel answer", confidence: "high" }],
  status: "finished",
});

describe("cli", () => {
  test("runs a raw fusion command", async () => {
    const cli = createCli({ engine: fakeEngine(), fuseRaw });
    const fused = await runner(cli)(["fuse", "q"]);

    expect(fused.answer).toBe("final");
    expect(fused.judgment).toEqual(judged);
    expect(fused.panel).toHaveLength(1);
    expect(fused.cta).toBeUndefined();
  });

  test("reports missing sessions before advancing", async () => {
    const dir = join("/tmp", `open-fusions-cli-unit-${Date.now()}-${Math.random()}`);
    const cli = createCli({ engine: fakeEngine(dir), fuseRaw });

    const missing = await runner(cli)(["implement", "--session", "missing"]);

    expect(missing.code).toBe("SESSION_NOT_FOUND");
    rmSync(dir, { recursive: true, force: true });
  });

  test("routes a fuse with no models and no --panel to a NO_MODELS error", async () => {
    // defaultPanel/defaultJudge read process.env; point SMITHERS_HOME at an
    // empty registry so resolution fails with the friendly NO_MODELS message.
    const emptyHome = mkdtempSync(join(tmpdir(), "of-cli-empty-"));
    writeFileSync(accountsFilePath({ SMITHERS_HOME: emptyHome }), JSON.stringify({ version: 1, accounts: [] }));
    const prev = process.env.SMITHERS_HOME;
    process.env.SMITHERS_HOME = emptyHome;
    try {
      const cli = createCli({ engine: fakeEngine(), fuseRaw });
      const result = await runner(cli)(["fuse", "q"]);
      expect(result.code).toBe("NO_MODELS");
      expect(result.message).toMatch(/smithers agents add/);
    } finally {
      if (prev === undefined) delete process.env.SMITHERS_HOME;
      else process.env.SMITHERS_HOME = prev;
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test("reject denies the pending gate via the engine", async () => {
    const dir = join("/tmp", `open-fusions-cli-reject-${Date.now()}-${Math.random()}`);
    let denied: { decision: string; note?: string } | undefined;
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), ""); // reject guards on db existence
    // Spy on advance to assert the deny decision is forwarded.
    (engine as { advance: unknown }).advance = async (_id: string, decision = "approve", note?: string) => {
      denied = { decision, note };
      return { runId: "unit", status: "loaded", phase: "stopped", pendingGate: null, iteration: 0, lgtm: null, output: {} };
    };
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["reject", "--session", "unit", "--note", "nope"]);
    expect(denied).toEqual({ decision: "deny", note: "nope" });
    expect(result.phase).toBe("stopped");
    rmSync(dir, { recursive: true, force: true });
  });
});

function fakeEngine(dir = "/tmp/open-fusions-cli-unit"): OpenFusionsEngine {
  mkdirSync(dir, { recursive: true });
  const state: EngineState = {
    runId: "unit",
    status: "loaded",
    phase: "plan",
    pendingGate: "plan-gate",
    iteration: 0,
    lgtm: null,
    output: { steps: [], risks: [], files: [] },
  };
  return {
    dbPathFor(runId: string) {
      return join(dir, `${runId}.db`);
    },
    async start() {
      return state;
    },
    async advance() {
      return state;
    },
    async state() {
      return state;
    },
  } as unknown as OpenFusionsEngine;
}

function runner(cli: ReturnType<typeof createCli>) {
  return async (argv: string[]) => {
    let out = "";
    await cli.serve([...argv, "--json"], {
      stdout: (s) => {
        out += s;
      },
      exit: () => {},
      env: {},
    });
    return JSON.parse(out);
  };
}
