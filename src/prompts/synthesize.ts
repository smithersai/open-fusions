import type { Judgment, PanelResponse } from "../schemas";

export function synthesizePrompt(question: string, judgment: Judgment, responses: PanelResponse[]): string {
  return [
    "Synthesize the judged panel into one final answer.",
    `Question: ${question}`,
    "",
    "Judgment:",
    JSON.stringify(judgment, null, 2),
    "",
    "Panel responses:",
    ...responses.map((response, index) =>
      [`${index + 1}. Model: ${response.model}`, `Answer: ${response.answer}`].join("\n"),
    ),
    "",
    "Return JSON with fields answer and caveats.",
  ].join("\n");
}
