import { z } from "zod";

const confidence = z.enum(["low", "medium", "high"]);
const phase = z.enum(["plan", "implement", "review", "fix"]);
const change = z.object({
  file: z.string(),
  description: z.string(),
});

export const panelResponse = z.object({
  model: z.string(),
  answer: z.string(),
  confidence: confidence.optional(),
});

export const judgment = z.object({
  consensus: z.array(z.string()),
  contradictions: z.array(
    z.object({
      topic: z.string(),
      positions: z.array(z.string()),
    }),
  ),
  uniqueInsights: z.array(
    z.object({
      model: z.string(),
      insight: z.string(),
    }),
  ),
  blindSpots: z.array(z.string()),
  recommendation: z.string(),
  confidence,
});

export const finalAnswer = z.object({
  answer: z.string(),
  caveats: z.array(z.string()),
});

export const plan = z.object({
  steps: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
    }),
  ),
  risks: z.array(z.string()),
  files: z.array(z.string()),
});

export const implementation = z.object({
  summary: z.string(),
  changes: z.array(change),
});

export const reviewVerdict = z.object({
  lgtm: z.boolean(),
  summary: z.string(),
  issues: z.array(
    z.object({
      severity: confidence,
      file: z.string().optional(),
      description: z.string(),
    }),
  ),
});

export const fix = z.object({
  summary: z.string(),
  changes: z.array(change),
});

export const sessionState = z.object({
  id: z.string(),
  task: z.string(),
  phase,
  iteration: z.number(),
  plan: plan.optional(),
  implementation: implementation.optional(),
  lastReview: reviewVerdict.optional(),
  history: z.array(
    z.object({
      phase,
      at: z.string(),
      summary: z.string(),
    }),
  ),
});

export type PanelResponse = z.infer<typeof panelResponse>;
export type Judgment = z.infer<typeof judgment>;
export type FinalAnswer = z.infer<typeof finalAnswer>;
export type Plan = z.infer<typeof plan>;
export type Implementation = z.infer<typeof implementation>;
export type ReviewVerdict = z.infer<typeof reviewVerdict>;
export type Fix = z.infer<typeof fix>;
export type SessionState = z.infer<typeof sessionState>;
