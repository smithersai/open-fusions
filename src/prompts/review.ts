import type { Plan } from "../schemas";

export function reviewPrompt(task: string, plan: Plan, context: string): string {
  return [
    "Review the changes below against the task and plan.",
    `Task: ${task}`,
    "",
    "Plan:",
    JSON.stringify(plan, null, 2),
    "",
    "Changes under review (implementation summary + any prior fixes):",
    context,
    "",
    "Return JSON with fields lgtm, summary, and issues.",
  ].join("\n");
}
