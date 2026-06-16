import { approvalDecisionSchema, createSmithers, SmithersDb } from "smithers-orchestrator";
import { jsx as rawJsx, jsxs as rawJsxs } from "smithers-orchestrator/jsx-runtime";
import { z } from "zod";
import { fixPrompt } from "./prompts/fix";
import { implementPrompt } from "./prompts/implement";
import { judgePrompt } from "./prompts/judge";
import { panelistPrompt } from "./prompts/panelist";
import { planPrompt } from "./prompts/plan";
import { reviewPrompt } from "./prompts/review";
import { synthesizePrompt } from "./prompts/synthesize";
import { safeCoerce } from "./coerce";
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, schemaFailFastAgent } from "./fusion";
import { fix, implementation, judgment, panelResponse, plan, reviewVerdict } from "./schemas";
import type { Fix, Implementation, Judgment, PanelResponse, Plan, ReviewVerdict } from "./schemas";
import type { AgentLike } from "./types";

const h = rawJsx;
const hs = rawJsxs;

/** Safety bound on the review→fix loop so a stubborn diff can't run forever. */
export const MAX_REVIEW_ITERATIONS = 5;

export type PhaseRole = "panelist" | "judge" | "synthesizer";

/**
 * Resolves a model id + the role it plays into an agent. Injectable so tests can
 * supply deterministic stubs and skip the network. Model ids are plain strings
 * (a subscription harness like `claude-code`, a registered account label, or an
 * opt-in `openrouter:`/`compat:` id), persisted in the run input so the workflow
 * is byte-identical on every resume.
 */
export type AgentFor = (modelId: string, role: PhaseRole) => AgentLike;

export type PipelineDeps = {
  agentFor: AgentFor;
  /** Retries per task before failure; total attempts = retries + 1 (default {@link DEFAULT_RETRIES}). */
  retries?: number;
  /** Per-task timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
};

/** Durable schemas for the whole plan→implement→review→fix run. */
export const pipelineSchemas = {
  input: z.object({
    task: z.string(),
    panel: z.array(z.string()),
    judge: z.string(),
    synthesizer: z.string().optional(),
  }),
  panelResponse,
  judgment,
  plan,
  implementation,
  reviewVerdict,
  fix,
  // One approval-decision table; each gate is a distinct node id within it.
  gate: approvalDecisionSchema,
};

const emptyJudgment: Judgment = {
  consensus: [],
  contradictions: [],
  uniqueInsights: [],
  blindSpots: [],
  recommendation: "",
  confidence: "low",
};

function changesToText(summary: string, changes: { file: string; description: string }[] | undefined): string {
  return [summary ?? "", ...(changes ?? []).map((c) => `- ${c.file}: ${c.description}`)].join("\n");
}

/**
 * The context a reviewer/fixer sees: the original implementation PLUS every fix
 * applied so far. The review→fix loop must never collapse this to just the
 * latest fix — otherwise iteration k>=1 grades a patch with no memory of what
 * was implemented. Deterministic (pure function of persisted rows), so it
 * rebuilds identically on every resume.
 */
export function composeReviewContext(implementation: Implementation, fixes: Fix[]): string {
  const segments = [changesToText(implementation.summary, implementation.changes)];
  fixes.forEach((f, i) => segments.push(`Fix ${i + 1}:\n${changesToText(f.summary, f.changes)}`));
  return segments.join("\n\n");
}

/**
 * Build the durable pipeline as ONE smithers workflow. Each phase
 * (plan/implement/review/fix) is a fusion sub-tree (panel → judge → synthesize),
 * separated by `<Approval>` gates so the run pauses after every phase and the
 * driving agent advances it one step (one process) at a time. The review→fix
 * loop repeats until a review returns `lgtm`.
 *
 * The panel/judge model ids and the task all live in the persisted run input, so
 * the rendered tree is identical on every process that resumes the run by id.
 */
export function buildPipeline(dbPath: string, deps: PipelineDeps) {
  // createSmithers' return type is generic over the schema set and is too deep for
  // tsc to instantiate here (TS2589); building the tree with JSX would likewise
  // exhaust tsc's heap. So call it through a minimal local signature and assemble
  // the tree with the jsx() runtime factories instead of JSX syntax.
  const api = (createSmithers as unknown as (schemas: unknown, opts: { dbPath: string }) => PipelineApi)(
    pipelineSchemas,
    { dbPath },
  );
  const { Workflow, Sequence, Parallel, Task, Approval, smithers, outputs } = api;
  // Bound retries/runtime so a permanently-failing model (e.g. a stale account
  // model the provider 400s) fails fast instead of retrying forever (smithers
  // defaults an agent Task to retries: Infinity) and hanging a durable run that
  // resumes the identical tree on every process.
  const retries = deps.retries ?? DEFAULT_RETRIES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const workflow = smithers((ctx) => {
    const { task, panel, judge } = ctx.input;
    const synthSpec = ctx.input.synthesizer ?? judge;
    const gateApproved = (nodeId: string): boolean =>
      (ctx.outputMaybe(outputs.gate, { nodeId }) as { approved?: boolean } | undefined)?.approved === true;
    const synthRow = <T>(key: unknown, prefix: string): T | undefined =>
      ctx.outputMaybe(key, { nodeId: `${prefix}-synth` }) as T | undefined;

    // A fusion sub-tree for one phase: N panelists in parallel → judge → synthesize.
    const fusion = (prefix: string, prompt: string, synthKey: unknown): unknown[] => {
      const panelEls = panel.map((modelId, i) => {
        const id = `${prefix}-p-${i}`;
        return h(
          Task,
          { id, output: outputs.panelResponse, agent: schemaFailFastAgent(deps.agentFor(modelId, "panelist")), retries, timeoutMs, continueOnFail: true, children: panelistPrompt(prompt, modelId) },
          id,
        );
      });
      // Validate/recover each persisted row instead of trusting a truthiness
      // cast — a malformed or double-encoded panel row must not flow into the
      // judge prompt as if it were a valid PanelResponse.
      const responses = panel
        .map((_, i) => safeCoerce(panelResponse, ctx.outputMaybe(outputs.panelResponse, { nodeId: `${prefix}-p-${i}` })))
        .filter((r): r is PanelResponse => r !== undefined);
      const judgeRow = safeCoerce(judgment, ctx.outputMaybe(outputs.judgment, { nodeId: `${prefix}-judge` })) ?? emptyJudgment;
      return [
        h(Parallel, { maxConcurrency: panel.length, children: panelEls }, `${prefix}-panel`),
        h(Task, { id: `${prefix}-judge`, output: outputs.judgment, agent: schemaFailFastAgent(deps.agentFor(judge, "judge")), retries, timeoutMs, continueOnFail: true, children: judgePrompt(prompt, responses) }, `${prefix}-judge`),
        h(Task, { id: `${prefix}-synth`, output: synthKey, agent: schemaFailFastAgent(deps.agentFor(synthSpec, "synthesizer")), retries, timeoutMs, continueOnFail: true, children: synthesizePrompt(prompt, judgeRow, responses) }, `${prefix}-synth`),
      ];
    };
    const gate = (nodeId: string, title: string, summary?: string): unknown =>
      h(Approval, { id: nodeId, output: outputs.gate, request: { title, summary }, onDeny: "continue" }, nodeId);

    const children: unknown[] = [];

    // 1. PLAN
    children.push(...fusion("plan", planPrompt(task), outputs.plan));
    const planOut = synthRow<Plan>(outputs.plan, "plan");
    if (planOut) children.push(gate("plan-gate", "Approve the plan?", planOut.steps?.[0]?.title));

    // 2. IMPLEMENT
    if (gateApproved("plan-gate") && planOut) {
      children.push(...fusion("impl", implementPrompt(task, planOut), outputs.implementation));
      const implOut = synthRow<Implementation>(outputs.implementation, "impl");
      if (implOut) children.push(gate("impl-gate", "Approve the implementation?", implOut.summary));

      // 3. REVIEW → FIX loop. `fixes` accumulates every applied fix so each
      //    review/fix sees the implementation PLUS all prior fixes (never just
      //    the latest one). Rebuilt deterministically from persisted rows.
      if (gateApproved("impl-gate") && implOut) {
        const fixes: Fix[] = [];
        for (let k = 0; k < MAX_REVIEW_ITERATIONS; k++) {
          const context = composeReviewContext(implOut, fixes);
          children.push(...fusion(`review-${k}`, reviewPrompt(task, planOut, context), outputs.reviewVerdict));
          const rOut = synthRow<ReviewVerdict>(outputs.reviewVerdict, `review-${k}`);
          if (rOut) {
            children.push(gate(`review-${k}-gate`, rOut.lgtm ? "Review: LGTM — acknowledge?" : "Review found issues — acknowledge?", rOut.summary));
          }
          if (!rOut || !gateApproved(`review-${k}-gate`)) break;
          if (rOut.lgtm) break; // done

          children.push(...fusion(`fix-${k}`, fixPrompt(task, planOut, context, rOut.issues), outputs.fix));
          const fOut = synthRow<Fix>(outputs.fix, `fix-${k}`);
          if (fOut) children.push(gate(`fix-${k}-gate`, "Approve the fix?", fOut.summary));
          if (!fOut || !gateApproved(`fix-${k}-gate`)) break;
          fixes.push(fOut);
        }
      }
    }

    return h(Workflow, { name: "open-fusions", children: hs(Sequence, { children }) });
  });

  const adapter = new (SmithersDb as unknown as new (db: unknown) => SmithersDb)(
    (workflow as { db: unknown }).db,
  );
  return { api, workflow, adapter, dbPath };
}

type PipelineCtx = {
  input: { task: string; panel: string[]; judge: string; synthesizer?: string };
  outputMaybe: (key: unknown, opts: { nodeId: string }) => unknown;
};

export type SmithersWorkflow = { db: unknown };

type PipelineApi = {
  Workflow: unknown;
  Sequence: unknown;
  Parallel: unknown;
  Task: unknown;
  Approval: unknown;
  smithers: (render: (ctx: PipelineCtx) => unknown) => SmithersWorkflow;
  outputs: Record<string, unknown>;
  db: unknown;
  tables: unknown;
};

export type Pipeline = ReturnType<typeof buildPipeline>;
