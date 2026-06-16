import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsFilePath } from "@smithers-orchestrator/accounts";
import {
  buildPanel,
  createAgentFromAccount,
  defaultJudge,
  defaultPanel,
  isAgentLike,
  resolveAgent,
  resolveModelSpec,
} from "../../src/agents";
import type { AgentLike } from "../../src/types";

// A throwaway home with three registered subscription accounts (no API keys).
// Honored by the smithers accounts API via SMITHERS_HOME, so the registry-driven
// defaults are exercised hermetically — no network, no real ~/.smithers.
const home = mkdtempSync(join(tmpdir(), "of-accounts-"));
const env: NodeJS.ProcessEnv = { SMITHERS_HOME: home };
const emptyHome = mkdtempSync(join(tmpdir(), "of-empty-"));
const emptyEnv: NodeJS.ProcessEnv = { SMITHERS_HOME: emptyHome };

beforeAll(() => {
  writeFileSync(
    accountsFilePath(env),
    JSON.stringify({
      version: 1,
      accounts: [
        { label: "codex-1", provider: "codex", configDir: join(home, ".codex"), model: "gpt-5.3-codex" },
        { label: "gemini-1", provider: "gemini", configDir: join(home, ".gemini"), model: "gemini-3.1-pro-preview" },
        { label: "claude-1", provider: "claude-code", configDir: join(home, ".claude"), model: "claude-opus-4-8" },
      ],
    }),
  );
  writeFileSync(accountsFilePath(emptyEnv), JSON.stringify({ version: 1, accounts: [] }));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
});

const stub = { async generate() { return { output: {} }; } };

describe("isAgentLike", () => {
  test("recognizes objects with a generate() method", () => {
    expect(isAgentLike(stub)).toBe(true);
    expect(isAgentLike("codex")).toBe(false);
    expect(isAgentLike({ provider: "codex" })).toBe(false);
  });
});

describe("resolveModelSpec", () => {
  test("accepts the honest smithers AgentLike shape", () => {
    const agent: AgentLike = {
      id: "agent-id",
      model: "model-id",
      async generate() {
        return "raw smithers output";
      },
    };

    expect(resolveModelSpec(agent)).toEqual({ id: "agent-id" });
  });

  test("parses bare provider keywords", () => {
    expect(resolveModelSpec("claude-code")).toMatchObject({ id: "claude-code", provider: "claude-code" });
    expect(resolveModelSpec("codex")).toMatchObject({ provider: "codex" });
  });

  test("parses <provider>:<model>", () => {
    expect(resolveModelSpec("codex:gpt-5.5")).toMatchObject({ provider: "codex", model: "gpt-5.5" });
    // OpenRouter model ids contain a slash; only the first colon separates provider.
    expect(resolveModelSpec("openrouter:anthropic/claude-opus-4.8")).toMatchObject({
      provider: "openrouter",
      model: "anthropic/claude-opus-4.8",
    });
  });

  test("normalizes the openai-compatible alias", () => {
    expect(resolveModelSpec("compat:llama3")).toMatchObject({ provider: "openai-compatible", model: "llama3" });
  });

  test("treats an unknown bare token as an account label, not a provider", () => {
    const spec = resolveModelSpec("codex-1");
    expect(spec.id).toBe("codex-1");
    expect(spec.account).toBe("codex-1");
    expect(spec.provider).toBeUndefined();
  });

  test("preserves explicit object specs", () => {
    expect(
      resolveModelSpec({ id: "x", provider: "openai", model: "gpt-5", baseURL: "http://localhost:11434/v1", apiKey: "k" }),
    ).toMatchObject({ provider: "openai", model: "gpt-5", baseURL: "http://localhost:11434/v1", apiKey: "k" });
  });
});

describe("resolveAgent", () => {
  test("passes a smithers AgentLike straight through", () => {
    expect(resolveAgent(stub)).toBe(stub);
  });

  test("resolves a registered account label to a subscription agent", () => {
    const agent = resolveAgent("codex-1", env);
    expect(typeof agent.generate).toBe("function");
  });

  test("resolves a bare subscription provider (no account needed)", () => {
    expect(typeof resolveAgent("claude-code", env).generate).toBe("function");
  });

  test("resolves an OpenRouter spec via the OpenAI-compatible endpoint", () => {
    const agent = resolveAgent("openrouter:anthropic/claude-opus-4.8", { ...env, OPENROUTER_API_KEY: "sk-or-test" });
    expect(typeof agent.generate).toBe("function");
  });

  test("resolves a generic OpenAI-compatible endpoint", () => {
    const agent = resolveAgent("compat:llama3", {
      ...env,
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      OPENAI_API_KEY: "x",
    });
    expect(typeof agent.generate).toBe("function");
  });

  test("errors on an unknown id, pointing to `smithers agents add`", () => {
    expect(() => resolveAgent("totally-unknown-xyz", env)).toThrow(/smithers agents add/);
  });
});

describe("createAgentFromAccount", () => {
  test("builds a subscription agent carrying the account's configDir", () => {
    const agent = createAgentFromAccount({
      label: "codex-1",
      provider: "codex",
      configDir: join(home, ".codex"),
      model: "gpt-5.3-codex",
    });
    expect(typeof agent.generate).toBe("function");
  });
});

describe("registry-driven defaults", () => {
  test("defaultPanel lists the registered subscription accounts", () => {
    expect(defaultPanel(env)).toEqual(["codex-1", "gemini-1", "claude-1"]);
  });

  test("defaultJudge prefers a claude-code account", () => {
    expect(defaultJudge(env)).toBe("claude-1");
  });

  test("defaultPanel errors (with a register hint) when no accounts exist", () => {
    expect(() => defaultPanel(emptyEnv)).toThrow(/smithers agents add/);
  });
});

describe("buildPanel", () => {
  test("produces distinct ids for duplicate specs", () => {
    const panel = buildPanel({ panel: ["codex-1", "codex-1", "gemini-1"], env });
    expect(panel.map((m) => m.id)).toEqual(["codex-1", "codex-1#2", "gemini-1"]);
    expect(panel.every((m) => typeof m.agent.generate === "function")).toBe(true);
  });

  test("threads an AgentLike spec straight through as a panel member", () => {
    const panel = buildPanel({ panel: [stub], env });
    expect(panel[0]!.agent).toBe(stub);
  });
});

describe("resolveAgent error branches", () => {
  test("openrouter/compat without a model are rejected with a helpful message", () => {
    expect(() => resolveAgent("openrouter", env)).toThrow(/needs a model/);
    expect(() => resolveAgent("compat", env)).toThrow(/needs a model/);
  });

  test("compat without a base URL is rejected", () => {
    expect(() => resolveAgent("compat:llama3", env)).toThrow(/base URL|OPENAI_BASE_URL/);
  });

  test("native openai/anthropic specs resolve to agents", () => {
    expect(typeof resolveAgent("openai:gpt-5.5", { ...env, OPENAI_API_KEY: "k" }).generate).toBe("function");
    expect(typeof resolveAgent("anthropic:claude-opus-4-8", env).generate).toBe("function");
  });

  test("bare native provider without a model is rejected (no garbage model id)", () => {
    // "anthropic"/"openai" alone has no model; we must NOT silently build an
    // agent whose model is the literal string "anthropic"/"openai" (which only
    // 400s later at generate time). Mirror openrouter/compat's eager rejection.
    expect(() => resolveAgent("anthropic", env)).toThrow(/needs a model/);
    expect(() => resolveAgent("openai", { ...env, OPENAI_API_KEY: "k" })).toThrow(/needs a model/);
  });

  test("an explicit object spec with provider + baseURL resolves", () => {
    const agent = resolveAgent({ provider: "openai-compatible", model: "llama3", baseURL: "http://localhost:11434/v1", apiKey: "x" });
    expect(typeof agent.generate).toBe("function");
  });

  test("an object spec with an unrecognized provider errors helpfully", () => {
    // The object-spec API takes a free-form provider; a value outside the known
    // set must fail with the register hint, not crash deep in a constructor.
    expect(() =>
      resolveAgent({ provider: "totally-bogus" as never, model: "x" }, env),
    ).toThrow(/Unknown model|smithers agents add/);
  });

  test("a bare subscription provider with no registered account spawns the default-config CLI", () => {
    // The fixture registers codex/gemini/claude-code but no kimi — so "kimi"
    // takes the no-account branch and builds the CLI in its default config dir.
    expect(typeof resolveAgent("kimi", env).generate).toBe("function");
    // With no accounts at all, "codex" still resolves — and exercises the
    // codex-only skipGitRepoCheck branch on the no-account path.
    expect(typeof resolveAgent("codex", emptyEnv).generate).toBe("function");
  });
});

describe("resolveModelSpec account/object id forms", () => {
  test("<account>:<model> where the head is not a provider keyword", () => {
    // "myaccount" is not a PROVIDER_KEYWORD, so it's read as an account label
    // with a model override.
    expect(resolveModelSpec("myaccount:opus")).toMatchObject({
      id: "myaccount:opus",
      account: "myaccount",
      model: "opus",
    });
  });

  test("objectId derives an id from provider/model when no explicit id is given", () => {
    expect(resolveModelSpec({ provider: "openai" }).id).toBe("openai");
    expect(resolveModelSpec({ model: "x" }).id).toBe("x");
    expect(resolveModelSpec({}).id).toBe("model");
  });
});

describe("createAgentFromAccount", () => {
  test("rejects an unsupported provider", () => {
    // @ts-expect-error — deliberately invalid provider to exercise the guard.
    expect(() => createAgentFromAccount({ label: "x", provider: "made-up" })).toThrow(/Unsupported account provider/);
  });

  test("builds an api-key (anthropic-api) account agent", () => {
    const agent = createAgentFromAccount({ label: "a", provider: "anthropic-api", apiKey: "sk-test", model: "claude-opus-4-8" });
    expect(typeof agent.generate).toBe("function");
  });
});

describe("defaultJudge fallback chain", () => {
  test("falls back to the first available provider when no claude-code account exists", () => {
    // Fixture has codex/gemini/claude — claude-code wins (covered above). Here,
    // with only a kimi account, defaultJudge falls all the way through to it.
    const home = mkdtempSync(join(tmpdir(), "of-kimi-"));
    const kimiEnv = { SMITHERS_HOME: home };
    writeFileSync(
      accountsFilePath(kimiEnv),
      JSON.stringify({ version: 1, accounts: [{ label: "kimi-only", provider: "kimi", configDir: join(home, ".k") }] }),
    );
    try {
      expect(defaultJudge(kimiEnv)).toBe("kimi-only");
      expect(defaultPanel(kimiEnv)).toEqual(["kimi-only"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
