export function planPrompt(task: string): string {
  return [
    "Create an implementation plan for this task.",
    `Task: ${task}`,
    "",
    "Return JSON with fields steps, risks, and files.",
  ].join("\n");
}
