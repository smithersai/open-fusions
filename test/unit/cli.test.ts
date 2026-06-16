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

  test("plan refuses to clobber an existing session id (RUN_EXISTS)", async () => {
    const dir = join("/tmp", `open-fusions-cli-run-exists-${Date.now()}-${Math.random()}`);
    const engine = fakeEngine(dir);
    (engine as { start: unknown }).start = async () => {
      throw new Error("Run of-existing already exists");
    };
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["plan", "do it", "--session", "of-existing"]);
    expect(result.code).toBe("RUN_EXISTS");
    expect(result.message).toMatch(/already exists/i);
    expect(result.cta.commands[0].command).toContain("status --session of-existing");
    rmSync(dir, { recursive: true, force: true });
  });

  test("plan re-throws a start error that is not an 'already exists' clash", async () => {
    const dir = join("/tmp", `open-fusions-cli-plan-throw-${Date.now()}-${Math.random()}`);
    const engine = fakeEngine(dir);
    (engine as { start: unknown }).start = async () => {
      throw new Error("disk on fire");
    };
    const cli = createCli({ engine, fuseRaw });
    // incur catches the re-thrown error and serializes it as an UNKNOWN error,
    // proving the RUN_EXISTS branch was NOT taken (no "already exists" match).
    const result = await runner(cli)(["plan", "do it", "--session", "of-x"]);
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toMatch(/disk on fire/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("plan with no models and no --panel routes to a NO_MODELS error", async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "of-cli-plan-empty-"));
    writeFileSync(accountsFilePath({ SMITHERS_HOME: emptyHome }), JSON.stringify({ version: 1, accounts: [] }));
    const prev = process.env.SMITHERS_HOME;
    process.env.SMITHERS_HOME = emptyHome;
    try {
      const cli = createCli({ engine: fakeEngine(), fuseRaw });
      const result = await runner(cli)(["plan", "do it"]);
      expect(result.code).toBe("NO_MODELS");
      expect(result.message).toMatch(/smithers agents add/);
    } finally {
      if (prev === undefined) delete process.env.SMITHERS_HOME;
      else process.env.SMITHERS_HOME = prev;
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test("a phase command on a durably failed run reports FUSION_FAILED", async () => {
    const dir = join("/tmp", `open-fusions-cli-fusion-failed-${Date.now()}-${Math.random()}`);
    const failed: EngineState = {
      runId: "unit",
      status: "failed",
      phase: "implement",
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
    const result = await runner(cli)(["implement", "--session", "unit"]);
    expect(result.code).toBe("FUSION_FAILED");
    expect(result.message).toMatch(/implement fusion failed/);
    expect(result.cta.commands[0].command).toContain("result --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a phase command on the wrong phase points to the current phase command", async () => {
    const dir = join("/tmp", `open-fusions-cli-wrong-phase-${Date.now()}-${Math.random()}`);
    // implement command, but the run is sitting in `fix` — should route to review.
    const cur: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "fix",
      pendingGate: "fix-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: false,
      output: {},
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => cur;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["implement", "--session", "unit"]);
    expect(result.code).toBe("WRONG_PHASE");
    expect(result.cta.commands[0].command).toContain("review --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("resume reports FUSION_FAILED when recovery lands on a failed run", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-failed-${Date.now()}-${Math.random()}`);
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
    (engine as { resume: unknown }).resume = async () => failed;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(result.code).toBe("FUSION_FAILED");
    rmSync(dir, { recursive: true, force: true });
  });

  test("resume auto-acknowledges a recovered LGTM gate and points to result (terminal cta)", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-lgtm-${Date.now()}-${Math.random()}`);
    const recovered: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: true,
      output: { lgtm: true, summary: "ok", issues: [] },
    };
    const done: EngineState = {
      ...recovered,
      status: "finished",
      phase: "done",
      pendingGate: null,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { resume: unknown }).resume = async () => recovered;
    (engine as { advance: unknown }).advance = async () => done;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(result.phase).toBe("done");
    expect(result.cta.commands[0].command).toContain("result --session unit");
    expect(result.cta.description).toContain("Done");
    rmSync(dir, { recursive: true, force: true });
  });

  test("resume that auto-advances into a failed run reports FUSION_FAILED", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-advance-failed-${Date.now()}-${Math.random()}`);
    const recovered: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: true,
      output: {},
    };
    const failed: EngineState = {
      ...recovered,
      status: "failed",
      phase: "review",
      pendingGate: null,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { resume: unknown }).resume = async () => recovered;
    (engine as { advance: unknown }).advance = async () => failed;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(result.code).toBe("FUSION_FAILED");
    rmSync(dir, { recursive: true, force: true });
  });

  test("resume that lands on a still-interrupted run points to resume (Recover cta)", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-needs-${Date.now()}-${Math.random()}`);
    const stuck: EngineState = {
      runId: "unit",
      status: "running",
      phase: "implement",
      pendingGate: null,
      needsResume: true,
      iteration: 0,
      lgtm: null,
      output: undefined,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { resume: unknown }).resume = async () => stuck;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(result.cta.description).toContain("Recover");
    expect(result.cta.commands[0].command).toContain("resume --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("resume on a plan-phase run points to implement", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-plan-${Date.now()}-${Math.random()}`);
    const planned: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "plan",
      pendingGate: "plan-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { resume: unknown }).resume = async () => planned;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(result.cta.commands[0].command).toContain("implement --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("resume on an implement-phase run points to review", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-impl-${Date.now()}-${Math.random()}`);
    const impl: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "implement",
      pendingGate: "impl-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { resume: unknown }).resume = async () => impl;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(result.cta.commands[0].command).toContain("review --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("resume on a fix-phase run points to review", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-fix-${Date.now()}-${Math.random()}`);
    const fix: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "fix",
      pendingGate: "fix-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: false,
      output: {},
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { resume: unknown }).resume = async () => fix;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(result.cta.commands[0].command).toContain("review --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("resume on a review run awaiting acknowledgement (lgtm not false) points to review", async () => {
    const dir = join("/tmp", `open-fusions-cli-resume-ack-${Date.now()}-${Math.random()}`);
    // phase review, lgtm null (not false) and no pendingGate, so the auto-ack
    // branch is skipped and nextCommandFor hits the "Acknowledge the review" arm.
    const review: EngineState = {
      runId: "unit",
      status: "running",
      phase: "review",
      pendingGate: null,
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { resume: unknown }).resume = async () => review;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["resume", "--session", "unit"]);
    expect(result.cta.commands[0].command).toContain("review --session unit");
    expect(result.cta.commands[0].description).toContain("Acknowledge");
    rmSync(dir, { recursive: true, force: true });
  });

  test("plan starts a run and points to implement", async () => {
    const dir = join("/tmp", `open-fusions-cli-plan-ok-${Date.now()}-${Math.random()}`);
    const engine = fakeEngine(dir);
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["plan", "do it", "--panel", "a,b", "--judge", "j"]);
    expect(result.phase).toBe("plan");
    expect(result.session).toBe("unit");
    expect(result.cta.commands[0].command).toContain("implement --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("plan surfaces a needsResume start state", async () => {
    const dir = join("/tmp", `open-fusions-cli-plan-needs-${Date.now()}-${Math.random()}`);
    const stuck: EngineState = {
      runId: "unit",
      status: "running",
      phase: "plan",
      pendingGate: null,
      needsResume: true,
      iteration: 0,
      lgtm: null,
      output: undefined,
    };
    const engine = fakeEngine(dir);
    (engine as { start: unknown }).start = async () => stuck;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["plan", "do it", "--panel", "a", "--judge", "j"]);
    expect(result.code).toBe("NEEDS_RESUME");
    rmSync(dir, { recursive: true, force: true });
  });

  test("implement advances a plan-phase run into review", async () => {
    const dir = join("/tmp", `open-fusions-cli-impl-ok-${Date.now()}-${Math.random()}`);
    const planned: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "plan",
      pendingGate: "plan-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const advanced: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "implement",
      pendingGate: "impl-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: { code: "x" },
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => planned;
    (engine as { advance: unknown }).advance = async () => advanced;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["implement", "--session", "unit"]);
    expect(result.phase).toBe("implement");
    expect(result.cta.commands[0].command).toContain("review --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("implement surfaces a fusion that fails while advancing", async () => {
    const dir = join("/tmp", `open-fusions-cli-impl-fail-${Date.now()}-${Math.random()}`);
    const planned: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "plan",
      pendingGate: "plan-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const failed: EngineState = {
      ...planned,
      status: "failed",
      phase: "implement",
      pendingGate: null,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => planned;
    (engine as { advance: unknown }).advance = async () => failed;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["implement", "--session", "unit"]);
    expect(result.code).toBe("FUSION_FAILED");
    rmSync(dir, { recursive: true, force: true });
  });

  test("implement surfaces a needsResume that appears mid-advance", async () => {
    const dir = join("/tmp", `open-fusions-cli-impl-needs-${Date.now()}-${Math.random()}`);
    const planned: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "plan",
      pendingGate: "plan-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const stuck: EngineState = {
      ...planned,
      status: "running",
      phase: "implement",
      pendingGate: null,
      needsResume: true,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => planned;
    (engine as { advance: unknown }).advance = async () => stuck;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["implement", "--session", "unit"]);
    expect(result.code).toBe("NEEDS_RESUME");
    rmSync(dir, { recursive: true, force: true });
  });

  test("review on an implement-phase run that returns lgtm false points to fix", async () => {
    const dir = join("/tmp", `open-fusions-cli-review-false-${Date.now()}-${Math.random()}`);
    const impl: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "implement",
      pendingGate: "impl-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const reviewed: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: false,
      output: { lgtm: false, summary: "needs work", issues: ["x"] },
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => impl;
    (engine as { advance: unknown }).advance = async () => reviewed;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["review", "--session", "unit"]);
    expect(result.lgtm).toBe(false);
    expect(result.phase).toBe("review");
    expect(result.cta.commands[0].command).toContain("fix --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("review on an implement-phase run that returns lgtm true finishes the run", async () => {
    const dir = join("/tmp", `open-fusions-cli-review-true-${Date.now()}-${Math.random()}`);
    const impl: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "implement",
      pendingGate: "impl-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const reviewed: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: true,
      output: { lgtm: true, summary: "great", issues: [] },
    };
    const done: EngineState = {
      ...reviewed,
      status: "finished",
      phase: "done",
      pendingGate: null,
    };
    let calls = 0;
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => impl;
    (engine as { advance: unknown }).advance = async () => {
      calls += 1;
      return calls === 1 ? reviewed : done;
    };
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["review", "--session", "unit"]);
    expect(result.lgtm).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.cta.commands[0].command).toContain("result --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("review surfaces a failed verdict synth as FUSION_FAILED", async () => {
    const dir = join("/tmp", `open-fusions-cli-review-fail-${Date.now()}-${Math.random()}`);
    const impl: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "implement",
      pendingGate: "impl-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const failed: EngineState = {
      ...impl,
      status: "failed",
      phase: "review",
      pendingGate: null,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => impl;
    (engine as { advance: unknown }).advance = async () => failed;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["review", "--session", "unit"]);
    expect(result.code).toBe("FUSION_FAILED");
    rmSync(dir, { recursive: true, force: true });
  });

  test("review routes a null-verdict (no lgtm) advance to resume", async () => {
    const dir = join("/tmp", `open-fusions-cli-review-null-${Date.now()}-${Math.random()}`);
    const impl: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "implement",
      pendingGate: "impl-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const noVerdict: EngineState = {
      runId: "unit",
      status: "running",
      phase: "review",
      pendingGate: null,
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: undefined,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => impl;
    (engine as { advance: unknown }).advance = async () => noVerdict;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["review", "--session", "unit"]);
    expect(result.code).toBe("NEEDS_RESUME");
    rmSync(dir, { recursive: true, force: true });
  });

  test("review auto-ack of a stranded LGTM gate that then fails reports FUSION_FAILED", async () => {
    const dir = join("/tmp", `open-fusions-cli-review-ack-fail-${Date.now()}-${Math.random()}`);
    const stranded: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: true,
      output: { lgtm: true, summary: "ok", issues: [] },
    };
    const failed: EngineState = {
      ...stranded,
      status: "failed",
      phase: "review",
      pendingGate: null,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => stranded;
    (engine as { advance: unknown }).advance = async () => failed;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["review", "--session", "unit"]);
    expect(result.code).toBe("FUSION_FAILED");
    rmSync(dir, { recursive: true, force: true });
  });

  test("fix advances a review/lgtm-false run into review", async () => {
    const dir = join("/tmp", `open-fusions-cli-fix-ok-${Date.now()}-${Math.random()}`);
    const needsFix: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: false,
      output: {},
    };
    const fixed: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "fix",
      pendingGate: "fix-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: false,
      output: { patch: "x" },
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => needsFix;
    (engine as { advance: unknown }).advance = async () => fixed;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["fix", "--session", "unit"]);
    expect(result.phase).toBe("fix");
    expect(result.cta.commands[0].command).toContain("review --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("fix surfaces a failed advance as FUSION_FAILED", async () => {
    const dir = join("/tmp", `open-fusions-cli-fix-fail-${Date.now()}-${Math.random()}`);
    const needsFix: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: false,
      output: {},
    };
    const failed: EngineState = {
      ...needsFix,
      status: "failed",
      phase: "fix",
      pendingGate: null,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => needsFix;
    (engine as { advance: unknown }).advance = async () => failed;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["fix", "--session", "unit"]);
    expect(result.code).toBe("FUSION_FAILED");
    rmSync(dir, { recursive: true, force: true });
  });

  test("fix surfaces a needsResume that appears mid-advance", async () => {
    const dir = join("/tmp", `open-fusions-cli-fix-needs-${Date.now()}-${Math.random()}`);
    const needsFix: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: false,
      output: {},
    };
    const stuck: EngineState = {
      ...needsFix,
      status: "running",
      phase: "fix",
      pendingGate: null,
      needsResume: true,
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => needsFix;
    (engine as { advance: unknown }).advance = async () => stuck;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["fix", "--session", "unit"]);
    expect(result.code).toBe("NEEDS_RESUME");
    rmSync(dir, { recursive: true, force: true });
  });

  test("result shows the current run output", async () => {
    const dir = join("/tmp", `open-fusions-cli-result-${Date.now()}-${Math.random()}`);
    const st: EngineState = {
      runId: "unit",
      status: "finished",
      phase: "done",
      pendingGate: null,
      needsResume: false,
      iteration: 1,
      lgtm: true,
      output: { final: "answer" },
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => st;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["result", "--session", "unit"]);
    expect(result.phase).toBe("done");
    expect(result.lgtm).toBe(true);
    expect(result.output).toEqual({ final: "answer" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("result reports a missing session before reading state", async () => {
    const dir = join("/tmp", `open-fusions-cli-result-missing-${Date.now()}-${Math.random()}`);
    const engine = fakeEngine(dir);
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["result", "--session", "nope"]);
    expect(result.code).toBe("SESSION_NOT_FOUND");
    rmSync(dir, { recursive: true, force: true });
  });

  test("review on a plan-phase run is wrong-phase and points to implement", async () => {
    const dir = join("/tmp", `open-fusions-cli-review-wrong-${Date.now()}-${Math.random()}`);
    const planned: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "plan",
      pendingGate: "plan-gate",
      needsResume: false,
      iteration: 0,
      lgtm: null,
      output: {},
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => planned;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["review", "--session", "unit"]);
    expect(result.code).toBe("WRONG_PHASE");
    expect(result.cta.commands[0].command).toContain("implement --session unit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("fix on a review-phase run with lgtm true is wrong-phase and points to fix", async () => {
    const dir = join("/tmp", `open-fusions-cli-fix-wrong-${Date.now()}-${Math.random()}`);
    // phase review but lgtm !== false -> fix command rejects and commandFor("review") === "fix".
    const reviewedLgtm: EngineState = {
      runId: "unit",
      status: "waiting-approval",
      phase: "review",
      pendingGate: "review-0-gate",
      needsResume: false,
      iteration: 0,
      lgtm: true,
      output: {},
    };
    const engine = fakeEngine(dir);
    writeFileSync(engine.dbPathFor("unit"), "");
    (engine as { state: unknown }).state = async () => reviewedLgtm;
    const cli = createCli({ engine, fuseRaw });
    const result = await runner(cli)(["fix", "--session", "unit"]);
    expect(result.code).toBe("WRONG_PHASE");
    expect(result.cta.commands[0].command).toContain("fix --session unit");
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
