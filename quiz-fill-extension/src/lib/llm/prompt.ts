/**
 * Shared prompt engineering and answer parsing — Task 3
 *
 * Both the OpenAI and Gemini callers use this module so the prompt structure
 * and the JSON schema are defined in exactly one place.
 *
 * ── Expected LLM output schema ───────────────────────────────────────────
 *
 * The LLM must return a JSON object with a single key "answers":
 *
 * {
 *   "answers": [
 *     {
 *       "fieldId":    "q-name-first",
 *       "answer":     "John",
 *       "confidence": 0.95,
 *       "reasoning":  "The question asks for a first name."
 *     },
 *     ...
 *   ]
 * }
 *
 * fieldId must match one of the ExtractedQuestion.fieldId values in the prompt.
 * confidence is a float 0–1.
 * reasoning is optional but encouraged for debugging.
 */

import type { AnswerResult, ExtractedQuestion } from "../types.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(resourceContext: string | undefined): string {
  const resourceSection = resourceContext
    ? `\n\n## Reference material provided by the user\n\nUse the following content to inform your answers. Prioritise information from this material over general knowledge.\n\n---\n${resourceContext.slice(0, 12_000)}\n---`
    : "";

  return `You are QuizFill, an expert assistant that answers quiz and survey questions accurately and concisely.

## Your task
You will receive a JSON array of form fields extracted from a web page. For each field, produce the best possible answer based on the question text, the available options (if any), and any reference material provided.

## Output format
You MUST respond with a single JSON object (no markdown fences, no extra text) that matches this exact schema:

{
  "answers": [
    {
      "fieldId":    "<string — exactly as given in the input>",
      "answer":     "<string — the value to fill>",
      "confidence": <number 0.0–1.0>,
      "reasoning":  "<string — one sentence explaining the answer>"
    }
  ]
}

## Rules
- Include every fieldId from the input, even if you are unsure — use a low confidence score when guessing.
- For radio / checkbox / select fields: "answer" must be one of the provided option values, not the display label.
- For text / textarea fields: write a natural, concise answer. Do not pad with filler.
- Confidence guide: 1.0 = certain, 0.8 = very likely, 0.5 = best guess, 0.2 = very uncertain.
- Never fabricate factual data (names, dates, numbers) unless the question is clearly hypothetical.
- Do not include any text outside the JSON object.${resourceSection}`;
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

export function buildUserPrompt(questions: ExtractedQuestion[]): string {
  // Serialise questions to a compact JSON block
  const questionList = questions.map((q) => {
    const base: Record<string, unknown> = {
      fieldId:   q.fieldId,
      type:      q.type,
      question:  q.labelText,
    };
    if (q.options && q.options.length > 0) {
      base.options = q.options.map((o) => ({ value: o.value, label: o.label }));
    }
    return base;
  });

  return (
    `Please answer the following form fields extracted from the current page.\n\n` +
    `\`\`\`json\n${JSON.stringify(questionList, null, 2)}\n\`\`\``
  );
}

// ---------------------------------------------------------------------------
// Answer parser
// ---------------------------------------------------------------------------

interface RawAnswer {
  fieldId?:    unknown;
  answer?:     unknown;
  confidence?: unknown;
  reasoning?:  unknown;
}

interface RawResponse {
  answers?: RawAnswer[];
}

/**
 * Parse the raw LLM text into AnswerResult[].
 *
 * Handles:
 *  - Clean JSON object  { "answers": [...] }
 *  - JSON array         [...]   (some models ignore the wrapper instruction)
 *  - Markdown-fenced    ```json ... ```
 *  - Partial / truncated JSON (best-effort — returns whatever parsed cleanly)
 *
 * Unknown fieldIds are silently dropped. Missing answers for known questions
 * are filled with an empty string and confidence 0.
 */
export function parseAnswers(
  rawContent: string,
  questions: ExtractedQuestion[]
): AnswerResult[] {
  const knownIds = new Set(questions.map((q) => q.fieldId));

  // ── 1. Strip markdown fences ─────────────────────────────────────────
  let text = rawContent.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // ── 2. Parse JSON ────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to rescue a truncated response by closing open brackets
    parsed = tryRepairJson(text);
    if (!parsed) {
      console.error("[QuizFill/prompt] Failed to parse LLM response:", text.slice(0, 300));
      return fallbackEmpty(questions);
    }
  }

  // ── 3. Normalise to RawAnswer[] ──────────────────────────────────────
  let rawAnswers: RawAnswer[] = [];

  if (Array.isArray(parsed)) {
    // Model returned a bare array
    rawAnswers = parsed as RawAnswer[];
  } else if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as RawResponse).answers)
  ) {
    rawAnswers = (parsed as RawResponse).answers!;
  } else {
    console.error("[QuizFill/prompt] Unexpected response shape:", parsed);
    return fallbackEmpty(questions);
  }

  // ── 4. Build result map ───────────────────────────────────────────────
  const resultMap = new Map<string, AnswerResult>();

  for (const raw of rawAnswers) {
    const fieldId    = typeof raw.fieldId    === "string" ? raw.fieldId    : null;
    const answer     = typeof raw.answer     === "string" ? raw.answer     : String(raw.answer ?? "");
    const confidence = typeof raw.confidence === "number"
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0.5;
    const reasoning  = typeof raw.reasoning  === "string" ? raw.reasoning  : undefined;

    if (!fieldId || !knownIds.has(fieldId)) continue; // ignore unknown ids

    resultMap.set(fieldId, { fieldId, answer, confidence, reasoning });
  }

  // ── 5. Ensure every question has an entry (fill gaps with empty) ──────
  for (const q of questions) {
    if (!resultMap.has(q.fieldId)) {
      console.warn(`[QuizFill/prompt] LLM returned no answer for fieldId "${q.fieldId}"`);
      resultMap.set(q.fieldId, {
        fieldId:    q.fieldId,
        answer:     "",
        confidence: 0,
        reasoning:  "No answer returned by LLM.",
      });
    }
  }

  return Array.from(resultMap.values());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Attempt to close truncated JSON by counting brackets. */
function tryRepairJson(text: string): unknown | null {
  try {
    // Find the last complete object/array element and close the structure
    const openCurly   = (text.match(/\{/g) ?? []).length;
    const closeCurly  = (text.match(/\}/g) ?? []).length;
    const openSquare  = (text.match(/\[/g) ?? []).length;
    const closeSquare = (text.match(/\]/g) ?? []).length;

    let repaired = text;
    // Drop trailing incomplete token (e.g. a half-written string)
    repaired = repaired.replace(/,\s*$/, "");
    repaired += "]".repeat(Math.max(0, openSquare - closeSquare));
    repaired += "}".repeat(Math.max(0, openCurly  - closeCurly));
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

/** Return zero-confidence empty answers for every question. */
function fallbackEmpty(questions: ExtractedQuestion[]): AnswerResult[] {
  return questions.map((q) => ({
    fieldId:    q.fieldId,
    answer:     "",
    confidence: 0,
    reasoning:  "LLM response could not be parsed.",
  }));
}
