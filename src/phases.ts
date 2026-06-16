import type { z } from "zod";
import { buildPanel, defaultJudge, defaultPanel, resolveAgent, resolveModelSpec } from "./agents";
import { fuseWith } from "./fusion";
import { fix, implementation, plan, reviewVerdict } from "./schemas";
import type { Judgment, PanelResponse, Plan, SessionState } from "./schemas";
import { fixPrompt } from "./prompts/fix";
import { implementPrompt } from "./prompts/implement";
import { planPrompt } from "./prompts/plan";
import { reviewPrompt } from "./prompts/review";
import { SessionStore } from "./session";
import type { AgentLike, FusionConfig, ModelSpec, PanelMember, Phase } from "./types";
import type { RunStatus } from "./fusion";

export type PhaseFusion = (args: {
  prompt: string;
  schema: z.ZodObject<any>;
  config?: FusionConfig;
}) => Promise<{ output: unknown; judgment: Judgment; panel: PanelResponse[]; status: RunStatus }>;

export type PhaseDeps = {
  fusion: PhaseFusion;
  store: SessionStore;
};

export type PhaseResult = {
  session: SessionState;
  output: unknown;
  judgment: Judgment;
  panel: PanelResponse[];
};

export const defaultPhaseFusion: PhaseFusion = async (args) => {
  const config = args.config ?? { panel: defaultPanel() };
  const panel = buildPanel(config);
  const judge = memberFor(config.judge ?? defaultJudge());
  const synthesizer = memberFor(config.synthesizer ?? config.judge ?? defaultJudge());

  return fuseWith({
    prompt: args.prompt,
    panel,
    judge,
    synthesizer,
    schema: args.schema,
  });
};

export async function runPlan(
  session: SessionState,
  deps: PhaseDeps,
  config?: FusionConfig,
): Promise<PhaseResult> {
  const result = await deps.fusion({ prompt: planPrompt(session.task), schema: plan, config });
  const output = plan.parse(result.output);
  const next = {
    ...session,
    plan: output,
    phase: "implement" as const,
    history: [...session.history, historyEntry("plan", summaryForPlan(output))],
  };

  deps.store.save(next);
  return phaseResult(next, output, result);
}

export async function runImplement(
  session: SessionState,
  deps: PhaseDeps,
  config?: FusionConfig,
): Promise<PhaseResult> {
  const result = await deps.fusion({
    prompt: implementPrompt(session.task, session.plan!),
    schema: implementation,
    config,
  });
  const output = implementation.parse(result.output);
  const next = {
    ...session,
    implementation: output,
    phase: "review" as const,
    history: [...session.history, historyEntry("implement", output.summary)],
  };

  deps.store.save(next);
  return phaseResult(next, output, result);
}

export async function runReview(
  session: SessionState,
  deps: PhaseDeps,
  config?: FusionConfig,
  diff = "",
): Promise<PhaseResult> {
  const result = await deps.fusion({
    prompt: reviewPrompt(session.task, session.plan!, diff),
    schema: reviewVerdict,
    config,
  });
  const output = reviewVerdict.parse(result.output);
  const next = {
    ...session,
    lastReview: output,
    iteration: session.iteration + 1,
    phase: output.lgtm ? ("review" as const) : ("fix" as const),
    history: [...session.history, historyEntry("review", output.summary)],
  };

  deps.store.save(next);
  return phaseResult(next, output, result);
}

export async function runFix(
  session: SessionState,
  deps: PhaseDeps,
  config?: FusionConfig,
): Promise<PhaseResult> {
  const result = await deps.fusion({
    prompt: fixPrompt(session.task, session.lastReview!.issues),
    schema: fix,
    config,
  });
  const output = fix.parse(result.output);
  const next = {
    ...session,
    phase: "review" as const,
    history: [...session.history, historyEntry("fix", output.summary)],
  };

  deps.store.save(next);
  return phaseResult(next, output, result);
}

function memberFor(spec: ModelSpec): PanelMember {
  return {
    id: resolveModelSpec(spec).id,
    spec,
    agent: resolveAgent(spec) as AgentLike,
  };
}

function historyEntry(phase: Phase, summary: string): SessionState["history"][number] {
  return {
    phase,
    at: new Date().toISOString(),
    summary: summary.slice(0, 160),
  };
}

function summaryForPlan(output: Plan): string {
  return output.steps.at(0)?.title ?? "Plan created";
}

function phaseResult<TOutput>(
  session: SessionState,
  output: TOutput,
  result: { judgment: Judgment; panel: PanelResponse[] },
): PhaseResult {
  return {
    session,
    output,
    judgment: result.judgment,
    panel: result.panel,
  };
}
