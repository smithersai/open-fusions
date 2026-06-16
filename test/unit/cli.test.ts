import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsFilePath } from "@smithers-orchestrator/accounts";
import { createCli } from "../../src/cli";
import type { EngineState, OpenFusionsEngine } from "../../src/engine";
import type { FuseResult } from "../../src/fusion";
import pkg from "../../package.json" with { type: "json" };

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
  test("reports the package version", async () => {
    const cli = createCli({ engine: fakeEngine(), fuseRaw });
    let out = "";
    await cli.serve(["--version"], {
      stdout: (s) => {
        out += s;
      },
      exit: () => {},
      env: {},
    });

    expect(out.trim()).toBe(pkg.version);
  });

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

  test("resume drives an interrupted run forward via engine.resume", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-${Date.now()}-${Math.random()}`);
    const recovered: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: false,
      output: { lgtm: false, summary: "x", issues: [] },
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    let resumed = false;
    (engine as { resume: unknown }).resume = async () => {
      resumed = true;
      return recovered;
    };
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(resumed).toBe(true);
    expect(result.phase).toBe("review");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a phase command on an interrupted (needsResume) run routes to resume, not a confusing wrong-phase", async () => {
    const dir = join("/tmp", `open-fusions-cli-needsresume-${Date.now()}-${Math.random()}`);
    const stuck: EngineState = {
      runId: "unit",
      status: "running",
      phase: "review",
      pendingGate: null,
      needsResume: true,
      iteration: 0,
      lgtm: null,
      output: undefined,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => stuck;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["review", "--session", "unit"]);
    expect(result.code).toBe("NEEDS_RESUME");
    expect(result.cta.commands[0].command).toContain("resume --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("review auto-acknowledges a stranded LGTM review gate instead of routing to fix", async () => {
    const dir = join("/tmp", `open-fusions-cli-stranded-lgtm-${Date.now()}-${Math.random()}`);
    const stranded: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: true,
      output: { lgtm: true, summary: "looks good", issues: [] },
    };
    const done: EngineState = {
      ...stranded,
      status: "finished",
      phase: "done",
      pendingGate: null,
      output: stranded.output,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => stranded;
    (engine as { advance: unknown }).advance = async () => done;
    const cli = createCli({ engine, fuseRaw });

    const result = await runner(cli)(["review", "--session", "unit"]);

    expect(result.phase).toBe("done");
    expect(result.lgtm).toBe(true);
    expect(JSON.stringify(result.cta)).not.toContain("fix --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a phase command on a terminal run reports the run is over (not a wrong-phase)", async () => {
    const dir = join("/tmp", `open-fusions-cli-terminal-${Date.now()}-${Math.random()}`);
    const done: EngineState = {
      runId: "unit",
      status: "finished",
      phase: "done",
      pendingGate: null,
      needsResume: false,
      iteration: 1,
      lgtm: true,
      output: {},
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => done;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["fix", "--session", "unit"]);
    expect(result.code).toBe("RUN_TERMINAL");
    expect(result.message).toMatch(/complete/i);
    expect(result.cta.commands[0].command).toContain("result --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("status surfaces durable failure state", async () => {
    const dir = join("/tmp", `open-fusions-cli-failed-status-${Date.now()}-${Math.random()}`);
    const failed: EngineState = {
      runId: "unit",
      status: "failed",
      phase: "review",
      pendingGate: null,
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: undefined,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => failed;
    const cli = createCli({ engine, fuseRaw });

    const result = await runner(cli)(["status", "--session", "unit"]);

    expect(result.status).toBe("failed");
    expect(result.needsResume).toBe(false);
    expect(result.phase).toBe("review");
    rmSync(dir, { recursive: true, force: true });
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
    status: "waiting-approval",
    phase: "plan",
    pendingGate: "plan-gate",
    needsResume: false,
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
    async resume() {
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
