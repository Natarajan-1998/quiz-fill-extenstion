/**
 * Google Gemini integration — Task 3
 *
 * Sends extracted questions (and optional resource context) to the Gemini
 * generateContent API and returns a structured array of AnswerResult objects.
 *
 * API reference:
 * https://ai.google.dev/api/generate-content#v1beta.models.generateContent
 *
 * Key differences from OpenAI:
 *  - Auth is a query-param (?key=...) not an Authorization header
 *  - System instruction is a top-level field, not a "system" role message
 *  - Response path: candidates[0].content.parts[0].text
 *  - JSON mode: responseMimeType = "application/json" in generationConfig
 */

import type { AnswerResult, ExtractedQuestion } from "../types.js";
import { buildSystemPrompt, buildUserPrompt, parseAnswers } from "./prompt.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export async function callGemini(
  questions: ExtractedQuestion[],
  resourceContext: string | undefined,
  apiKey: string,
  model: string
): Promise<AnswerResult[]> {
  if (questions.length === 0) return [];

  const systemPrompt = buildSystemPrompt(resourceContext);
  const userPrompt   = buildUserPrompt(questions);

  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    // System instruction — Gemini-specific top-level field
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      // Tell Gemini to respond with valid JSON
      responseMimeType: "application/json",
    },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (err: unknown) {
    throw new Error(
      `Network error reaching Gemini: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── HTTP error handling ────────────────────────────────────────────────
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail =
      (body as { error?: { message?: string } }).error?.message ?? res.statusText;

    if (res.status === 400 && detail.toLowerCase().includes("api key")) {
      throw new Error("Invalid Gemini API key. Update it in Settings.");
    }
    if (res.status === 400) {
      throw new Error(`Gemini bad request: ${detail}`);
    }
    if (res.status === 429) {
      // Keep Google's own message: it names the exceeded quota and retry delay.
      throw new Error(`Gemini rate limit or quota error (429) for model "${model}": ${detail.slice(0, 300)}`);
    }
    if (res.status === 404) {
      throw new Error(
        `Gemini model "${model}" not found. Check your model name in Settings.`
      );
    }
    throw new Error(`Gemini error ${res.status}: ${detail}`);
  }

  // ── Parse response ─────────────────────────────────────────────────────
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };

  const rawContent =
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const finishReason = data.candidates?.[0]?.finishReason ?? "";

  if (finishReason === "MAX_TOKENS") {
    console.warn("[QuizFill/Gemini] Response truncated (MAX_TOKENS).");
  }

  console.log(
    `[QuizFill/Gemini] Tokens used — prompt: ` +
    `${data.usageMetadata?.promptTokenCount ?? "?"}, ` +
    `completion: ${data.usageMetadata?.candidatesTokenCount ?? "?"}`
  );

  return parseAnswers(rawContent, questions);
}
