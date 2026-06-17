import { setDefaultTimeout } from "bun:test";

// Smithers-backed tests drive a real durable workflow (Effect runtime + bun:sqlite
// + task scheduling) per fusion. That work is fast in isolation (~250ms) but is
// heavyweight enough that, under CPU contention — e.g. `bun test` running right
// after a `tsup` build in `release`, or a loaded CI box — a single fusion can
// blow past Bun's 5s default per-test timeout and fail spuriously. The integration
// tests that already pass an explicit timeout never flake; the ones on the default
// do. Raise the default well above any real run so load spikes don't cause false
// failures, while still catching a genuine hang (which would exceed 30s).
setDefaultTimeout(30_000);
