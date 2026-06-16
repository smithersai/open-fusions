import { z } from "zod";

const confidence = z.enum(["low", "medium", "high"]);
/** Review-issue severity — distinct from `confidence`, and includes `critical`
 *  so a reviewer can flag a blocking defect separately from a minor one. */
const issueSeverity = z.enum(["low", "medium", "high", "critical"]);
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
      severity: issueSeverity,
      file: z.string().optional(),
      description: z.string(),
    }),
  ),
});

export const fix = z.object({
  summary: z.string(),
  changes: z.array(change),
});

export type PanelResponse = z.infer<typeof panelResponse>;
export type Judgment = z.infer<typeof judgment>;
export type Plan = z.infer<typeof plan>;
export type Implementation = z.infer<typeof implementation>;
export type ReviewVerdict = z.infer<typeof reviewVerdict>;
export type Fix = z.infer<typeof fix>;
