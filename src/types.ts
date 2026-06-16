import type { Judgment, PanelResponse } from "./schemas";

/**
 * Where a model comes from. open-fusions runs on your own smithers agents:
 * - Subscription harnesses (no API key) — the local CLIs you're logged into,
 *   resolved through the `smithers agents` account registry.
 * - `anthropic` / `openai` — native provider SDKs, billed against an API key.
 * - `openrouter` — opt-in convenience that routes through OpenRouter's
 *   OpenAI-compatible endpoint (`OPENROUTER_API_KEY`).
 * - `openai-compatible` — any OpenAI-compatible endpoint (Ollama, vLLM, a
 *   self-hosted gateway, …) via an explicit `baseURL` + key.
 */
export type ModelProvider =
  | "claude-code"
  | "codex"
  | "gemini"
  | "kimi"
  | "antigravity"
  | "anthropic"
  | "openai"
  | "openrouter"
  | "openai-compatible";

/**
 * A model in a fusion. Three forms:
 * - An `AgentLike` — any smithers agent instance you constructed yourself
 *   (`new ClaudeCodeAgent(...)`, `new OpenAIAgent({ baseURL, apiKey })`, …).
 *   Programmatic use only; it can't be persisted through the durable engine.
 * - A `string` — a CLI/ergonomic spec: a registered account label
 *   (`"codex-1"`), a provider (`"claude-code"`), or `"<provider>:<model>"`
 *   (`"codex:gpt-5.5"`, `"openrouter:anthropic/claude-opus-4.8"`).
 * - An object spec for explicit, programmatic control.
 */
export type ModelSpec = AgentLike | string | ModelSpecObject;

export type ModelSpecObject = {
  id?: string;
  /** A registered account label to resolve through the smithers registry. */
  account?: string;
  provider?: ModelProvider;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  /** Per-account CLI config dir for subscription providers. */
  configDir?: string;
  /**
   * System instructions. Only honored for the native SDK providers
   * (`anthropic`/`openai`/`openrouter`/`openai-compatible`); subscription
   * harnesses and registered accounts run their own CLI and ignore it.
   */
  instructions?: string;
};

export type NormalizedModelSpec = {
  /** Stable display id (the original string, or `provider:model`, or label). */
  id: string;
  /** A registered account label, when the spec names one. */
  account?: string;
  provider?: ModelProvider;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  configDir?: string;
  instructions?: string;
};

export type AgentLike = {
  generate(args?: unknown): Promise<unknown>;
  id?: string;
  model?: string;
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
  /** Environment used to resolve subscription accounts. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

export type FusionResult = {
  answer: string;
  judgment: Judgment;
  panel: PanelResponse[];
};
