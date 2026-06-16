import { describe, expect, test } from "bun:test";
import * as openFusions from "../../src/index";

const api = openFusions as Record<string, unknown>;

describe("public api barrel", () => {
  test("re-exports the documented function surface", () => {
    for (const name of [
      "fuse",
      "fuseWith",
      "runFusion",
      "OpenFusionsEngine",
      "isTerminalPhase",
      "resolveAgent",
      "resolveModelSpec",
      "buildPanel",
      "defaultPanel",
      "defaultJudge",
      "createAgentFromAccount",
      "isAgentLike",
      "coerceToSchema",
      "safeCoerce",
      "FusionError",
      "NoModelsError",
    ]) {
      expect(typeof api[name]).toBe("function");
    }
  });

  test("re-exports the numeric reliability constants", () => {
    for (const name of ["DEFAULT_RETRIES", "DEFAULT_TIMEOUT_MS", "MAX_REVIEW_ITERATIONS"]) {
      expect(typeof api[name]).toBe("number");
    }
  });

  test("re-exports the zod schemas (each has safeParse)", () => {
    for (const name of ["panelResponse", "judgment", "finalAnswer", "plan", "implementation", "reviewVerdict", "fix"]) {
      expect(typeof (api[name] as { safeParse?: unknown } | undefined)?.safeParse).toBe("function");
    }
  });

  test("does NOT leak internal helpers into the frozen public surface", () => {
    for (const name of [
      "tableNameFor",
      "readOutputs",
      "readLatest",
      "buildPipeline",
      "pipelineSchemas",
      "deriveStateFromOutputs",
      "schemaFailFastAgent",
      "composeReviewContext",
      "panelistPrompt",
      "synthesizePrompt",
    ]) {
      expect(api[name]).toBeUndefined();
    }
  });
});
