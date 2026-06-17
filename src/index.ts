// Public API surface. This is an explicit allowlist — internal helpers
// (raw SQLite readers, the pipeline builder, the pure state deriver, prompt
// builders) are intentionally NOT re-exported so they don't become a frozen
// part of the published contract. Import them from their module if you need
// them for testing.

// --- Programmatic fusion ---
export { fuse, fuseWith, runFusion, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from "./fusion";
export type {
  FuseInput,
  FuseResult,
  FuseWithInput,
  FuseWithResult,
  RunStatus,
  ReliabilityOptions,
} from "./fusion";

// --- Durable plan→implement→review→fix engine ---
export { SmithersFusionsEngine, isTerminalPhase } from "./engine";
export type { EngineState, EngineOptions, RunConfig, EnginePhase } from "./engine";
export { MAX_REVIEW_ITERATIONS } from "./pipeline";
export type { AgentFor, PhaseRole } from "./pipeline";

// --- Model/agent resolution ---
export {
  resolveAgent,
  resolveModelSpec,
  buildPanel,
  defaultPanel,
  defaultJudge,
  createAgentFromAccount,
  isAgentLike,
} from "./agents";

// --- Schema-coercion utilities for loosely-structured model output ---
export { coerceToSchema, safeCoerce } from "./coerce";

// --- Schemas + inferred types ---
export { panelResponse, judgment, finalAnswer, plan, implementation, reviewVerdict, fix } from "./schemas";
export type { PanelResponse, Judgment, Plan, Implementation, ReviewVerdict, Fix } from "./schemas";

// --- Errors ---
export { FusionError, NoModelsError } from "./errors";

// --- Shared types ---
export type {
  ModelSpec,
  ModelSpecObject,
  NormalizedModelSpec,
  ModelProvider,
  AgentLike,
  PanelMember,
  FusionConfig,
  FusionResult,
} from "./types";
