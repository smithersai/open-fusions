import type { Judgment, PanelResponse } from "./schemas";

export type Phase = "plan" | "implement" | "review" | "fix";

export type ModelProvider = "openrouter" | "anthropic" | "openai" | "google";

export type ModelSpec =
  | string
  | {
      id: string;
      provider?: ModelProvider;
      baseURL?: string;
      apiKey?: string;
      instructions?: string;
    };

export type NormalizedModelSpec = {
  id: string;
  provider: ModelProvider;
  baseURL?: string;
  apiKey?: string;
  instructions?: string;
};

export type AgentLike = {
  generate(args?: unknown): Promise<{ output: unknown }>;
};

export type PanelMember = {
  id: string;
  spec: ModelSpec;
  agent: AgentLike;
};

export type FusionConfig = {
  panel: ModelSpec[];
  judge?: ModelSpec;
  synthesizer?: ModelSpec;
};

export type FusionResult = {
  answer: string;
  judgment: Judgment;
  panel: PanelResponse[];
};
