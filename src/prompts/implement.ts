import type { Plan } from "../schemas";

export function implementPrompt(task: string, plan: Plan): string {
  return [
    "Implement the task according to the approved plan.",
    `Task: ${task}`,
    "",
    "Plan:",
    JSON.stringify(plan, null, 2),
    "",
    "Return JSON with fields summary and changes.",
  ].join("\n");
}
