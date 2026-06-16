import type { ReviewVerdict } from "../schemas";

export function fixPrompt(task: string, issues: ReviewVerdict["issues"]): string {
  return [
    "Fix the reviewed issues for this task.",
    `Task: ${task}`,
    "",
    "Issues:",
    JSON.stringify(issues, null, 2),
    "",
    "Return JSON with fields summary and changes.",
  ].join("\n");
}
