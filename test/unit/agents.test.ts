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
});
