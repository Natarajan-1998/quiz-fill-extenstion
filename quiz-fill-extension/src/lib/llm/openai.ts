/**
 * OpenAI GPT-4o integration — Task 3
 *
 * Sends extracted questions (and optional resource context) to the OpenAI
 * chat completions API and returns a structured array of AnswerResult objects.
 *
 * API reference: https://platform.openai.com/docs/api-reference/chat/create
 */

import type { AnswerResult, ExtractedQuestion } from "../types.js";
import { buildSystemPrompt, buildUserPrompt, parseAnswers } from "./prompt.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

export async function callOpenAI(
  questions: ExtractedQuestion[],
  resourceContext: string | undefined,
  apiKey: string,
  model: string
): Promise<AnswerResult[]> {
  if (questions.length === 0) return [];

  const systemPrompt = buildSystemPrompt(resourceContext);
  const userPrompt   = buildUserPrompt(questions);

  const requestBody = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
    temperature: 0.1,   // low temperature — deterministic answers preferred
    max_tokens: 2048,
    // Ask OpenAI to return valid JSON — supported on gpt-4o and gpt-4-turbo
    response_format: { type: "json_object" },
  };

  let res: Response;
  try {
    res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err: unknown) {
    throw new Error(
      `Network error reaching OpenAI: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── HTTP error handling ────────────────────────────────────────────────
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail =
      (body as { error?: { message?: string } }).error?.message ?? res.statusText;

    if (res.status === 401) {
      throw new Error("Invalid OpenAI API key. Update it in Settings.");
    }
    if (res.status === 429) {
      throw new Error(
        "OpenAI rate limit reached. Wait a moment and try again, or check your usage quota."
      );
    }
    if (res.status === 400) {
      throw new Error(`OpenAI bad request: ${detail}`);
    }
    throw new Error(`OpenAI error ${res.status}: ${detail}`);
  }

  // ── Parse response ─────────────────────────────────────────────────────
  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const rawContent = data.choices?.[0]?.message?.content ?? "";
  const finishReason = data.choices?.[0]?.finish_reason ?? "";

  if (finishReason === "length") {
    // Response was truncated — parse what we got, rest will be empty
    console.warn("[QuizFill/OpenAI] Response truncated (finish_reason=length).");
  }

  console.log(
    `[QuizFill/OpenAI] Tokens used — prompt: ${data.usage?.prompt_tokens ?? "?"}, ` +
    `completion: ${data.usage?.completion_tokens ?? "?"}`
  );

  return parseAnswers(rawContent, questions);
}
