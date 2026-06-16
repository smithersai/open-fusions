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
    "Return ONLY a single JSON object with exactly two top-level fields:",
    '- "answer": a plain prose string (the final answer itself, NOT JSON).',
    '- "caveats": an array of plain strings.',
    "Do not nest, escape, or stringify the JSON, and do not wrap it inside another field.",
  ].join("\n");
}
