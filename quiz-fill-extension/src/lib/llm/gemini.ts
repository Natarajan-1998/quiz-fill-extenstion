/**
 * Google Gemini integration.
 * Full implementation in Task 3.
 */

import type { AnswerResult, ExtractedQuestion } from "../types.js";

export async function callGemini(
  questions: ExtractedQuestion[],
  resourceContext: string | undefined,
  apiKey: string,
  model: string
): Promise<AnswerResult[]> {
  // TODO (Task 3): Build contents[], call generateContent endpoint,
  //               parse JSON response, return AnswerResult[].
  throw new Error("callGemini not yet implemented (Task 3).");
}
