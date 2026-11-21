/**
 * LLM Router — Task 3
 *
 * Reads saved LLMSettings from chrome.storage.local, selects the correct
 * provider, and delegates to callOpenAI or callGemini.
 *
 * Also exports routeLLM() as a convenience wrapper used by background.ts.
 */

import browser from "webextension-polyfill";
import type {
  AiCompletePayload,
  AiCompleteResult,
  LLMSettings,
  AnswerResult,
} from "../types.js";
import { callOpenAI } from "./openai.js";
import { callGemini } from "./gemini.js";

// ---------------------------------------------------------------------------
// Low-level router (called with explicit settings)
// ---------------------------------------------------------------------------

export async function routeLLM(
  payload: AiCompletePayload,
  settings: LLMSettings
): Promise<AnswerResult[]> {
  const { questions, resourceContext } = payload;
  const { provider, apiKey, model } = settings;

  if (!apiKey) {
    throw new Error("No API key configured. Open Settings to add one.");
  }
  if (questions.length === 0) {
    return [];
  }

  if (provider === "openai") {
    return callOpenAI(questions, resourceContext, apiKey, model);
  }
  if (provider === "gemini") {
    return callGemini(questions, resourceContext, apiKey, model);
  }

  throw new Error(`Unknown LLM provider: "${provider}". Choose OpenAI or Gemini in Settings.`);
}

// ---------------------------------------------------------------------------
// High-level handler (reads settings from storage, returns AiCompleteResult)
// Used directly by background.ts AI_COMPLETE handler.
// ---------------------------------------------------------------------------

export async function handleAiComplete(
  payload: AiCompletePayload
): Promise<AiCompleteResult> {
  // ── 1. Load settings ────────────────────────────────────────────────
  let settings: LLMSettings | undefined;
  try {
    const stored = await browser.storage.local.get("llmSettings");
    settings = stored.llmSettings as LLMSettings | undefined;
  } catch (err: unknown) {
    return {
      success: false,
      error: `Could not read settings: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!settings?.apiKey) {
    return {
      success: false,
      error: "No API key configured. Open Settings (⚙) to add your OpenAI or Gemini key.",
    };
  }

  // ── 2. Call the LLM ─────────────────────────────────────────────────
  try {
    const answers = await routeLLM(payload, settings);
    return { success: true, answers };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[QuizFill/router] LLM call failed:", msg);
    return { success: false, error: msg };
  }
}
