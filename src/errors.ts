/**
 * Raised when a fusion run completes but its output can't be turned into a
 * valid result — no synthesized row, or a synthesizer output that doesn't match
 * the requested schema even after recovery. Carries the original cause.
 */
export class FusionError extends Error {
  override readonly name = "FusionError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Raised when no model can be resolved — an empty panel, or no registered
 * smithers accounts and no explicit model id.
 */
export class NoModelsError extends Error {
  override readonly name = "NoModelsError";
  constructor(message: string) {
    super(message);
  }
}
