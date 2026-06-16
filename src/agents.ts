import {
  AnthropicAgent,
  AntigravityAgent,
  ClaudeCodeAgent,
  CodexAgent,
  GeminiAgent,
  KimiAgent,
  OpenAIAgent,
} from "smithers-orchestrator";
import {
  getAccount,
  listAccounts,
  SUBSCRIPTION_PROVIDERS,
  type Account,
  type AccountProvider,
} from "@smithers-orchestrator/accounts";
import type {
  AgentLike,
  FusionConfig,
  ModelProvider,
  ModelSpec,
  ModelSpecObject,
  NormalizedModelSpec,
  PanelMember,
} from "./types";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MAX_DEFAULT_PANEL = 5;

const REGISTER_HINT =
  "open-fusions runs on your own smithers agents. Register a subscription (no API key needed) with " +
  "`smithers agents add` (e.g. claude-code, codex, gemini), or pass an `openrouter:<vendor/model>` / " +
  "`compat:<model>` id.";

type AgentCtor = new (opts: Record<string, unknown>) => AgentLike;

// Subscription harnesses: a model spec that names one of these (by provider or
// by a registered account) spawns the local CLI you're already logged into.
const SUBSCRIPTION_CLASSES: Record<string, AgentCtor> = {
  "claude-code": ClaudeCodeAgent as unknown as AgentCtor,
  codex: CodexAgent as unknown as AgentCtor,
  gemini: GeminiAgent as unknown as AgentCtor,
  kimi: KimiAgent as unknown as AgentCtor,
  antigravity: AntigravityAgent as unknown as AgentCtor,
};

// Every smithers account provider → the agent class that runs it. API-keyed
// providers drive the same harness CLI billed against a key (mirrors smithers).
const ACCOUNT_CLASSES: Record<AccountProvider, AgentCtor> = {
  "claude-code": SUBSCRIPTION_CLASSES["claude-code"],
  antigravity: SUBSCRIPTION_CLASSES.antigravity,
  codex: SUBSCRIPTION_CLASSES.codex,
  gemini: SUBSCRIPTION_CLASSES.gemini,
  kimi: SUBSCRIPTION_CLASSES.kimi,
  "anthropic-api": SUBSCRIPTION_CLASSES["claude-code"],
  "openai-api": SUBSCRIPTION_CLASSES.codex,
  "gemini-api": SUBSCRIPTION_CLASSES.gemini,
};

// Recognized provider tokens in a string spec. Anything else is treated as a
// registered account label. `compat` is an alias for `openai-compatible`.
const PROVIDER_KEYWORDS: Record<string, ModelProvider> = {
  "claude-code": "claude-code",
  codex: "codex",
  gemini: "gemini",
  kimi: "kimi",
  antigravity: "antigravity",
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  "openai-compatible": "openai-compatible",
  compat: "openai-compatible",
};

/** True when a spec is already a constructed smithers agent (programmatic use). */
export function isAgentLike(spec: unknown): spec is AgentLike {
  return typeof spec === "object" && spec !== null && typeof (spec as { generate?: unknown }).generate === "function";
}

/**
 * Normalize a spec for display/dispatch. Pure & syntactic — it does NOT touch
 * the account registry; a bare token that isn't a known provider keyword is
 * treated as an account label (resolved later by `resolveAgent`).
 */
export function resolveModelSpec(spec: ModelSpec): NormalizedModelSpec {
  if (isAgentLike(spec)) return { id: agentId(spec) };
  if (typeof spec === "string") return parseSpecString(spec);
  return {
    id: spec.id ?? objectId(spec),
    account: spec.account,
    provider: spec.provider,
    model: spec.model,
    baseURL: spec.baseURL,
    apiKey: spec.apiKey,
    configDir: spec.configDir,
    instructions: spec.instructions,
  };
}

/**
 * Resolve any spec to a runnable agent. An `AgentLike` passes straight through;
 * a string/object is resolved against the smithers account registry and the
 * provider grammar. `env` defaults to `process.env` so the durable engine can
 * re-resolve persisted string ids on resume.
 */
export function resolveAgent(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): AgentLike {
  if (isAgentLike(spec)) return spec;
  return agentFromNormalized(resolveModelSpec(spec), env);
}

/** Construct a subscription/API agent from a registered smithers account. */
export function createAgentFromAccount(account: Account, opts?: { model?: string }): AgentLike {
  const Ctor = ACCOUNT_CLASSES[account.provider];
  if (!Ctor) throw new Error(`Unsupported account provider: ${account.provider}`);
  const model = opts?.model ?? account.model;
  const o: Record<string, unknown> = { cwd: process.cwd() };
  if (model) o.model = model;
  if (account.configDir) o.configDir = account.configDir;
  if (account.apiKey) o.apiKey = account.apiKey;
  if (account.provider === "codex" || account.provider === "openai-api") o.skipGitRepoCheck = true;
  return new Ctor(o);
}

export function buildPanel(config: FusionConfig): PanelMember[] {
  const counts = new Map<string, number>();
  return config.panel.map((spec) => {
    const baseId = resolveModelSpec(spec).id;
    const n = (counts.get(baseId) ?? 0) + 1;
    counts.set(baseId, n);
    return { id: n === 1 ? baseId : `${baseId}#${n}`, spec, agent: resolveAgent(spec, config.env) };
  });
}

/** Default panel = your registered subscription accounts (then API accounts). */
export function defaultPanel(env: NodeJS.ProcessEnv = process.env): string[] {
  const accounts = listAccounts(env);
  const subs = accounts.filter((a) => SUBSCRIPTION_PROVIDERS.has(a.provider));
  const pool = subs.length > 0 ? subs : accounts;
  if (pool.length === 0) throw noModelsError();
  return pool.slice(0, MAX_DEFAULT_PANEL).map((a) => a.label);
}

/** Default judge = the strongest registered account (prefers claude-code). */
export function defaultJudge(env: NodeJS.ProcessEnv = process.env): string {
  const accounts = listAccounts(env);
  if (accounts.length === 0) throw noModelsError();
  const order: AccountProvider[] = [
    "claude-code",
    "codex",
    "gemini",
    "antigravity",
    "kimi",
    "anthropic-api",
    "openai-api",
    "gemini-api",
  ];
  for (const provider of order) {
    const account = accounts.find((a) => a.provider === provider);
    if (account) return account.label;
  }
  return accounts[0]!.label;
}

function agentFromNormalized(n: NormalizedModelSpec, env: NodeJS.ProcessEnv): AgentLike {
  // 1. A registered account, named by label.
  if (n.account) {
    const account = getAccount(n.account, env);
    if (account) return createAgentFromAccount(account, { model: n.model });
    throw unknownIdError(n.id);
  }

  const provider = n.provider;
  if (!provider) throw unknownIdError(n.id);

  // 2. A subscription harness, named by provider — prefer a registered account
  //    of that provider, else spawn the CLI in its default config dir.
  const SubCtor = SUBSCRIPTION_CLASSES[provider];
  if (SubCtor) {
    const account = listAccounts(env).find((a) => a.provider === provider);
    if (account) return createAgentFromAccount(account, { model: n.model });
    const o: Record<string, unknown> = { cwd: process.cwd() };
    if (n.model) o.model = n.model;
    if (n.configDir) o.configDir = n.configDir;
    if (provider === "codex") o.skipGitRepoCheck = true;
    return new SubCtor(o);
  }

  // 3. Native provider SDKs (billed against an API key).
  if (provider === "anthropic") {
    return new AnthropicAgent({ model: nativeModelId(n.model ?? n.id), instructions: n.instructions }) as unknown as AgentLike;
  }
  if (provider === "openai") {
    return new OpenAIAgent({
      model: nativeModelId(n.model ?? n.id),
      apiKey: n.apiKey ?? env.OPENAI_API_KEY,
      instructions: n.instructions,
      nativeStructuredOutput: false,
    }) as unknown as AgentLike;
  }

  // 4. OpenRouter (opt-in) — its OpenAI-compatible endpoint, one key for the catalog.
  if (provider === "openrouter") {
    if (!n.model) throw needModelError("openrouter");
    return new OpenAIAgent({
      model: n.model,
      baseURL: n.baseURL ?? OPENROUTER_BASE_URL,
      apiKey: n.apiKey ?? env.OPENROUTER_API_KEY,
      instructions: n.instructions,
      nativeStructuredOutput: false,
    }) as unknown as AgentLike;
  }

  // 5. Any OpenAI-compatible endpoint (Ollama, vLLM, a self-hosted gateway).
  if (provider === "openai-compatible") {
    if (!n.model) throw needModelError("compat");
    const baseURL = n.baseURL ?? env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE;
    if (!baseURL) {
      throw new Error(
        `"compat:${n.model}" needs a base URL — set OPENAI_BASE_URL (and OPENAI_API_KEY), or pass baseURL in an object spec.`,
      );
    }
    return new OpenAIAgent({
      model: n.model,
      baseURL,
      apiKey: n.apiKey ?? env.OPENAI_API_KEY ?? "none",
      instructions: n.instructions,
      nativeStructuredOutput: false,
    }) as unknown as AgentLike;
  }

  throw unknownIdError(n.id);
}

function parseSpecString(spec: string): NormalizedModelSpec {
  const colon = spec.indexOf(":");
  if (colon !== -1) {
    const head = spec.slice(0, colon);
    const model = spec.slice(colon + 1);
    const provider = PROVIDER_KEYWORDS[head];
    if (provider) return { id: spec, provider, model };
    // e.g. "myaccount:opus" — a registered account with a model override.
    return { id: spec, account: head, model };
  }
  const provider = PROVIDER_KEYWORDS[spec];
  if (provider) return { id: spec, provider };
  return { id: spec, account: spec };
}

function objectId(spec: ModelSpecObject): string {
  if (spec.account) return spec.account;
  if (spec.provider && spec.model) return `${spec.provider}:${spec.model}`;
  if (spec.provider) return spec.provider;
  return spec.model ?? "model";
}

function agentId(agent: AgentLike): string {
  const a = agent as { id?: unknown; model?: unknown };
  if (typeof a.id === "string") return a.id;
  if (typeof a.model === "string") return a.model;
  return "agent";
}

// Native SDKs want a bare model id; strip a "vendor/" prefix if one was given.
function nativeModelId(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

function unknownIdError(id: string): Error {
  return new Error(`Unknown model "${id}". ${REGISTER_HINT}`);
}

function needModelError(provider: string): Error {
  return new Error(`"${provider}" needs a model, e.g. ${provider}:<model>.`);
}

function noModelsError(): Error {
  return new Error(`No models available. ${REGISTER_HINT}`);
}
