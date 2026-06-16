import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
