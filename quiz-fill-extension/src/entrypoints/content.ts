/**
 * Content Script — injected into every page the user visits.
 *
 * Zero passive behavior: the script does nothing until it receives a
 * FILL_PAGE message from the popup (triggered by the user clicking the
 * extension toolbar button).
 *
 * Full implementation across later tasks:
 *  - Task 4: extractQuestions()  — DOM question extractor
 *  - Task 5: injectAnswers()     — MAIN-world answer injector + confidence badges
 *  - Task 7: full fill flow wired together
 */

import browser from "webextension-polyfill";
import { MessageType } from "../lib/types.js";

export default defineContentScript({
  // Inject into every URL; we only act on explicit user trigger.
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

        // Return a Promise so the popup's sendMessage awaits the result.
        return handleFillPage(message.resourceContext as string | undefined);
      }
    );
  },
});

// ---------------------------------------------------------------------------
// Main fill handler (skeleton — fleshed out in Tasks 4 & 5)
// ---------------------------------------------------------------------------

async function handleFillPage(resourceContext?: string): Promise<unknown> {
  // Task 4: extractQuestions() will scan the DOM here.
  // Task 5: injectAnswers()   will fill the fields here.
  // For now, return a no-op success so the popup's error handler isn't triggered.

  console.log("[QuizFill content] handleFillPage called. resourceContext provided:", Boolean(resourceContext));

  return {
    success: false,
    error: "Fill logic not yet implemented (Task 4 & 5).",
  };
}
