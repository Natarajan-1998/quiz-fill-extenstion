/**
 * OpenAI GPT-4o integration.
 * Full implementation in Task 3.
 */

import type { AnswerResult, ExtractedQuestion } from "../types.js";

export async function callOpenAI(
  questions: ExtractedQuestion[],
  resourceContext: string | undefined,
  apiKey: string,
  model: string
): Promise<AnswerResult[]> {
  // TODO (Task 3): Build prompt, call https://api.openai.com/v1/chat/completions,
  //               parse JSON response, return AnswerResult[].
  throw new Error("callOpenAI not yet implemented (Task 3).");
}
