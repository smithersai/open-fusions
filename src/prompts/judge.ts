import type { PanelResponse } from "../schemas";

export function judgePrompt(question: string, responses: PanelResponse[]): string {
  return [
    "You are judging a model fusion panel.",
    `Question: ${question}`,
    "",
    "Panel responses:",
    ...responses.map((response, index) =>
      [`${index + 1}. Model: ${response.model}`, `Answer: ${response.answer}`].join("\n"),
    ),
    "",
    "Return JSON matching this shape exactly:",
    JSON.stringify(
      {
        consensus: ["shared conclusions"],
        contradictions: [{ topic: "topic", positions: ["position one", "position two"] }],
        uniqueInsights: [{ model: "model id", insight: "insight" }],
        blindSpots: ["missing consideration"],
        recommendation: "best supported recommendation",
        confidence: "low|medium|high",
      },
      null,
      2,
    ),
  ].join("\n");
}
