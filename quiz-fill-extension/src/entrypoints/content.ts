/**
 * Content Script — Tasks 4 & 5
 *
 * Zero passive behaviour: nothing happens until the user clicks the toolbar
 * button, which sends a FILL_PAGE message from the popup.
 *
 * Full flow:
 *   FILL_PAGE received
 *     → extractQuestions()     — scan the DOM for all fillable fields
 *     → AI_COMPLETE message    — send questions + resourceContext to background
 *     → receive AnswerResult[] — structured answers from the LLM
 *     → injectAnswers()        — fill DOM fields via MAIN-world script injection
 *     → renderBadges()         — place confidence badges next to each filled field
 *     → return FillSummary     — reported back to the popup
 */

import browser from "webextension-polyfill";
import {
  MessageType,
  type AiCompletePayload,
  type AiCompleteResult,
  type AnswerResult,
  type FillSummary,
} from "../lib/types.js";
import { extractQuestions } from "../lib/extractor.js";
import { buildInjectorPayload, fillFields, type FillOutcome } from "../lib/injector.js";
import { renderBadges, clearBadges } from "../lib/badge.js";

// ---------------------------------------------------------------------------
// Content script registration
// ---------------------------------------------------------------------------

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",

  main() {
    console.log("[QuizFill content] Content script loaded.");

    browser.runtime.onMessage.addListener(
      (
        message: { type: MessageType; [key: string]: unknown },
        _sender: browser.Runtime.MessageSender
      ) => {
        if (message.type !== MessageType.FILL_PAGE) return;

        console.log("[QuizFill content] FILL_PAGE received — starting fill flow.");

        // Return a Promise so the popup's sendMessage awaits the full result.
        return handleFillPage(message.resourceContext as string | undefined);
      }
    );
  },
});

// ---------------------------------------------------------------------------
// Main fill handler
// ---------------------------------------------------------------------------

async function handleFillPage(resourceContext?: string): Promise<{
  success: boolean;
  summary?: FillSummary;
  error?: string;
}> {
  // Clear any badges left by a previous fill run
  clearBadges();

  // ── Step 1: Extract questions ──────────────────────────────────────────
  let questions: ReturnType<typeof extractQuestions>;
  try {
    questions = extractQuestions();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[QuizFill content] extractQuestions() threw:", msg);
    return { success: false, error: `Failed to scan page: ${msg}` };
  }

  console.log(
    `[QuizFill content] Extracted ${questions.length} question(s):`,
    questions.map((q) => `[${q.type}] "${q.labelText.slice(0, 60)}" (${q.fieldId})`)
  );

  if (questions.length === 0) {
    return { success: false, error: "No fillable fields detected on this page." };
  }

  // ── Step 2: Send to background worker for LLM completion ──────────────
  const payload: AiCompletePayload = { questions, resourceContext };

  let result: AiCompleteResult;
  try {
    result = (await browser.runtime.sendMessage({
      type: MessageType.AI_COMPLETE,
      ...payload,
    })) as AiCompleteResult;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[QuizFill content] AI_COMPLETE message failed:", msg);
    return { success: false, error: `Could not reach background worker: ${msg}` };
  }

  if (!result.success) {
    return { success: false, error: result.error };
  }

  const answers = result.answers;
  console.log(
    `[QuizFill content] Received ${answers.length} answer(s) from LLM:`,
    answers.map((a) => `[${a.fieldId}] "${a.answer}" (${Math.round(a.confidence * 100)}%)`)
  );

  // ── Step 3: Inject answers + render confidence badges ─────────────────
  const fillResult = await injectAnswers(answers, questions);

  // ── Step 4: Build and return summary ──────────────────────────────────
  return { success: true, summary: buildSummary(fillResult.filled, fillResult.errors) };
}

// ---------------------------------------------------------------------------
// Answer injector
// ---------------------------------------------------------------------------

/**
 * Fill the page, then place confidence badges on the fields that were filled.
 *
 * Content scripts have no chrome.tabs / chrome.scripting, so the fill runs via
 * the background worker (which injects it into the page's MAIN world). If that
 * is unavailable (Firefox MV2) or fails, the same function runs here directly.
 */
async function injectAnswers(
  answers:   AnswerResult[],
  questions: ReturnType<typeof extractQuestions>
): Promise<{ errors: string[]; filled: AnswerResult[] }> {
  const selectorMap = new Map<string, string>();
  for (const q of questions) {
    if (q.selector) selectorMap.set(q.fieldId, q.selector);
  }
  const payload = buildInjectorPayload(answers, selectorMap);

  let outcomes: FillOutcome[] | null = null;

  try {
    const res = (await browser.runtime.sendMessage({
      type: MessageType.INJECT_ANSWERS,
      payload,
    })) as { success: boolean; outcomes?: FillOutcome[]; error?: string } | undefined;

    if (res?.success && res.outcomes) {
      outcomes = res.outcomes;
    } else {
      console.warn("[QuizFill content] Page-world fill unavailable, filling directly:", res?.error);
    }
  } catch (err: unknown) {
    console.warn("[QuizFill content] Page-world fill failed, filling directly:", err);
  }

  if (!outcomes) {
    try {
      outcomes = fillFields(payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[QuizFill content] Direct fill failed:", msg);
      return { errors: [`Fill failed: ${msg}`], filled: [] };
    }
  }

  const filledIds = new Set<string>();
  const errors: string[] = [];
  for (const o of outcomes) {
    if (o.filled) {
      filledIds.add(o.fieldId);
    } else {
      errors.push(`"${o.fieldId}": ${o.reason}`);
    }
  }

  const filled = answers.filter((a) => filledIds.has(a.fieldId));

  try {
    renderBadges(filled, questions);
  } catch (err: unknown) {
    console.warn("[QuizFill content] Badge rendering failed:", err);
  }

  return { errors, filled };
}

// ---------------------------------------------------------------------------
// Summary builder (counts only fields that were actually filled)
// ---------------------------------------------------------------------------

function buildSummary(filled: AnswerResult[], errors: string[]): FillSummary {
  let high = 0, med = 0, low = 0;
  for (const a of filled) {
    if (a.confidence >= 0.8)      high++;
    else if (a.confidence >= 0.5) med++;
    else                          low++;
  }
  return {
    totalFilled:    filled.length,
    highConfidence: high,
    medConfidence:  med,
    lowConfidence:  low,
    errors,
  };
}
