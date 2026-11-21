/**
 * Background Service Worker — Tasks 1 & 2
 *
 * Central message hub. Only the service worker can make cross-origin fetch()
 * calls to OpenAI / Gemini (via host_permissions in the manifest).
 *
 * Handlers:
 *  - Task 2: TEST_CONNECTION — make a minimal API call to validate the key
 *  - Task 3: AI_COMPLETE     — route questions to OpenAI or Gemini (pending)
 *  - Task 6: FETCH_URL       — fetch a user-provided URL (pending)
 */

import browser from "webextension-polyfill";
import {
  MessageType,
  type TestConnectionPayload,
  type TestConnectionResult,
} from "../lib/types.js";

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
        case MessageType.AI_COMPLETE:
          // Implemented in Task 3
          sendResponse({ success: false, error: "AI_COMPLETE not yet implemented." });
          break;

        case MessageType.TEST_CONNECTION: {
          const payload = message as unknown as TestConnectionPayload & { type: MessageType };
          handleTestConnection(payload).then(sendResponse);
          return true; // keep channel open for async response
        }

        case MessageType.FETCH_URL:
          // Implemented in Task 6
          sendResponse({ success: false, error: "FETCH_URL not yet implemented." });
          break;

        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      }

      return true;
    }
  );
});
