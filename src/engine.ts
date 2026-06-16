import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { approveNode, denyNode, loadOutputs, runWorkflow } from "smithers-orchestrator";
import { resolveAgent } from "./agents";
import { buildPipeline, MAX_REVIEW_ITERATIONS, type AgentFor } from "./pipeline";

export type EnginePhase = "plan" | "implement" | "review" | "fix" | "done" | "stopped" | "exhausted";

export type EngineState = {
  runId: string;
  status: string;
  /** The phase whose output is ready and whose gate (if any) is awaiting a decision. */
  phase: EnginePhase;
  /** The approval node id awaiting a decision, or null when finished/stopped. */
  pendingGate: string | null;
  /**
   * True when the run is mid-flight (a non-terminal phase with no pending gate
   * and the current phase's output not yet produced) — e.g. a crash between
   * approving a gate and running the next fusion. {@link OpenFusionsEngine.resume}
   * drives such a run forward; without it the run would be permanently stuck.
   */
  needsResume: boolean;
  /** Current review→fix iteration. */
  iteration: number;
  /** Latest review verdict, when a review has run. */
  lgtm: boolean | null;
  /** The synthesized output of the current phase (plan/implementation/verdict/fix). */
  output: unknown;
};

/** Phases past which there is nothing left to run. */
const TERMINAL_PHASES: ReadonlySet<EnginePhase> = new Set(["done", "stopped", "exhausted"]);

export function isTerminalPhase(phase: EnginePhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export type EngineOptions = {
  /** Directory holding the per-run durable databases. Default `.open-fusions`. */
  dir?: string;
  /** Resolve a model id + role to an agent. Injectable so tests use stubs. */
  agentFor?: AgentFor;
};

/** Panel/judge configuration for a run; persisted in the run input. */
export type RunConfig = {
  panel: string[];
  judge: string;
  synthesizer?: string;
};

type Row = Record<string, unknown> & { nodeId?: string };
type Outputs = Record<string, Row[] | undefined>;
type RunReader = {
  getRun(runId: string): unknown;
};

/**
 * Drives the durable plan→implement→review→fix run. Each call rebuilds the
 * identical workflow (so it works across separate processes), advances it past
 * exactly one approval gate, and derives the run's phase from persisted state.
 */
export class OpenFusionsEngine {
  readonly dir: string;
  private readonly agentFor: AgentFor;

  constructor(opts: EngineOptions = {}) {
    this.dir = opts.dir ?? process.env.OPEN_FUSIONS_DIR ?? ".open-fusions";
    this.agentFor = opts.agentFor ?? ((modelId) => resolveAgent(modelId));
  }

  dbPathFor(runId: string): string {
    return join(this.dir, `${runId}.db`);
  }

  private pipeline(runId: string) {
    // mode 0o700: the durable db holds the task, plan, code summaries, and model
    // outputs — keep it readable only by the owner on shared hosts.
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return buildPipeline(this.dbPathFor(runId), { agentFor: this.agentFor });
  }

  /** Close the per-operation SQLite handle so long-lived programmatic use of the
   *  engine doesn't leak a connection per call (durability lives on disk). */
  private closeApi(api: { db: unknown }): void {
    try {
      (api as { db?: { close?: () => void } }).db?.close?.();
    } catch {
      // Best effort — never mask the operation's result/error.
    }
  }

  private async resumeRun(
    runId: string,
    pieces: { workflow: unknown; api: { db: unknown; tables: unknown } },
  ): Promise<EngineState> {
    return await this.runResumeWorkflow(runId, pieces);
  }

  private async runResumeWorkflow(
    runId: string,
    pieces: { workflow: unknown; api: { db: unknown; tables: unknown } },
  ): Promise<EngineState> {
    // resume:true with an empty input — smithers loads the persisted run input
    // (task/panel/judge), so the tree rebuilds identically.
    const res = (await Effect.runPromise(
      runWorkflow(pieces.workflow as never, { input: {}, runId, resume: true, logDir: join(this.dir, "logs") }) as never,
    )) as { status: string };
    return deriveStateFromOutputs(runId, res.status, await readOutputs(pieces.api, runId));
  }

  private async currentState(
    runId: string,
    pieces: { api: { db: unknown; tables: unknown }; adapter: RunReader },
  ): Promise<EngineState> {
    const [realStatus, outputs] = await Promise.all([
      readRunStatus(pieces.adapter, runId),
      readOutputs(pieces.api, runId),
    ]);
    return deriveStateFromOutputs(runId, realStatus, outputs);
  }

  /** Start a new durable run; produces the plan and pauses at the plan gate. */
  async start(task: string, config: RunConfig, runId = genRunId()): Promise<EngineState> {
    // Starting onto an existing run id would silently re-attach to the old run
    // and drop the new task/panel/judge (smithers ignores the input on a run
    // that already exists). Refuse it — use advance()/resume() to continue.
    if (existsSync(this.dbPathFor(runId))) {
      throw new Error(
        `A run with id "${runId}" already exists. Use advance()/resume() to continue it, ` +
          "or choose a new id to start a fresh run.",
      );
    }
    const { workflow, api } = this.pipeline(runId);
    try {
      const input: Record<string, unknown> = { task, panel: config.panel, judge: config.judge };
      if (config.synthesizer) input.synthesizer = config.synthesizer;
      const res = (await Effect.runPromise(
        runWorkflow(workflow as never, { input, runId, logDir: join(this.dir, "logs") }) as never,
      )) as { status: string };
      return deriveStateFromOutputs(runId, res.status, await readOutputs(api, runId));
    } finally {
      this.closeApi(api);
    }
  }

  /**
   * Advance one phase: approve (or deny) the currently-pending gate, then resume
   * the run to the next gate. When there is no pending gate but the run is
   * mid-flight (interrupted), resume it instead of returning the stuck state.
   */
  async advance(runId: string, decision: "approve" | "deny" = "approve", note?: string): Promise<EngineState> {
    const { workflow, api, adapter } = this.pipeline(runId);
    try {
      const before = await this.currentState(runId, { api, adapter });
      if (!before.pendingGate) {
        // No gate to decide. If the run was interrupted mid-fusion, drive it
        // forward; if it is terminal, there is nothing to do.
        if (before.needsResume) return await this.resumeRun(runId, { workflow, api });
        return before;
      }

      const decide = decision === "approve" ? approveNode : denyNode;
      await Effect.runPromise(decide(adapter as never, runId, before.pendingGate, 0, note) as never);
      return await this.resumeRun(runId, { workflow, api });
    } finally {
      this.closeApi(api);
    }
  }

  /**
   * Drive an interrupted run forward to its next gate (crash recovery). A no-op
   * for a run that is already at a gate or terminal.
   */
  async resume(runId: string): Promise<EngineState> {
    const { workflow, api, adapter } = this.pipeline(runId);
    try {
      const before = await this.currentState(runId, { api, adapter });
      if (!before.needsResume) return before;
      return await this.runResumeWorkflow(runId, { workflow, api });
    } finally {
      this.closeApi(api);
    }
  }

  /** Read current state without advancing. */
  async state(runId: string): Promise<EngineState> {
    const { api, adapter } = this.pipeline(runId);
    try {
      return await this.currentState(runId, { api, adapter });
    } finally {
      this.closeApi(api);
    }
  }
}

function genRunId(): string {
  // UUID, not Date.now()+Math.random(): two runs started in the same process/ms
  // must not collide on a run id (and thus on their durable db path).
  return `of-${crypto.randomUUID()}`;
}

async function readOutputs(api: { db: unknown; tables: unknown }, runId: string): Promise<Outputs> {
  return (await loadOutputs(api.db as never, api.tables as never, runId)) as Outputs;
}

async function readRunStatus(adapter: RunReader, runId: string): Promise<string | undefined> {
  const runPromise = Effect.runPromise as unknown as (effect: unknown) => Promise<unknown>;
  const run = await runPromise(adapter.getRun(runId));
  return isRunRecord(run) ? run.status : undefined;
}

function isRunRecord(value: unknown): value is { status: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof (value as { status?: unknown }).status === "string"
  );
}

function stripMeta(row: Row | undefined): unknown {
  if (!row) return undefined;
  const { runId: _r, nodeId: _n, iteration: _i, ...rest } = row as Record<string, unknown>;
  return rest;
}

/**
 * The run's lifecycle status. Prefers a real terminal status reported by the
 * runtime (failed/cancelled); otherwise derives it from the phase so callers
 * never see a fabricated placeholder like "loaded".
 */
function lifecycleStatus(phase: EnginePhase, pendingGate: string | null, real?: string): string {
  if (real === "failed" || real === "cancelled") return real;
  if (phase === "done" || phase === "exhausted") return "finished";
  if (phase === "stopped") return real ?? "finished"; // gate denied; run continued past it
  if (pendingGate) return "waiting-approval";
  return real === "finished" ? "finished" : "running"; // mid-flight / not yet at a gate
}

function isTerminalRunStatus(status: string | undefined): boolean {
  return status === "finished" || status === "failed" || status === "cancelled";
}

/**
 * Pure derivation of the run's phase from its persisted outputs — mirrors the
 * pipeline's render conditions. Pure + synchronous so it is trivially testable.
 * `realStatus` is the runtime's reported run status, used only as a hint for
 * terminal states; otherwise the status is derived from the phase.
 */
export function deriveStateFromOutputs(runId: string, realStatus: string | undefined, outs: Outputs): EngineState {
  const synth = (schemaKey: string, prefix: string): Row | undefined =>
    outs[schemaKey]?.find((r) => r.nodeId === `${prefix}-synth`);
  const gate = (nodeId: string): Row | undefined => outs.gate?.find((r) => r.nodeId === nodeId);
  const decided = (nodeId: string): boolean => gate(nodeId) !== undefined;
  const approved = (nodeId: string): boolean =>
    (gate(nodeId) as { approved?: boolean } | undefined)?.approved === true;
  const mk = (
    phase: EnginePhase,
    pendingGate: string | null,
    iteration: number,
    lgtm: boolean | null,
    output: Row | undefined,
  ): EngineState => {
    const needsResume = pendingGate === null && !isTerminalPhase(phase);
    const terminalBeforeGate = needsResume && isTerminalRunStatus(realStatus);
    return {
      runId,
      status: terminalBeforeGate ? "failed" : lifecycleStatus(phase, pendingGate, realStatus),
      phase,
      pendingGate,
      needsResume: terminalBeforeGate ? false : needsResume,
      iteration,
      lgtm,
      output: stripMeta(output),
    };
  };

  const planOut = synth("plan", "plan");
  if (!planOut) return mk("plan", null, 0, null, undefined);
  if (!decided("plan-gate")) return mk("plan", "plan-gate", 0, null, planOut);
  if (!approved("plan-gate")) return mk("stopped", null, 0, null, planOut);

  const implOut = synth("implementation", "impl");
  if (!implOut) return mk("implement", null, 0, null, planOut);
  if (!decided("impl-gate")) return mk("implement", "impl-gate", 0, null, implOut);
  if (!approved("impl-gate")) return mk("stopped", null, 0, null, implOut);

  for (let k = 0; k < MAX_REVIEW_ITERATIONS; k++) {
    const rOut = synth("reviewVerdict", `review-${k}`);
    if (!rOut) return mk("review", null, k, null, k === 0 ? implOut : synth("fix", `fix-${k - 1}`));
    const lgtm = (rOut as { lgtm?: boolean }).lgtm === true;
    if (!decided(`review-${k}-gate`)) return mk("review", `review-${k}-gate`, k, lgtm, rOut);
    if (!approved(`review-${k}-gate`)) return mk("stopped", null, k, lgtm, rOut);
    if (lgtm) return mk("done", null, k, true, rOut);

    const fOut = synth("fix", `fix-${k}`);
    if (!fOut) return mk("fix", null, k, false, rOut);
    if (!decided(`fix-${k}-gate`)) return mk("fix", `fix-${k}-gate`, k, false, fOut);
    if (!approved(`fix-${k}-gate`)) return mk("stopped", null, k, false, fOut);
  }
  // Exhausted the review→fix budget without ever reaching LGTM. This is NOT a
  // success: report it as a distinct terminal phase with lgtm=false (never
  // claim done/lgtm=true), surfacing the last fix for the caller to inspect.
  const lastFix = synth("fix", `fix-${MAX_REVIEW_ITERATIONS - 1}`);
  return mk("exhausted", null, MAX_REVIEW_ITERATIONS, false, lastFix);
}
