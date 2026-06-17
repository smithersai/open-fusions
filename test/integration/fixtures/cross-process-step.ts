// A single durable-engine action, run as its OWN OS process. The cross-process
// durability test (../cross-process.test.ts) spawns this once per step so each
// step truly resumes the run in a fresh process with no shared memory — the
// honest test of "rebuilt identically on every process, survives restarts".
//
// Usage: bun run cross-process-step.ts <start|advance|state> <dir> <runId>
import { SmithersFusionsEngine } from "../../../src/engine";
import type { AgentLike } from "../../../src/types";

// Stateless stub: review ALWAYS returns lgtm, so the loop is
// plan→implement→review→done with no in-process counter to carry across
// processes (which is exactly what the old test cheated with).
function stubAgentFor(): () => AgentLike {
  const cannedFor = (schema: unknown): unknown => {
    const candidates: unknown[] = [
      { steps: [{ title: "s", detail: "d" }], risks: [], files: ["a.ts"] },
      { summary: "implemented", changes: [{ file: "a.ts", description: "x" }] },
      { lgtm: true, summary: "looks good", issues: [] },
      { model: "stub", answer: "a", confidence: "high" },
      { consensus: ["c"], contradictions: [], uniqueInsights: [], blindSpots: [], recommendation: "r", confidence: "high" },
      { answer: "final", caveats: [] },
    ];
    const parse = (schema as { safeParse?: (v: unknown) => { success: boolean } } | undefined)?.safeParse;
    for (const c of candidates) if (parse?.(c)?.success) return c;
    return {};
  };
  const agent = {
    supportsNativeStructuredOutput: true,
    async generate(args?: unknown) {
      return { output: cannedFor((args as { outputSchema?: unknown } | undefined)?.outputSchema) };
    },
  };
  return () => agent as AgentLike;
}

const [action, dir, runId] = process.argv.slice(2);
const engine = new SmithersFusionsEngine({ dir, agentFor: stubAgentFor() });

const st =
  action === "start"
    ? await engine.start("task", { panel: ["a", "b"], judge: "j" }, runId!)
    : action === "advance"
      ? await engine.advance(runId!)
      : await engine.state(runId!);

// Sentinel-wrapped so the parent can extract it past any smithers log noise.
// Force exit once flushed: the durable engine leaves an open SQLite handle that
// would otherwise keep this process alive (a normal CLI invocation exits via
// incur). Flushing in the callback avoids truncating the piped output.
process.stdout.write(
  `__OF__${JSON.stringify({ phase: st.phase, pendingGate: st.pendingGate, lgtm: st.lgtm })}__OF__\n`,
  () => process.exit(0),
);
