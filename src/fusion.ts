/** @jsxImportSource smithers-orchestrator */

import { unlinkSync } from "node:fs";
import { Effect } from "effect";
import { createSmithers, runWorkflow } from "smithers-orchestrator";
import { jsx as rawJsx, jsxs as rawJsxs } from "smithers-orchestrator/jsx-runtime";
import type { z } from "zod";
import { buildPanel, defaultJudge, resolveAgent, resolveModelSpec } from "./agents";
import { readLatest, readOutputs, tableNameFor } from "./outputs";
import { judgePrompt } from "./prompts/judge";
import { panelistPrompt } from "./prompts/panelist";
import { synthesizePrompt } from "./prompts/synthesize";
import { finalAnswer, judgment, panelResponse } from "./schemas";
import type { Judgment, PanelResponse } from "./schemas";
import type { AgentLike, FusionConfig, FusionResult, ModelSpec, PanelMember } from "./types";

export type RunStatus =
  | "finished"
  | "failed"
  | "cancelled"
  | "continued"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer";

export type FuseInput = {
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

export type FuseWithInput<TSchema extends z.ZodObject<any>> = {
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
  options: { input: Record<string, unknown>; runId: string },
) => unknown;
type CreateSmithersLite = (
  schemas: Record<string, unknown>,
  options: { dbPath: string },
) => SmithersKit;

// Element factories from the smithers JSX runtime. Building the tree by calling
// these directly is exactly what JSX compiles to, while avoiding `jsxImportSource`
// (whose JSX type-checking exhausts tsc's heap on smithers' deep workflow types).
// The third arg is the React key, which keeps the reconciler from warning about
// keyless children in the panel fan-out.
const h = rawJsx;
const hs = rawJsxs;

const emptyJudgment: Judgment = {
  consensus: [],
  contradictions: [],
  uniqueInsights: [],
  blindSpots: [],
  recommendation: "",
  confidence: "low",
};

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
  const runId = input.runId ?? `fusion-${Date.now()}`;
  const dbPath =
    input.dbPath ?? `/tmp/open-fusions-${runId}-${Math.floor(Math.random() * 1_000_000)}.db`;
  const createSmithersLite = createSmithers as unknown as CreateSmithersLite;
  const runWorkflowLite = runWorkflow as unknown as WorkflowRunner;
  const runPromiseLite = Effect.runPromise as unknown as (effect: unknown) => Promise<{ status: RunStatus }>;
  const { Workflow, Sequence, Parallel, Task, smithers, outputs } = createSmithersLite(
    { panelResponse, judgment, synthesis: input.schema },
    { dbPath },
  );
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
              continueOnFail: true,
              children: input.panel.map((member) =>
                h(
                  Task,
                  {
                    id: `panelist-${member.id}`,
                    output: outputs.panelResponse,
                    agent: member.agent,
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
              agent: input.judge.agent,
              children: judgePrompt(input.prompt, responses),
            },
            "judge",
          ),
          h(
            Task,
            {
              id: "synthesize",
              output: outputs.synthesis,
              agent: input.synthesizer.agent,
              children: synthesizePrompt(input.prompt, latestJudgment, responses),
            },
            "synthesize",
          ),
        ],
      }),
    });
  });

  const res = await runPromiseLite(runWorkflowLite(wf, { input: {}, runId }));
  const panel = readOutputs(dbPath, runId, tableNameFor("panelResponse")) as PanelResponse[];
  const latestJudgment = readLatest(dbPath, runId, tableNameFor("judgment")) as Judgment | undefined;
  const latestOutput = readLatest(dbPath, runId, tableNameFor("synthesis")) as z.infer<TSchema> | undefined;

  if (input.cleanup !== false) {
    cleanupDb(dbPath);
  }

  return {
    output: input.schema.parse(latestOutput),
    judgment: latestJudgment ?? emptyJudgment,
    panel,
    status: res.status as RunStatus,
  };
}

export async function runFusion(config: FusionConfig & { prompt: string }): Promise<FuseResult> {
  const panel = buildPanel(config);
  const judge = memberFor(config.judge ?? defaultJudge());
  const synthesizer = memberFor(config.synthesizer ?? config.judge ?? defaultJudge());

  return fuse({
    prompt: config.prompt,
    panel,
    judge,
    synthesizer,
  });
}

function memberFor(spec: ModelSpec): PanelMember {
  return {
    id: resolveModelSpec(spec).id,
    spec,
    agent: resolveAgent(spec) as AgentLike,
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
}
