import type { Plan, ReviewVerdict } from "../schemas";

export function fixPrompt(task: string, plan: Plan, context: string, issues: ReviewVerdict["issues"]): string {
  return [
    "Fix the reviewed issues. Target the existing implementation described below — do not start over.",
    `Task: ${task}`,
    "",
    "Plan:",
    JSON.stringify(plan, null, 2),
    "",
    "Changes so far (implementation + any prior fixes):",
    context,
    "",
    "Issues to fix:",
    JSON.stringify(issues, null, 2),
    "",
    "Return JSON with fields summary and changes.",
  ].join("\n");
}
