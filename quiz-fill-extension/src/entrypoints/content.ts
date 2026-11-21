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
import { buildInjectorScript, buildInjectorPayload } from "../lib/injector.js";
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
  return { success: true, summary: buildSummary(answers, fillResult.errors) };
}

// ---------------------------------------------------------------------------
// Answer injector — Task 5 (full implementation)
// ---------------------------------------------------------------------------

/**
 * Two-step process:
 *  1. chrome.scripting.executeScript({ world: "MAIN" }) — runs the fill script
 *     inside the page's own JS context so React/Vue/Angular synthetic events
 *     are fired on the same prototype the framework patched.
 *  2. renderBadges() — appends Shadow-DOM confidence pills (isolated world).
 */
async function injectAnswers(
  answers:   AnswerResult[],
  questions: ReturnType<typeof extractQuestions>
): Promise<{ errors: string[] }> {
  const errors: string[] = [];

  // Build fieldId → selector map
  const selectorMap = new Map<string, string>();
  for (const q of questions) {
    if (q.selector) selectorMap.set(q.fieldId, q.selector);
  }

  // ── MAIN-world DOM filling ────────────────────────────────────────────
  const injPayload = buildInjectorPayload(answers, selectorMap);
  const script     = buildInjectorScript(injPayload);

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      world:  "MAIN" as any,
      // Pass the script string as a function body so Vite doesn't rewrite it
      func:   new Function(`return (${script})()`) as () => unknown,
    });

    const outcome = results?.[0]?.result as Array<{
      fieldId: string;
      filled:  boolean;
      reason:  string;
    }> | undefined;

    if (outcome) {
      for (const item of outcome) {
        if (!item.filled) {
          const msg = `Could not fill "${item.fieldId}": ${item.reason}`;
          console.warn("[QuizFill content]", msg);
          errors.push(msg);
        } else {
          console.log(`[QuizFill content] ✓ Filled "${item.fieldId}"`);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[QuizFill content] MAIN-world injection failed:", msg);
    errors.push(`Injection failed: ${msg}`);
  }

  // ── Confidence badges (Shadow DOM, isolated world) ────────────────────
  try {
    renderBadges(answers, questions);
  } catch (err: unknown) {
    // Non-fatal — filling may have succeeded even if badges fail
    console.warn("[QuizFill content] Badge rendering failed:", err);
  }

  return { errors };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(answers: AnswerResult[], errors: string[]): FillSummary {
  let high = 0, med = 0, low = 0;
  for (const a of answers) {
    if (a.confidence >= 0.8)      high++;
    else if (a.confidence >= 0.5) med++;
    else                          low++;
  }
  return {
    totalFilled:    answers.length,
    highConfidence: high,
    medConfidence:  med,
    lowConfidence:  low,
    errors,
  };
}
