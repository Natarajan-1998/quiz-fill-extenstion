/**
 * Background Service Worker — Tasks 1, 2, 3 & 6
 *
 * Central message hub. Only the service worker can make cross-origin fetch()
 * calls to OpenAI / Gemini (via host_permissions in the manifest).
 *
 * Handlers:
 *  - Task 2: TEST_CONNECTION — make a minimal API call to validate the key
 *  - Task 3: AI_COMPLETE     — route questions to OpenAI or Gemini, return answers
 *  - Task 6: FETCH_URL       — fetch a user-provided URL and return its text
 */

import browser from "webextension-polyfill";
import {
  MessageType,
  type AiCompletePayload,
  type FetchUrlPayload,
  type FetchUrlResult,
  type ListModelsPayload,
  type TestConnectionPayload,
  type TestConnectionResult,
} from "../lib/types.js";
import { handleAiComplete } from "../lib/llm/router.js";
import { listModels } from "../lib/llm/models.js";
import { fillFields, type FillOutcome, type InjectorPayload } from "../lib/injector.js";

// ---------------------------------------------------------------------------
// INJECT_ANSWERS — run the fill function inside the page (MAIN world)
//
// Content scripts cannot use chrome.tabs / chrome.scripting, so they ask the
// service worker to do it. The tab comes from the message sender, not from a
// "current tab" query, so the right page is filled even if focus has moved.
// ---------------------------------------------------------------------------

type InjectResult =
  | { success: true; outcomes: FillOutcome[] }
  | { success: false; unsupported?: boolean; error: string };

async function handleInjectAnswers(
  payload: InjectorPayload,
  sender: browser.Runtime.MessageSender
): Promise<InjectResult> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return { success: false, error: "Message did not come from a tab." };
  }

  // Firefox's MV2 build has no chrome.scripting; the content script then fills directly.
  if (typeof chrome === "undefined" || !chrome.scripting?.executeScript) {
    return { success: false, unsupported: true, error: "scripting API unavailable." };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [sender.frameId ?? 0] },
      world: "MAIN",
      func: fillFields,
      args: [payload],
    });
    const outcomes = results?.[0]?.result as FillOutcome[] | undefined;
    if (!outcomes) return { success: false, error: "The page returned no fill result." };
    return { success: true, outcomes };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// FETCH_URL — fetch a user-provided URL and return its raw text/HTML
// ---------------------------------------------------------------------------

async function handleFetchUrl(payload: FetchUrlPayload): Promise<FetchUrlResult> {
  const { url } = payload;

  if (!url) {
    return { success: false, error: "No URL provided." };
  }

  // Basic URL validation
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { success: false, error: `Invalid URL: "${url}"` };
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return { success: false, error: "Only http:// and https:// URLs are supported." };
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        // Identify ourselves as a browser-like client to avoid bot blocks
        "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      // Respect redirects up to the browser default limit
      redirect: "follow",
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Server returned ${res.status} ${res.statusText} for ${url}`,
      };
    }

    // Read as text — the popup will strip HTML tags with stripHtml()
    const text = await res.text();

    // Cap at 200 KB to avoid overwhelming the LLM context window
    const capped = text.slice(0, 200_000);

    return { success: true, text: capped };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Fetch failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// TEST_CONNECTION — validate the user-supplied API key
// ---------------------------------------------------------------------------

async function handleTestConnection(
  payload: TestConnectionPayload
): Promise<TestConnectionResult> {
  const { provider, apiKey, model } = payload;

  if (!apiKey) {
    return { success: false, message: "API key is empty." };
  }

  try {
    if (provider === "openai") {
      return await testOpenAI(apiKey, model);
    } else if (provider === "gemini") {
      return await testGemini(apiKey, model);
    }
    return { success: false, message: `Unknown provider: ${provider}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}

/** Send a minimal one-token completion to OpenAI to verify the key. */
async function testOpenAI(apiKey: string, model: string): Promise<TestConnectionResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      max_tokens: 5,
      temperature: 0,
    }),
  });

  if (res.status === 401) {
    return { success: false, message: "Invalid API key. Check your OpenAI key and try again." };
  }
  if (res.status === 429) {
    // Rate limit still means the key is valid
    return { success: true, message: "Key is valid (rate-limited — quota may be low)." };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
    return { success: false, message: `OpenAI error ${res.status}: ${detail}` };
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
  return {
    success: true,
    message: `Connected! Model replied: "${reply}".`,
  };
}

/** Send a minimal generateContent request to Gemini to verify the key. */
async function testGemini(apiKey: string, model: string): Promise<TestConnectionResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }],
      generationConfig: { maxOutputTokens: 5, temperature: 0 },
    }),
  });

  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { error?: { message?: string } }).error?.message ?? "Bad request";
    // A 400 with "API key not valid" message means the key is wrong
    if (detail.toLowerCase().includes("api key")) {
      return { success: false, message: "Invalid API key. Check your Gemini key and try again." };
    }
    return { success: false, message: `Gemini error 400: ${detail}` };
  }
  if (res.status === 404) {
    return {
      success: false,
      message: `Model "${model}" was not found. It may have been retired. Pick another model from the list.`,
    };
  }
  if (res.status === 429) {
    return { success: true, message: "Key is valid (rate-limited — quota may be low)." };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
    return { success: false, message: `Gemini error ${res.status}: ${detail}` };
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  return {
    success: true,
    message: `Connected! Model replied: "${reply}".`,
  };
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

export default defineBackground(() => {
  console.log("[QuizFill] Background service worker started.");

  browser.runtime.onMessage.addListener(
    (
      message: { type: MessageType; [key: string]: unknown },
      _sender: browser.Runtime.MessageSender,
      sendResponse: (response: unknown) => void
    ) => {
      console.log("[QuizFill background] Received message:", message.type);

      switch (message.type) {
        case MessageType.AI_COMPLETE: {
          const payload = message as unknown as AiCompletePayload & { type: MessageType };
          handleAiComplete(payload).then(sendResponse);
          return true; // keep channel open for async response
        }

        case MessageType.TEST_CONNECTION: {
          const payload = message as unknown as TestConnectionPayload & { type: MessageType };
          handleTestConnection(payload).then(sendResponse);
          return true; // keep channel open for async response
        }

        case MessageType.INJECT_ANSWERS: {
          const payload = (message as unknown as { payload: InjectorPayload }).payload;
          handleInjectAnswers(payload, _sender).then(sendResponse);
          return true;
        }

        case MessageType.LIST_MODELS: {
          const payload = message as unknown as ListModelsPayload & { type: MessageType };
          listModels(payload.provider, payload.apiKey).then(sendResponse);
          return true;
        }

        case MessageType.FETCH_URL: {
          const payload = message as unknown as FetchUrlPayload & { type: MessageType };
          handleFetchUrl(payload).then(sendResponse);
          return true; // keep channel open for async response
        }

        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      }

      return true;
    }
  );
});
