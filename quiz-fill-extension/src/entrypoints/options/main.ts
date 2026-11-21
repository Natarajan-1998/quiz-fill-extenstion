/**
 * Options page — Task 2
 *
 * Handles:
 *  - Loading saved LLMSettings from chrome.storage.local on page load
 *  - Dynamically updating the model dropdown when provider changes
 *  - Validating & saving settings via browser.storage.local.set()
 *  - Testing the API key via a TEST_CONNECTION message to the service worker
 *  - Show/hide API key toggle
 *  - Clear all saved settings (danger zone)
 */

import browser from "webextension-polyfill";
import {
  MessageType,
  type LLMProvider,
  type LLMSettings,
  type TestConnectionPayload,
  type TestConnectionResult,
} from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Model options per provider
// ---------------------------------------------------------------------------

const MODELS: Record<LLMProvider, Array<{ value: string; label: string; hint: string }>> = {
  openai: [
    {
      value: "gpt-4o",
      label: "GPT-4o",
      hint: "Best accuracy. Recommended for most use cases.",
    },
    {
      value: "gpt-4o-mini",
      label: "GPT-4o mini",
      hint: "Faster and cheaper. Good for simpler quizzes.",
    },
    {
      value: "gpt-4-turbo",
      label: "GPT-4 Turbo",
      hint: "Older flagship model — use GPT-4o instead.",
    },
  ],
  gemini: [
    {
      value: "gemini-1.5-flash",
      label: "Gemini 1.5 Flash",
      hint: "Fast and cost-effective. Recommended for most use cases.",
    },
    {
      value: "gemini-1.5-pro",
      label: "Gemini 1.5 Pro",
      hint: "Higher accuracy, slower and more expensive.",
    },
    {
      value: "gemini-2.0-flash",
      label: "Gemini 2.0 Flash (exp)",
      hint: "Experimental next-gen Flash model.",
    },
  ],
};

const KEY_HINTS: Record<LLMProvider, string> = {
  openai:
    'Get your key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>. Keys start with <code>sk-</code>.',
  gemini:
    'Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>.',
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const providerSelect  = document.getElementById("provider-select")  as HTMLSelectElement;
const modelSelect     = document.getElementById("model-select")      as HTMLSelectElement;
const modelHint       = document.getElementById("model-hint")        as HTMLParagraphElement;
const apiKeyInput     = document.getElementById("api-key-input")     as HTMLInputElement;
const keyHint         = document.getElementById("key-hint")          as HTMLParagraphElement;
const keyError        = document.getElementById("key-error")         as HTMLParagraphElement;
const toggleKeyVis    = document.getElementById("toggle-key-vis")    as HTMLButtonElement;
const eyeOpen         = document.getElementById("eye-open")          as HTMLElement;
const eyeClosed       = document.getElementById("eye-closed")        as HTMLElement;
const saveBtn         = document.getElementById("save-btn")          as HTMLButtonElement;
const testBtn         = document.getElementById("test-btn")          as HTMLButtonElement;
const savedBadge      = document.getElementById("saved-badge")       as HTMLSpanElement;
const toast           = document.getElementById("toast")             as HTMLDivElement;
const toastText       = document.getElementById("toast-text")        as HTMLSpanElement;
const toastSpinner    = document.getElementById("toast-spinner")     as HTMLDivElement;
const clearDataBtn    = document.getElementById("clear-data-btn")    as HTMLButtonElement;

// ---------------------------------------------------------------------------
// Helpers — model dropdown
// ---------------------------------------------------------------------------

function populateModels(provider: LLMProvider, selectedModel?: string): void {
  const options = MODELS[provider];
  modelSelect.innerHTML = "";

  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    modelSelect.appendChild(el);
  }

  // Restore previously selected model if it still exists for this provider
  if (selectedModel) {
    const exists = options.some((o) => o.value === selectedModel);
    if (exists) modelSelect.value = selectedModel;
  }

  updateModelHint();
}

function updateModelHint(): void {
  const provider = providerSelect.value as LLMProvider;
  const model = modelSelect.value;
  const found = MODELS[provider].find((m) => m.value === model);
  modelHint.textContent = found?.hint ?? "";
}

// ---------------------------------------------------------------------------
// Helpers — toast
// ---------------------------------------------------------------------------

type ToastKind = "loading" | "success" | "error";

function showToast(kind: ToastKind, message: string): void {
  toast.className = `visible ${kind}`;
  toastText.textContent = message;
  toastSpinner.style.display = kind === "loading" ? "block" : "none";
}

function hideToast(): void {
  toast.className = "";
  toast.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Helpers — saved badge
// ---------------------------------------------------------------------------

let savedBadgeTimer: ReturnType<typeof setTimeout> | null = null;

function flashSavedBadge(): void {
  savedBadge.classList.add("visible");
  if (savedBadgeTimer) clearTimeout(savedBadgeTimer);
  savedBadgeTimer = setTimeout(() => savedBadge.classList.remove("visible"), 3000);
}

// ---------------------------------------------------------------------------
// Helpers — validation
// ---------------------------------------------------------------------------

function validate(): boolean {
  const key = apiKeyInput.value.trim();

  if (!key) {
    keyError.classList.add("visible");
    apiKeyInput.focus();
    return false;
  }

  keyError.classList.remove("visible");
  return true;
}

// ---------------------------------------------------------------------------
// Save settings
// ---------------------------------------------------------------------------

async function saveSettings(): Promise<void> {
  if (!validate()) return;

  hideToast();

  const settings: LLMSettings = {
    provider: providerSelect.value as LLMProvider,
    apiKey: apiKeyInput.value.trim(),
    model: modelSelect.value,
  };

  await browser.storage.local.set({ llmSettings: settings });
  flashSavedBadge();
  showToast("success", "Settings saved successfully.");

  // Auto-hide the success toast after 3 s
  setTimeout(hideToast, 3000);
}

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

async function testConnection(): Promise<void> {
  if (!validate()) return;

  hideToast();
  showToast("loading", "Testing connection…");

  testBtn.disabled = true;
  saveBtn.disabled = true;

  try {
    const payload: TestConnectionPayload = {
      provider: providerSelect.value as LLMProvider,
      apiKey: apiKeyInput.value.trim(),
      model: modelSelect.value,
    };

    const result = (await browser.runtime.sendMessage({
      type: MessageType.TEST_CONNECTION,
      ...payload,
    })) as TestConnectionResult;

    if (result.success) {
      showToast("success", `✓ ${result.message}`);
    } else {
      showToast("error", `✗ ${result.message}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast("error", `Connection failed: ${msg}`);
  } finally {
    testBtn.disabled = false;
    saveBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Load saved settings on page open
// ---------------------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const result = await browser.storage.local.get("llmSettings");
  const saved = result.llmSettings as LLMSettings | undefined;

  if (!saved) {
    // Fresh install — just populate defaults
    populateModels("openai");
    keyHint.innerHTML = KEY_HINTS["openai"];
    return;
  }

  // Restore provider
  providerSelect.value = saved.provider;

  // Restore model (after populating the dropdown)
  populateModels(saved.provider, saved.model);

  // Restore API key (masked)
  apiKeyInput.value = saved.apiKey;

  // Update hints
  keyHint.innerHTML = KEY_HINTS[saved.provider];
}

// ---------------------------------------------------------------------------
// Clear all data
// ---------------------------------------------------------------------------

async function clearAllData(): Promise<void> {
  const confirmed = window.confirm(
    "This will delete your saved API key and all QuizFill settings. Continue?"
  );
  if (!confirmed) return;

  await browser.storage.local.clear();

  // Reset UI
  providerSelect.value = "openai";
  populateModels("openai");
  apiKeyInput.value = "";
  keyHint.innerHTML = KEY_HINTS["openai"];
  keyError.classList.remove("visible");
  savedBadge.classList.remove("visible");
  hideToast();

  showToast("success", "All settings cleared.");
  setTimeout(hideToast, 3000);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  // Load saved settings first
  await loadSettings();

  // Provider change → rebuild model dropdown + update hint
  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value as LLMProvider;
    populateModels(provider);
    keyHint.innerHTML = KEY_HINTS[provider];
    keyError.classList.remove("visible");
    hideToast();
    savedBadge.classList.remove("visible");
  });

  // Model change → update hint
  modelSelect.addEventListener("change", updateModelHint);

  // Clear error on key input
  apiKeyInput.addEventListener("input", () => {
    if (apiKeyInput.value.trim()) keyError.classList.remove("visible");
    hideToast();
    savedBadge.classList.remove("visible");
  });

  // Show/hide API key
  toggleKeyVis.addEventListener("click", () => {
    const isHidden = apiKeyInput.type === "password";
    apiKeyInput.type = isHidden ? "text" : "password";
    eyeOpen.style.display   = isHidden ? "none"  : "block";
    eyeClosed.style.display = isHidden ? "block" : "none";
  });

  // Save
  saveBtn.addEventListener("click", saveSettings);

  // Test
  testBtn.addEventListener("click", testConnection);

  // Clear all
  clearDataBtn.addEventListener("click", clearAllData);

  // Allow Enter key in API key field to save
  apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveSettings();
  });
});
