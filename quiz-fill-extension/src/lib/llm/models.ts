/**
 * Model discovery — asks the provider which models the user's API key can use.
 *
 * Model names are retired often (Google shut down gemini-1.5-* on 2025-09-29),
 * so the options page loads this list instead of shipping a hardcoded one.
 * Runs in the background service worker, which holds the host permissions.
 */

import type { LLMProvider, ListModelsResult, ModelInfo } from "../types.js";

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** Gemini models that support generateContent but are not text/chat models. */
const GEMINI_EXCLUDE = /embedding|tts|image|live|audio|robotics|computer-use|transcribe|translate|aqa/i;

/** OpenAI models that are not usable for chat completions. */
const OPENAI_EXCLUDE =
  /instruct|audio|realtime|transcribe|tts|image|search|embedding|moderation|whisper|dall|codex|davinci|babbage|sora/i;

export async function listModels(
  provider: LLMProvider,
  apiKey: string
): Promise<ListModelsResult> {
  if (!apiKey) return { success: false, error: "API key is empty." };

  try {
    const models =
      provider === "gemini" ? await listGeminiModels(apiKey) : await listOpenAIModels(apiKey);

    if (models.length === 0) {
      return { success: false, error: "The provider returned no usable models for this key." };
    }
    return { success: true, models };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function listGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  const found: ModelInfo[] = [];
  let pageToken = "";

  // Follow pagination, capped so a misbehaving response cannot loop forever.
  for (let page = 0; page < 5; page++) {
    const url = `${GEMINI_MODELS_URL}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    await throwIfBad(res, "Gemini");

    const data = (await res.json()) as {
      models?: Array<{
        name?: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
      }>;
      nextPageToken?: string;
    };

    for (const m of data.models ?? []) {
      const id = (m.name ?? "").replace(/^models\//, "");
      if (!id.startsWith("gemini")) continue;
      if (GEMINI_EXCLUDE.test(id)) continue;
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
      found.push({ id, label: m.displayName ? `${m.displayName} (${id})` : id });
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return found;
}

async function listOpenAIModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  await throwIfBad(res, "OpenAI");

  const data = (await res.json()) as { data?: Array<{ id?: string }> };

  return (data.data ?? [])
    .map((m) => m.id ?? "")
    .filter((id) => /^(gpt-|o\d)/.test(id) && !OPENAI_EXCLUDE.test(id))
    .sort()
    .map((id) => ({ id, label: id }));
}

async function throwIfBad(res: Response, name: string): Promise<void> {
  if (res.ok) return;

  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  const detail = body.error?.message ?? res.statusText;

  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(detail))) {
    throw new Error(`Invalid ${name} API key.`);
  }
  if (res.status === 429) {
    throw new Error(`${name} rate limit reached. Try again shortly.`);
  }
  throw new Error(`${name} error ${res.status}: ${detail}`);
}
