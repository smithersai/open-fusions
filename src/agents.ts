import { AnthropicAgent, OpenAIAgent } from "smithers-orchestrator";
import type { AgentLike, FusionConfig, ModelSpec, NormalizedModelSpec, PanelMember } from "./types";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function resolveModelSpec(spec: ModelSpec): NormalizedModelSpec {
  // A string spec is an OpenRouter model id ("vendor/model") and always routes
  // through OpenRouter. Native providers are opt-in via an explicit object `provider`.
  if (typeof spec === "string") {
    return { id: spec, provider: "openrouter" };
  }

  return {
    ...spec,
    provider: spec.provider ?? "openrouter",
  };
}

export function resolveAgent(spec: ModelSpec): AgentLike {
  const normalized = resolveModelSpec(spec);

  if (normalized.provider === "anthropic") {
    return new AnthropicAgent({
      model: nativeModelId(normalized.id),
      instructions: normalized.instructions,
    }) as AgentLike;
  }

  if (normalized.provider === "openai") {
    return new OpenAIAgent({
      model: nativeModelId(normalized.id),
      apiKey: normalized.apiKey ?? process.env.OPENAI_API_KEY,
      instructions: normalized.instructions,
      nativeStructuredOutput: false,
    }) as AgentLike;
  }

  // "openrouter" (default) and "google" route through OpenRouter's OpenAI-compatible
  // endpoint, so a single OPENROUTER_API_KEY reaches the whole model catalog.
  return new OpenAIAgent({
    model: normalized.id,
    baseURL: normalized.baseURL ?? OPENROUTER_BASE_URL,
    apiKey: normalized.apiKey ?? process.env.OPENROUTER_API_KEY,
    instructions: normalized.instructions,
    nativeStructuredOutput: false,
  }) as AgentLike;
}

export function buildPanel(config: FusionConfig): PanelMember[] {
  const counts = new Map<string, number>();

  return config.panel.map((spec) => {
    const normalized = resolveModelSpec(spec);
    const seen = counts.get(normalized.id) ?? 0;
    const nextCount = seen + 1;
    counts.set(normalized.id, nextCount);

    return {
      id: nextCount === 1 ? normalized.id : `${normalized.id}#${nextCount}`,
      spec,
      agent: resolveAgent(spec),
    };
  });
}

export function defaultPanel(): ModelSpec[] {
  return ["openai/gpt-4.1-mini", "anthropic/claude-3-5-sonnet", "google/gemini-2.5-pro"];
}

export function defaultJudge(): ModelSpec {
  return "openai/gpt-4.1";
}

// For native providers, accept either a bare model id ("claude-3-5-sonnet-20241022")
// or an OpenRouter-style "vendor/model" id, stripping the vendor prefix.
function nativeModelId(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}
