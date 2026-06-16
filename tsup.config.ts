import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  // smithers + incur are heavy native/runtime deps; keep them external.
  external: ["smithers-orchestrator", "incur", "effect", "bun:sqlite"],
});
