import type { Plan } from "../schemas";

export function reviewPrompt(task: string, plan: Plan, diff: string): string {
  return [
    "Review the implementation diff against the task and plan.",
    `Task: ${task}`,
    "",
    "Plan:",
    JSON.stringify(plan, null, 2),
    "",
    "Diff:",
    diff,
    "",
    "Return JSON with fields lgtm, summary, and issues.",
  ].join("\n");
}
