/**
 * LLM Router — selects the correct provider and delegates the call.
 * Full implementation in Task 3.
 */

import type { AnswerResult, AiCompletePayload, LLMSettings } from "../types.js";
import { callOpenAI } from "./openai.js";
import { callGemini } from "./gemini.js";

export async function routeLLM(
  payload: AiCompletePayload,
  settings: LLMSettings
): Promise<AnswerResult[]> {
  const { questions, resourceContext } = payload;
  const { provider, apiKey, model } = settings;

  if (provider === "openai") {
    return callOpenAI(questions, resourceContext, apiKey, model);
  } else if (provider === "gemini") {
    return callGemini(questions, resourceContext, apiKey, model);
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}
