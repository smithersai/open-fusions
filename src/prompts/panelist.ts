export function panelistPrompt(question: string, role?: string): string {
  const roleLine = role ? `Role: ${role}` : "Role: independent expert panelist";

  return [
    roleLine,
    "Answer the question directly. Include the reasoning that matters and avoid unsupported claims.",
    "",
    `Question: ${question}`,
  ].join("\n");
}
