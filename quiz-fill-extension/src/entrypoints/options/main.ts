/**
 * Options page — Task 2 (model list loaded from the provider)
 *
 * Handles:
 *  - Loading saved LLMSettings from chrome.storage.local on page load
 *  - Loading the list of usable models from the provider (LIST_MODELS) once an
 *    API key is present, with a manual "Custom model name" fallback when the
 *    list cannot be loaded or the saved model is no longer offered
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
  type ListModelsResult,
  type ModelInfo,
  type TestConnectionPayload,
  type TestConnectionResult,
} from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Value of the last <option>, which switches the page to a free-text model field. */
const CUSTOM = "__custom__";

/** Only used as placeholder text. Not applied unless the user types it. */
const EXAMPLE_MODEL: Record<LLMProvider, string> = {
  openai: "gpt-4o",
  gemini: "gemini-3.5-flash-lite",
};

/** Auto-refresh only fires for keys at least this long, to avoid requests while typing. */
const MIN_KEY_LENGTH_FOR_AUTO_REFRESH = 20;

const KEY_HINTS: Record<LLMProvider, string> = {
  openai:
    'Get your key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>. Keys start with <code>sk-</code>.',
  gemini:
    'Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>.',
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const providerSelect   = document.getElementById("provider-select")     as HTMLSelectElement;
const modelSelect      = document.getElementById("model-select")        as HTMLSelectElement;
const modelCustomInput = document.getElementById("model-custom-input")  as HTMLInputElement;
const modelHint        = document.getElementById("model-hint")          as HTMLParagraphElement;
const modelError       = document.getElementById("model-error")         as HTMLParagraphElement;
const refreshModelsBtn = document.getElementById("refresh-models-btn")  as HTMLButtonElement;
const apiKeyInput      = document.getElementById("api-key-input")       as HTMLInputElement;
const keyHint          = document.getElementById("key-hint")            as HTMLParagraphElement;
const keyError         = document.getElementById("key-error")           as HTMLParagraphElement;
const toggleKeyVis     = document.getElementById("toggle-key-vis")      as HTMLButtonElement;
const eyeOpen          = document.getElementById("eye-open")            as HTMLElement;
const eyeClosed        = document.getElementById("eye-closed")          as HTMLElement;
const saveBtn          = document.getElementById("save-btn")            as HTMLButtonElement;
const testBtn          = document.getElementById("test-btn")            as HTMLButtonElement;
const savedBadge       = document.getElementById("saved-badge")         as HTMLSpanElement;
const toast            = document.getElementById("toast")               as HTMLDivElement;
const toastText        = document.getElementById("toast-text")          as HTMLSpanElement;
const toastSpinner     = document.getElementById("toast-spinner")       as HTMLDivElement;
const clearDataBtn     = document.getElementById("clear-data-btn")      as HTMLButtonElement;

// ---------------------------------------------------------------------------
// Model dropdown
// ---------------------------------------------------------------------------

/** Incremented on every refresh so a slow, older response cannot overwrite a newer one. */
let loadSeq = 0;

/** The model the user has chosen, from the dropdown or the free-text field. */
function getSelectedModel(): string {
  return modelSelect.value === CUSTOM ? modelCustomInput.value.trim() : modelSelect.value;
}

function setCustomMode(on: boolean, prefill?: string): void {
  modelCustomInput.style.display = on ? "block" : "none";
  if (prefill !== undefined) modelCustomInput.value = prefill;
}

function setModelHint(text: string): void {
  // textContent, not innerHTML: error text can come from the network.
  modelHint.textContent = text;
}

function appendCustomOption(): void {
  const el = document.createElement("option");
  el.value = CUSTOM;
  el.textContent = "Custom model name…";
  modelSelect.appendChild(el);
}

/** Fill the dropdown from the provider's list. Returns true if `wanted` was in the list. */
function renderModelOptions(models: ModelInfo[], wanted?: string): boolean {
  modelSelect.innerHTML = "";
  for (const m of models) {
    const el = document.createElement("option");
    el.value = m.id;
    el.textContent = m.label;
    modelSelect.appendChild(el);
  }
  appendCustomOption();

  if (wanted && models.some((m) => m.id === wanted)) {
    modelSelect.value = wanted;
    setCustomMode(false);
    return true;
  }
  if (wanted) {
    // Saved or typed model is not offered for this key: keep it visible and editable.
    modelSelect.value = CUSTOM;
    setCustomMode(true, wanted);
    return false;
  }
  modelSelect.selectedIndex = 0;
  setCustomMode(false);
  return true;
}

/** Fallback: no list available, so the user types a model name. */
function renderManualEntry(provider: LLMProvider, wanted?: string): void {
  modelSelect.innerHTML = "";
  appendCustomOption();
  modelSelect.value = CUSTOM;
  modelCustomInput.placeholder = `e.g. ${EXAMPLE_MODEL[provider]}`;
  setCustomMode(true, wanted ?? "");
}

/**
 * Ask the provider which models this key can use and rebuild the dropdown.
 * `wanted` is the model to keep selected if it is still offered.
 */
async function refreshModels(wanted?: string): Promise<void> {
  const provider = providerSelect.value as LLMProvider;
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    renderManualEntry(provider, wanted);
    setModelHint("Enter your API key to load the models available to it, or type a model name.");
    return;
  }

  const seq = ++loadSeq;
  refreshModelsBtn.disabled = true;
  setModelHint("Loading available models…");

  try {
    const res = (await browser.runtime.sendMessage({
      type: MessageType.LIST_MODELS,
      provider,
      apiKey,
    })) as ListModelsResult;

    if (seq !== loadSeq) return; // a newer request superseded this one

    if (res.success && res.models) {
      const found = renderModelOptions(res.models, wanted);
      setModelHint(
        found
          ? `${res.models.length} models available for this key.`
          : `"${wanted}" is not offered for this key (it may have been retired). Pick a model above or keep your own name.`
      );
    } else {
      renderManualEntry(provider, wanted);
      setModelHint(
        `Could not load the model list: ${res.error ?? "unknown error"} Type a model name instead.`
      );
    }
  } catch (err: unknown) {
    if (seq !== loadSeq) return;
    renderManualEntry(provider, wanted);
    const msg = err instanceof Error ? err.message : String(err);
    setModelHint(`Could not load the model list: ${msg} Type a model name instead.`);
  } finally {
    if (seq === loadSeq) refreshModelsBtn.disabled = false;
  }
}

let keyDebounce: ReturnType<typeof setTimeout> | null = null;

function scheduleAutoRefresh(): void {
  if (keyDebounce) clearTimeout(keyDebounce);
  const key = apiKeyInput.value.trim();
  if (key.length < MIN_KEY_LENGTH_FOR_AUTO_REFRESH) return;
  keyDebounce = setTimeout(() => refreshModels(getSelectedModel() || undefined), 800);
}

// ---------------------------------------------------------------------------
// Toast
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
// Saved badge
// ---------------------------------------------------------------------------

let savedBadgeTimer: ReturnType<typeof setTimeout> | null = null;

function flashSavedBadge(): void {
  savedBadge.classList.add("visible");
  if (savedBadgeTimer) clearTimeout(savedBadgeTimer);
  savedBadgeTimer = setTimeout(() => savedBadge.classList.remove("visible"), 3000);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(): boolean {
  let ok = true;

  if (!apiKeyInput.value.trim()) {
    keyError.classList.add("visible");
    apiKeyInput.focus();
    ok = false;
  } else {
    keyError.classList.remove("visible");
  }

  if (!getSelectedModel()) {
    modelError.classList.add("visible");
    if (ok) modelCustomInput.focus();
    ok = false;
  } else {
    modelError.classList.remove("visible");
  }

  return ok;
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
    model: getSelectedModel(),
  };

  await browser.storage.local.set({ llmSettings: settings });
  flashSavedBadge();
  showToast("success", "Settings saved successfully.");
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
      model: getSelectedModel(),
    };

    const result = (await browser.runtime.sendMessage({
      type: MessageType.TEST_CONNECTION,
      ...payload,
    })) as TestConnectionResult;

    showToast(result.success ? "success" : "error", `${result.success ? "✓" : "✗"} ${result.message}`);
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
    keyHint.innerHTML = KEY_HINTS["openai"];
    await refreshModels();
    return;
  }

  providerSelect.value = saved.provider;
  apiKeyInput.value = saved.apiKey;
  keyHint.innerHTML = KEY_HINTS[saved.provider];

  await refreshModels(saved.model);
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

  providerSelect.value = "openai";
  apiKeyInput.value = "";
  keyHint.innerHTML = KEY_HINTS["openai"];
  keyError.classList.remove("visible");
  modelError.classList.remove("visible");
  savedBadge.classList.remove("visible");
  hideToast();
  await refreshModels();

  showToast("success", "All settings cleared.");
  setTimeout(hideToast, 3000);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  // Provider change → the old list does not apply, reload for the new provider
  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value as LLMProvider;
    keyHint.innerHTML = KEY_HINTS[provider];
    keyError.classList.remove("visible");
    modelError.classList.remove("visible");
    hideToast();
    savedBadge.classList.remove("visible");
    refreshModels();
  });

  // Model dropdown: reveal the text field for "Custom model name…"
  modelSelect.addEventListener("change", () => {
    const custom = modelSelect.value === CUSTOM;
    setCustomMode(custom);
    modelError.classList.remove("visible");
    if (custom) {
      modelCustomInput.placeholder = `e.g. ${EXAMPLE_MODEL[providerSelect.value as LLMProvider]}`;
      modelCustomInput.focus();
    }
  });

  modelCustomInput.addEventListener("input", () => {
    if (modelCustomInput.value.trim()) modelError.classList.remove("visible");
    savedBadge.classList.remove("visible");
  });

  refreshModelsBtn.addEventListener("click", () => refreshModels(getSelectedModel() || undefined));

  // API key input: clear errors, then reload models once the key looks complete
  apiKeyInput.addEventListener("input", () => {
    if (apiKeyInput.value.trim()) keyError.classList.remove("visible");
    hideToast();
    savedBadge.classList.remove("visible");
    scheduleAutoRefresh();
  });

  toggleKeyVis.addEventListener("click", () => {
    const isHidden = apiKeyInput.type === "password";
    apiKeyInput.type = isHidden ? "text" : "password";
    eyeOpen.style.display   = isHidden ? "none"  : "block";
    eyeClosed.style.display = isHidden ? "block" : "none";
  });

  saveBtn.addEventListener("click", saveSettings);
  testBtn.addEventListener("click", testConnection);
  clearDataBtn.addEventListener("click", clearAllData);

  apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveSettings();
  });
});
