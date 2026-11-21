/**
 * Content Script — Tasks 4 & 5 (Task 4 implemented here)
 *
 * Zero passive behaviour: nothing happens until the user clicks the toolbar
 * button, which sends a FILL_PAGE message from the popup.
 *
 * Task 4 flow:
 *   FILL_PAGE received
 *     → extractQuestions()   — scan the DOM for all fillable fields
 *     → AI_COMPLETE message  — send questions + resourceContext to background
 *     → receive AnswerResult[] back from the LLM router
 *     → (Task 5) injectAnswers() — fill the DOM and show confidence badges
 *
 * Task 5 wiring will replace the stub at the bottom of this file.
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
  // ── Step 1: Extract questions ────────────────���─────────────────────────
  let questions;
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
    return {
      success: false,
      error: "No fillable fields detected on this page.",
    };
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

  // ── Step 3: Inject answers into the DOM (Task 5) ──────────────────────
  const fillResult = await injectAnswers(answers);

  // ── Step 4: Build and return summary ──────────────────────────────────
  const summary: FillSummary = buildSummary(answers, fillResult.errors);

  return { success: true, summary };
}

// ---------------------------------------------------------------------------
// Answer injector — Task 5 stub
// (Full MAIN-world injection implemented in Task 5)
// ---------------------------------------------------------------------------

async function injectAnswers(
  answers: AnswerResult[]
): Promise<{ errors: string[] }> {
  // Task 5 will replace this with real DOM filling + confidence badges.
  // For now, log the answers so they're visible in DevTools for manual testing.
  console.log("[QuizFill content] injectAnswers() called — Task 5 not yet implemented.");
  console.table(
    answers.map((a) => ({
      fieldId:    a.fieldId,
      answer:     a.answer,
      confidence: `${Math.round(a.confidence * 100)}%`,
      reasoning:  a.reasoning ?? "",
    }))
  );
  return { errors: [] };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(answers: AnswerResult[], errors: string[]): FillSummary {
  let high = 0, med = 0, low = 0;
  for (const a of answers) {
    if (a.confidence >= 0.8)       high++;
    else if (a.confidence >= 0.5)  med++;
    else                           low++;
  }
  return {
    totalFilled:    answers.length,
    highConfidence: high,
    medConfidence:  med,
    lowConfidence:  low,
    errors,
  };
}
