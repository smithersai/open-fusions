import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createCli } from "../../src/cli";
import { SmithersFusionsEngine } from "../../src/engine";
import type { FuseResult } from "../../src/fusion";
import type { Judgment } from "../../src/schemas";
import type { AgentLike } from "../../src/types";

function makeStubAgentFor(): () => AgentLike {
  let reviewCount = 0;
  const cannedFor = (schema: unknown): unknown => {
    const verdict = {
      lgtm: reviewCount > 0,
      summary: reviewCount > 0 ? "looks good" : "needs work",
      issues: reviewCount > 0 ? [] : [{ severity: "high", description: "handle the edge case" }],
    };
    const candidates: unknown[] = [
      { steps: [{ title: "step one", detail: "do the thing" }], risks: ["risky"], files: ["a.ts"] },
      { summary: "implemented", changes: [{ file: "a.ts", description: "added thing" }] },
      verdict,
      { model: "stub", answer: "an answer", confidence: "high" },
      {
        consensus: ["c"],
        contradictions: [],
        uniqueInsights: [],
        blindSpots: [],
        recommendation: "rec",
        confidence: "high",
      },
      { answer: "final", caveats: [] },
    ];
    const parse = (schema as { safeParse?: (v: unknown) => { success: boolean } } | undefined)?.safeParse;
    for (const candidate of candidates) {
      if (parse?.(candidate)?.success) {
        if (candidate === verdict) reviewCount += 1;
        return candidate;
      }
    }
    return {};
  };
  const agent = {
    supportsNativeStructuredOutput: true,
    async generate(args?: unknown) {
      const outputSchema = (args as { outputSchema?: unknown } | undefined)?.outputSchema;
      return { output: cannedFor(outputSchema) };
    },
  };
  return (): AgentLike => agent;
}

const judged: Judgment = {
  consensus: ["c"],
  contradictions: [],
  uniqueInsights: [],
  blindSpots: [],
  recommendation: "rec",
  confidence: "high",
};

const fuseRaw = async (): Promise<FuseResult> => ({
  answer: "final",
  judgment: judged,
  panel: [],
  status: "finished",
});

const dir = `/tmp/of-cli-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("durable cli drives the full start→implement→review→fix→review→done loop", async () => {
  const engine = new SmithersFusionsEngine({ dir, agentFor: makeStubAgentFor() });
  const cli = createCli({ engine, fuseRaw });
  const run = runner(cli);

  const started = await run(["plan", "task", "--panel", "m/a,m/b", "--judge", "m/j"]);
  expect(started.session).toBeString();
  expect(started.phase).toBe("plan");
  expect(started.plan.steps[0].title).toBe("step one");
  expect(started.cta.commands[0].command).toBe(`smithers-fusions implement --session ${started.session}`);

  const implemented = await run(["implement", "--session", started.session]);
  expect(implemented.phase).toBe("implement");
  expect(implemented.implementation.summary).toBe("implemented");
  expect(implemented.cta.commands[0].command).toBe(`smithers-fusions review --session ${started.session}`);

  const reviewed = await run(["review", "--session", started.session]);
  expect(reviewed.phase).toBe("review");
  expect(reviewed.lgtm).toBe(false);
  expect(reviewed.cta.commands[0].command).toBe(`smithers-fusions fix --session ${started.session}`);

  const fixed = await run(["fix", "--session", started.session]);
  expect(fixed.phase).toBe("fix");
  expect(fixed.fix.summary).toBe("implemented");
  expect(fixed.cta.commands[0].command).toBe(`smithers-fusions review --session ${started.session}`);

  const approved = await run(["review", "--session", started.session]);
  expect(approved.phase).toBe("done");
  expect(approved.lgtm).toBe(true);
  expect(approved.cta.commands[0].command).toBe(`smithers-fusions result --session ${started.session}`);

  const status = await run(["status", "--session", started.session]);
  expect(status).toMatchObject({
    session: started.session,
    phase: "done",
    iteration: 1,
    lgtm: true,
    pendingGate: null,
  });

  const result = await run(["result", "--session", started.session]);
  expect(result.session).toBe(started.session);
  expect(result.phase).toBe("done");
  expect(result.output.lgtm).toBe(true);

  const fused = await run(["fuse", "q"]);
  expect(fused.answer).toBe("final");
  expect(fused.judgment).toEqual(judged);
  expect(fused.panel).toEqual([]);
}, 60_000);

test("durable cli reports missing sessions and wrong phases", async () => {
  const engine = new SmithersFusionsEngine({ dir: `${dir}-errors`, agentFor: makeStubAgentFor() });
  const cli = createCli({ engine, fuseRaw });
  const run = runner(cli);

  const missing = await run(["implement", "--session", "bogus"]);
  expect(missing.code).toBe("SESSION_NOT_FOUND");

  const started = await run(["plan", "task", "--session", "wrong-phase"]);
  const wrong = await run(["review", "--session", started.session]);
  expect(wrong.code).toBe("WRONG_PHASE");
}, 60_000);

function runner(cli: ReturnType<typeof createCli>) {
  return async (argv: string[]) => {
    let out = "";
    await cli.serve([...argv, "--json"], {
      stdout: (s) => {
        out += s;
      },
      exit: () => {},
      env: {},
    });
    return JSON.parse(out);
  };
}
