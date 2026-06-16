import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { approveNode, denyNode, loadOutputs, runWorkflow } from "smithers-orchestrator";
import { resolveAgent } from "./agents";
import { buildPipeline, MAX_REVIEW_ITERATIONS, type AgentFor } from "./pipeline";

export type EnginePhase = "plan" | "implement" | "review" | "fix" | "done" | "stopped";

export type EngineState = {
  runId: string;
  status: string;
  /** The phase whose output is ready and whose gate (if any) is awaiting a decision. */
  phase: EnginePhase;
  /** The approval node id awaiting a decision, or null when finished/stopped. */
  pendingGate: string | null;
  /** Current review→fix iteration. */
  iteration: number;
  /** Latest review verdict, when a review has run. */
  lgtm: boolean | null;
  /** The synthesized output of the current phase (plan/implementation/verdict/fix). */
  output: unknown;
};

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
    mkdirSync(this.dir, { recursive: true });
    return buildPipeline(this.dbPathFor(runId), { agentFor: this.agentFor });
  }

  /** Start a new durable run; produces the plan and pauses at the plan gate. */
  async start(task: string, config: RunConfig, runId = genRunId()): Promise<EngineState> {
    const { workflow, api } = this.pipeline(runId);
    const input: Record<string, unknown> = { task, panel: config.panel, judge: config.judge };
    if (config.synthesizer) input.synthesizer = config.synthesizer;
    const res = (await Effect.runPromise(
      runWorkflow(workflow as never, { input, runId, logDir: join(this.dir, "logs") }) as never,
    )) as { status: string };
    return deriveStateFromOutputs(runId, res.status, await readOutputs(api, runId));
  }

  /**
   * Advance one phase: approve (or deny) the currently-pending gate, then resume
   * the run to the next gate. Returns the new state.
   */
  async advance(runId: string, decision: "approve" | "deny" = "approve", note?: string): Promise<EngineState> {
    const { workflow, api, adapter } = this.pipeline(runId);
    const before = deriveStateFromOutputs(runId, "waiting-approval", await readOutputs(api, runId));
    if (!before.pendingGate) return before;

    const decide = decision === "approve" ? approveNode : denyNode;
    await Effect.runPromise(decide(adapter as never, runId, before.pendingGate, 0, note) as never);
    const res = (await Effect.runPromise(
      runWorkflow(workflow as never, { input: {}, runId, resume: true, logDir: join(this.dir, "logs") }) as never,
    )) as { status: string };
    return deriveStateFromOutputs(runId, res.status, await readOutputs(api, runId));
  }

  /** Read current state without advancing. */
  async state(runId: string): Promise<EngineState> {
    const { api } = this.pipeline(runId);
    return deriveStateFromOutputs(runId, "loaded", await readOutputs(api, runId));
  }
}

function genRunId(): string {
  return `of-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
}

async function readOutputs(api: { db: unknown; tables: unknown }, runId: string): Promise<Outputs> {
  return (await loadOutputs(api.db as never, api.tables as never, runId)) as Outputs;
}

function stripMeta(row: Row | undefined): unknown {
  if (!row) return undefined;
  const { runId: _r, nodeId: _n, iteration: _i, ...rest } = row as Record<string, unknown>;
  return rest;
}

/**
 * Pure derivation of the run's phase from its persisted outputs — mirrors the
 * pipeline's render conditions. Pure + synchronous so it is trivially testable.
 */
export function deriveStateFromOutputs(runId: string, status: string, outs: Outputs): EngineState {
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
  ): EngineState => ({ runId, status, phase, pendingGate, iteration, lgtm, output: stripMeta(output) });

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
  return mk("done", null, MAX_REVIEW_ITERATIONS, true, undefined);
}
