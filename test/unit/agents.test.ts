import { describe, expect, test } from "bun:test";
import {
  buildPanel,
  defaultJudge,
  defaultPanel,
  resolveAgent,
  resolveModelSpec,
} from "../../src/agents";

describe("agents", () => {
  test("resolveModelSpec routes string specs through OpenRouter", () => {
    // A "vendor/model" string is an OpenRouter model id, so it routes via OpenRouter
    // regardless of the vendor prefix. Native providers are opt-in (see next test).
    for (const id of [
      "anthropic/claude-3-5-sonnet",
      "openai/gpt-4.1",
      "google/gemini-2.5-pro",
      "meta-llama/llama-3.1-70b",
    ]) {
      expect(resolveModelSpec(id)).toEqual({ id, provider: "openrouter" });
    }
  });

  test("resolveModelSpec honors an explicit native provider", () => {
    expect(resolveModelSpec({ id: "claude-3-5-sonnet-20241022", provider: "anthropic" })).toMatchObject({
      id: "claude-3-5-sonnet-20241022",
      provider: "anthropic",
    });
  });

  test("resolveModelSpec preserves object overrides", () => {
    expect(
      resolveModelSpec({
        id: "custom/model",
        provider: "openai",
        baseURL: "http://localhost:11434/v1",
        apiKey: "test-key",
        instructions: "Be terse",
      }),
    ).toEqual({
      id: "custom/model",
      provider: "openai",
      baseURL: "http://localhost:11434/v1",
      apiKey: "test-key",
      instructions: "Be terse",
    });
  });

  test("resolveAgent constructs an AgentLike without network I/O", () => {
    const agent = resolveAgent({
      id: "openai/gpt-4.1",
      provider: "openai",
      apiKey: "unit-test-key",
      instructions: "Return JSON.",
    });

    expect(agent).toBeObject();
    expect(agent.generate).toBeFunction();
  });

  test("buildPanel produces distinct ids for duplicate models", () => {
    const panel = buildPanel({
      panel: ["openai/gpt-4.1", "openai/gpt-4.1", "anthropic/claude-3-5-sonnet"],
    });

    expect(panel.map((member) => member.id)).toEqual([
      "openai/gpt-4.1",
      "openai/gpt-4.1#2",
      "anthropic/claude-3-5-sonnet",
    ]);
    expect(panel.every((member) => typeof member.agent.generate === "function")).toBe(true);
  });

  test("defaultPanel and defaultJudge are non-empty OpenRouter model specs", () => {
    expect(defaultPanel().length).toBeGreaterThan(0);
    expect(defaultPanel().every((spec) => typeof spec === "string" && spec.includes("/"))).toBe(true);
    expect(defaultJudge()).toSatisfy((spec) => typeof spec === "string" && spec.includes("/"));
  });
});
