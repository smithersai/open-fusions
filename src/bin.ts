#!/usr/bin/env bun
import cli from "./cli";

// incur decides human- vs machine-formatted output from `process.stdout.isTTY`
// and does NOT let an explicit `--json` override it: in a real terminal `--json`
// would otherwise emit human text (or truncated JSON), breaking any agent or
// script that captures the output. When a machine format is explicitly asked
// for, drop the TTY flag so incur emits clean JSON wherever it runs.
const argv = process.argv.slice(2);
const wantsJson =
  argv.includes("--json") ||
  argv.includes("--format=json") ||
  argv.some((a, i) => a === "--format" && argv[i + 1] === "json");
if (wantsJson) {
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
}

cli.serve();
