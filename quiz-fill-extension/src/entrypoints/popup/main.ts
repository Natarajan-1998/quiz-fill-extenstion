/**
 * Popup entry point.
 *
 * Responsibilities (fully wired in later tasks):
 *  - Task 1: Check for API key; show no-key banner; wire settings link.
 *  - Task 7: Full idle → filling → results state machine.
 */

import browser from "webextension-polyfill";
import {
  MessageType,
  type FillSummary,
  type LLMSettings,
} from "../../lib/types.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const noKeyBanner = document.getElementById("no-key-banner") as HTMLDivElement;
const setupLink = document.getElementById("setup-link") as HTMLAnchorElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const fillBtn = document.getElementById("fill-btn") as HTMLButtonElement;
const statusArea = document.getElementById("status-area") as HTMLDivElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const resultsArea = document.getElementById("results-area") as HTMLDivElement;
const errorArea = document.getElementById("error-area") as HTMLDivElement;
const highCount = document.getElementById("high-count") as HTMLSpanElement;
const medCount = document.getElementById("med-count") as HTMLSpanElement;
const lowCount = document.getElementById("low-count") as HTMLSpanElement;
const totalCount = document.getElementById("total-count") as HTMLSpanElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openOptions(): void {
  browser.runtime.openOptionsPage();
}

function showState(state: "idle" | "filling" | "results" | "error"): void {
  statusArea.style.display = state === "filling" ? "flex" : "none";
  resultsArea.style.display = state === "results" ? "block" : "none";
  errorArea.style.display = state === "error" ? "block" : "none";
  fillBtn.disabled = state === "filling";
}

function showResults(summary: FillSummary): void {
  highCount.textContent = String(summary.highConfidence);
  medCount.textContent = String(summary.medConfidence);
  lowCount.textContent = String(summary.lowConfidence);
  totalCount.textContent = String(summary.totalFilled);
  clearBtn.style.display = "block";
  showState("results");
}

function showError(message: string): void {
  errorArea.textContent = `⚠️ ${message}`;
  showState("error");
}

function setStatus(text: string): void {
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// API key check
// ---------------------------------------------------------------------------

async function checkApiKey(): Promise<boolean> {
  const result = await browser.storage.local.get("llmSettings");
  const settings = result.llmSettings as LLMSettings | undefined;
  const hasKey = Boolean(settings?.apiKey);

  noKeyBanner.style.display = hasKey ? "none" : "block";
  fillBtn.disabled = !hasKey;
  return hasKey;
}

// ---------------------------------------------------------------------------
// Fill flow (wired fully in Task 7; skeleton here)
// ---------------------------------------------------------------------------

async function startFill(): Promise<void> {
  showState("filling");
  setStatus("Scanning page for questions…");

  try {
    // Get the active tab
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      showError("Could not access the active tab.");
      return;
    }

    // Retrieve resource context from session storage (populated in Task 6)
    const session = await browser.storage.local.get("resourceContext");
    const resourceContext = (session.resourceContext as string) ?? undefined;

    // Send FILL_PAGE to the content script on the active tab.
    // The content script will handle DOM extraction → AI_COMPLETE → injection.
    setStatus("Extracting questions…");
    const response = await browser.tabs.sendMessage(tab.id, {
      type: MessageType.FILL_PAGE,
      resourceContext,
    });

    if (response?.success) {
      showResults(response.summary as FillSummary);
    } else {
      showError(response?.error ?? "Unknown error during fill.");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // "Could not establish connection" means the content script isn't injected
    // (e.g. a chrome:// or about: page).
    if (msg.includes("Could not establish connection")) {
      showError("QuizFill can't run on this page (browser system page or empty tab).");
    } else {
      showError(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Clear resources
// ---------------------------------------------------------------------------

async function clearResources(): Promise<void> {
  await browser.storage.local.remove("resourceContext");
  showState("idle");
  clearBtn.style.display = "none";
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await checkApiKey();

  // Wire buttons
  fillBtn.addEventListener("click", startFill);
  settingsBtn.addEventListener("click", openOptions);
  setupLink.addEventListener("click", openOptions);
  clearBtn.addEventListener("click", clearResources);
});
