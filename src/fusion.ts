/** @jsxImportSource smithers-orchestrator */

import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createSmithers, runWorkflow, SmithersErrorInstance } from "smithers-orchestrator";
import { jsx as rawJsx, jsxs as rawJsxs } from "smithers-orchestrator/jsx-runtime";
import type { z } from "zod";
import { buildPanel, defaultJudge, resolveAgent, resolveModelSpec } from "./agents";
import { coerceToSchema, safeCoerce } from "./coerce";
import { FusionError } from "./errors";
import { readLatest, readOutputs, tableNameFor } from "./outputs";
import { judgePrompt } from "./prompts/judge";
import { panelistPrompt } from "./prompts/panelist";
import { synthesizePrompt } from "./prompts/synthesize";
import { finalAnswer, judgment, panelResponse } from "./schemas";
import type { Judgment, PanelResponse } from "./schemas";
import type { AgentLike, FusionConfig, FusionResult, ModelSpec, PanelMember } from "./types";

export type RunStatus =
  | "running"
  | "finished"
  | "failed"
  | "cancelled"
  | "continued"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer";

/**
 * Bounded retries per task. smithers' graph builder defaults an agent Task to
 * `retries: Infinity` (verified in `@smithers-orchestrator/graph` extract.js),
 * so a permanently-failing model — e.g. a stale account model the provider
 * 400s — would retry forever and hang the whole fusion. `retries: 2` means up
 * to 3 attempts, then fail.
 */
export const DEFAULT_RETRIES = 2;
/** Per-task wall-clock safety net against a hung CLI harness (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 600_000;

export type ReliabilityOptions = {
  /** Retries per task before it fails; total attempts = retries + 1 (default {@link DEFAULT_RETRIES}). */
  retries?: number;
  /** Per-task timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
};

export type FuseInput = ReliabilityOptions & {
  prompt: string;
  panel: PanelMember[];
  judge: PanelMember;
  synthesizer: PanelMember;
  dbPath?: string;
  runId?: string;
  cleanup?: boolean;
};

export type FuseResult = FusionResult & {
  status: RunStatus;
};

export type FuseWithInput<TSchema extends z.ZodObject<any>> = ReliabilityOptions & {
  prompt: string;
  panel: PanelMember[];
  judge: PanelMember;
  synthesizer: PanelMember;
  schema: TSchema;
  dbPath?: string;
  runId?: string;
  cleanup?: boolean;
};

export type FuseWithResult<TSchema extends z.ZodObject<any>> = {
  output: z.infer<TSchema>;
  judgment: Judgment;
  panel: PanelResponse[];
  status: RunStatus;
};

type OutputToken = unknown;
type WorkflowContext = {
  outputs: {
    panelResponse?: PanelResponse[];
    judgment?: Judgment[];
  };
};
type Component = (props: Record<string, unknown> & { children?: unknown }) => unknown;
type SmithersKit = {
  Workflow: Component;
  Sequence: Component;
  Parallel: Component;
  Task: Component;
  smithers(render: (ctx: WorkflowContext) => unknown): unknown;
  outputs: {
    panelResponse: OutputToken;
    judgment: OutputToken;
    finalAnswer?: OutputToken;
    synthesis: OutputToken;
  };
};
type WorkflowRunner = (
  workflow: unknown,
  options: { input: Record<string, unknown>; runId: string; logDir?: string },
) => unknown;
type CreateSmithersLite = (
  schemas: Record<string, unknown>,
  options: { dbPath: string },
) => SmithersKit;
type SchemaLike = {
  safeParse(value: unknown): { success: true } | { success: false; error: unknown };
};
type GenerateArgsWithSchema = {
  outputSchema?: SchemaLike;
};
type GenerateResultWithOutput = {
  output?: unknown;
  _output?: unknown;
};
type StructuredOutputResult = {
  present: boolean;
  field?: "_output" | "output";
  value: unknown;
};

// Element factories from the smithers JSX runtime. Building the tree by calling
// these directly is exactly what JSX compiles to, while avoiding `jsxImportSource`
// (whose JSX type-checking exhausts tsc's heap on smithers' deep workflow types).
// The third arg is the React key, which keeps the reconciler from warning about
// keyless children in the panel fan-out.
const h = rawJsx;
const hs = rawJsxs;
const schemaFailFastAgents = new WeakMap<AgentLike, AgentLike>();

const emptyJudgment: Judgment = {
  consensus: [],
  contradictions: [],
  uniqueInsights: [],
  blindSpots: [],
  recommendation: "",
  confidence: "low",
};

export function schemaFailFastAgent(agent: AgentLike): AgentLike {
  const cached = schemaFailFastAgents.get(agent);
  if (cached) return cached;

  const wrapped = new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop !== "generate") return Reflect.get(target, prop, receiver);
      return async (args?: unknown): Promise<unknown> => {
        const result = await target.generate(args);
        const schema = outputSchemaFromArgs(args);
        const output = structuredOutputFromResult(result);
        if (schema && output.present && isStructuredFailFastCandidate(output.value)) {
          const recovered = safeCoerce(schema as z.ZodType<unknown>, output.value);
          if (recovered === undefined) {
            const parsed = schema.safeParse(output.value);
            throw nonRetryableSchemaError(parsed.success ? undefined : parsed.error);
          }
          return replaceStructuredOutput(result, output.field, recovered);
        }
        return result;
      };
    },
  });
  schemaFailFastAgents.set(agent, wrapped);
  return wrapped;
}

export async function fuse(input: FuseInput): Promise<FuseResult> {
  const result = await fuseWith({ ...input, schema: finalAnswer });

  return {
    answer: result.output.answer,
    judgment: result.judgment,
    panel: result.panel,
    status: result.status,
  };
}

export async function fuseWith<TSchema extends z.ZodObject<any>>(
  input: FuseWithInput<TSchema>,
): Promise<FuseWithResult<TSchema>> {
  if (input.panel.length === 0) {
    throw new FusionError(
      "A fusion needs at least one panel model. Pass `panel`, or register a subscription with `smithers agents add`.",
    );
  }
  const retries = input.retries ?? DEFAULT_RETRIES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // UUID id + OS temp dir: collision-free across concurrent fusions, portable.
  const runId = input.runId ?? `fusion-${crypto.randomUUID()}`;
  const dbPath = input.dbPath ?? join(tmpdir(), `smithers-fusions-${runId}.db`);
  // Direct smithers' workflow logs to a temp dir, not stdout — otherwise they
  // pollute `fuse --json` output (smithers logs structured lines to stdout).
  const logDir = `${dbPath}.logs`;
  mkdirSync(logDir, { recursive: true });
  const createSmithersLite = createSmithers as unknown as CreateSmithersLite;
  const runWorkflowLite = runWorkflow as unknown as WorkflowRunner;
  const runPromiseLite = Effect.runPromise as unknown as (effect: unknown) => Promise<{ status: RunStatus }>;
  const kit = createSmithersLite({ panelResponse, judgment, synthesis: input.schema }, { dbPath });
  const { Workflow, Sequence, Parallel, Task, smithers, outputs } = kit;
  const wf = smithers((ctx) => {
    const responses = ctx.outputs.panelResponse ?? [];
    const latestJudgment = ctx.outputs.judgment?.at(-1) ?? emptyJudgment;
    return h(Workflow, {
      name: "fusion",
      children: hs(Sequence, {
        children: [
          h(
            Parallel,
            {
              maxConcurrency: input.panel.length,
              // NOTE: `continueOnFail` is read per-Task by smithers, not on
              // <Parallel> — it's set on each panelist below so one failing
              // panelist can't sink the whole fusion.
              children: input.panel.map((member) =>
                h(
                  Task,
                  {
                    id: `panelist-${member.id}`,
                    output: outputs.panelResponse,
                    agent: schemaFailFastAgent(member.agent),
                    retries,
                    timeoutMs,
                    continueOnFail: true,
                    children: panelistPrompt(input.prompt, member.id),
                  },
                  member.id,
                ),
              ),
            },
            "panel",
          ),
          h(
            Task,
            {
              id: "judge",
              output: outputs.judgment,
              agent: schemaFailFastAgent(input.judge.agent),
              retries,
              timeoutMs,
              // Tolerate a failed judge: the synthesizer falls back to an empty
              // judgment rather than failing the whole fusion.
              continueOnFail: true,
              children: judgePrompt(input.prompt, responses),
            },
            "judge",
          ),
          h(
            Task,
            {
              id: "synthesize",
              output: outputs.synthesis,
              agent: schemaFailFastAgent(input.synthesizer.agent),
              retries,
              timeoutMs,
              continueOnFail: true,
              children: synthesizePrompt(input.prompt, latestJudgment, responses),
            },
            "synthesize",
          ),
        ],
      }),
    });
  });

  const res = await runPromiseLite(runWorkflowLite(wf, { input: {}, runId, logDir }));

  // Read everything out before cleanup; `finally` guarantees the temp db is
  // removed even if a read throws (no leaked file on the error path).
  let panelRows: Record<string, unknown>[];
  let judgmentRow: Record<string, unknown> | undefined;
  let outputRow: Record<string, unknown> | undefined;
  try {
    panelRows = sortPanelRowsByInputOrder(readOutputs(dbPath, runId, tableNameFor("panelResponse")), input.panel);
    judgmentRow = readLatest(dbPath, runId, tableNameFor("judgment"));
    outputRow = readLatest(dbPath, runId, tableNameFor("synthesis"));
  } finally {
    // Close the smithers write connection. createSmithers opens a bun:sqlite
    // handle (and registers a process "exit" closer) but exposes no close(), so
    // a long-lived process calling fuse() repeatedly would leak a file handle
    // per call. Closing here releases it before the temp db is unlinked.
    try {
      (kit as { db?: { close?: () => void } }).db?.close?.();
    } catch {
      // Best effort: a failed close must not mask the fusion result/error.
    }
    if (input.cleanup !== false) {
      cleanupDb(dbPath);
    }
  }

  // Coerce loosely-structured model output back to the schema (CLI harnesses
  // without native structured output commonly double-encode). Drop panel rows
  // that can't be recovered; fall back to an empty judgment if the judge's was
  // malformed; a missing/invalid synthesized output is a hard error.
  const panel = panelRows
    .map((row) => safeCoerce(panelResponse, row))
    .filter((row): row is PanelResponse => row !== undefined);
  const judgmentResult = judgmentRow ? safeCoerce(judgment, judgmentRow) : undefined;

  if (outputRow === undefined) {
    throw new FusionError(
      `Fusion produced no synthesized output (run ${runId}, status: ${res.status}). ` +
        "All panelists or the synthesizer may have failed — check the model ids and logs.",
    );
  }
  let output: z.infer<TSchema>;
  try {
    output = coerceToSchema(input.schema, outputRow) as z.infer<TSchema>;
  } catch (cause) {
    throw new FusionError(
      `Fusion synthesizer output did not match the expected schema (run ${runId}).`,
      { cause },
    );
  }

  return {
    output,
    judgment: judgmentResult ?? emptyJudgment,
    panel,
    status: res.status as RunStatus,
  };
}

function outputSchemaFromArgs(args: unknown): SchemaLike | undefined {
  const schema = (args as GenerateArgsWithSchema | undefined)?.outputSchema;
  return schema && typeof schema.safeParse === "function" ? schema : undefined;
}

function structuredOutputFromResult(result: unknown): StructuredOutputResult {
  if (result === null || typeof result !== "object") return { present: false, value: undefined };
  const r = result as GenerateResultWithOutput;
  if (r._output !== undefined && r._output !== null) return { present: true, field: "_output", value: r._output };
  if (r.output !== undefined && r.output !== null) return { present: true, field: "output", value: r.output };
  return { present: false, value: undefined };
}

function replaceStructuredOutput(result: unknown, field: "_output" | "output" | undefined, value: unknown): unknown {
  if (!field || result === null || typeof result !== "object") return result;
  return { ...(result as Record<string, unknown>), [field]: value };
}

function isStructuredFailFastCandidate(value: unknown): boolean {
  return (typeof value === "object" && value !== null) || Array.isArray(value);
}

function sortPanelRowsByInputOrder(
  rows: Record<string, unknown>[],
  panel: PanelMember[],
): Record<string, unknown>[] {
  const byNodeId = new Map(panel.map((member, index) => [`panelist-${member.id}`, index]));
  return rows
    .map((row, originalIndex) => ({ row, originalIndex, panelIndex: panelIndexForRow(row, byNodeId) }))
    .sort((a, b) => a.panelIndex - b.panelIndex || a.originalIndex - b.originalIndex)
    .map(({ row }) => row);
}

function panelIndexForRow(row: Record<string, unknown>, byNodeId: ReadonlyMap<string, number>): number {
  const nodeId = typeof row.node_id === "string" ? row.node_id : typeof row.nodeId === "string" ? row.nodeId : undefined;
  return nodeId === undefined ? Number.POSITIVE_INFINITY : byNodeId.get(nodeId) ?? Number.POSITIVE_INFINITY;
}

function nonRetryableSchemaError(cause: unknown): SmithersErrorInstance {
  return new SmithersErrorInstance(
    "INVALID_OUTPUT",
    "Task output failed schema validation before smithers retry scheduling.",
    { failureRetryable: false, issues: zodIssues(cause) },
    { cause, includeDocsUrl: false },
  );
}

function zodIssues(error: unknown): unknown {
  return error !== null && typeof error === "object" && "issues" in error
    ? (error as { issues: unknown }).issues
    : undefined;
}

export async function runFusion(config: FusionConfig & { prompt: string }): Promise<FuseResult> {
  const env = config.env;
  const panel = buildPanel(config);
  const judge = memberFor(config.judge ?? defaultJudge(env), env);
  const synthesizer = memberFor(config.synthesizer ?? config.judge ?? defaultJudge(env), env);

  return fuse({
    prompt: config.prompt,
    panel,
    judge,
    synthesizer,
  });
}

function memberFor(spec: ModelSpec, env?: NodeJS.ProcessEnv): PanelMember {
  return {
    id: resolveModelSpec(spec).id,
    spec,
    agent: resolveAgent(spec, env),
  };
}

function cleanupDb(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup: the caller already has the fusion result.
    }
  }
  try {
    rmSync(`${dbPath}.logs`, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of the temp log dir.
  }
}
