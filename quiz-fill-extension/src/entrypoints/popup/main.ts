/**
 * Popup — Tasks 1, 6 & 7 (complete implementation)
 *
 * State machine:
 *   idle      — waiting for user; fill button enabled if key present
 *   filling   — scanning → asking AI → injecting; button disabled
 *   no-fields — scan found nothing; amber notice shown
 *   results   — fill finished; confidence summary + re-fill + clear
 *   error     — something went wrong; red banner with friendly message
 *
 * Resource manager (Task 6):
 *   Text / File (PDF, DOCX, TXT) / URL tabs with live resource list
 */

import browser from "webextension-polyfill";
import {
  MessageType,
  type FetchUrlResult,
  type FillSummary,
  type LLMSettings,
  type Resource,
} from "../../lib/types.js";
import {
  loadResources,
  addResource,
  removeResource,
  clearResources,
  buildResourceContext,
  readFileAsArrayBuffer,
  readFileAsText,
  classifyFile,
  stripHtml,
} from "../../lib/resources.js";

// ---------------------------------------------------------------------------
// Lazy parsers
// ---------------------------------------------------------------------------

async function parsePdf(buffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    // The bundler emits the worker as a file inside the extension and gives
    // back its path; the popup is an extension page, so it can load it.
    const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return pages.join("\n\n");
}

async function parseDocx(buffer: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result  = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

// Core
const noKeyBanner   = document.getElementById("no-key-banner")   as HTMLDivElement;
const setupLink     = document.getElementById("setup-link")       as HTMLAnchorElement;
const settingsBtn   = document.getElementById("settings-btn")     as HTMLButtonElement;
const fillBtn       = document.getElementById("fill-btn")         as HTMLButtonElement;
const fillBtnLabel  = document.getElementById("fill-btn-label")   as HTMLSpanElement;
const statusArea    = document.getElementById("status-area")      as HTMLDivElement;
const statusText    = document.getElementById("status-text")      as HTMLSpanElement;
const progressSteps = document.getElementById("progress-steps")   as HTMLDivElement;
const stepScan      = document.getElementById("step-scan")        as HTMLDivElement;
const stepAi        = document.getElementById("step-ai")          as HTMLDivElement;
const stepFill      = document.getElementById("step-fill")        as HTMLDivElement;
const noFieldsArea  = document.getElementById("no-fields-area")   as HTMLDivElement;
const resultsArea   = document.getElementById("results-area")     as HTMLDivElement;
const errorArea     = document.getElementById("error-area")       as HTMLDivElement;
const highCount     = document.getElementById("high-count")       as HTMLSpanElement;
const medCount      = document.getElementById("med-count")        as HTMLSpanElement;
const lowCount      = document.getElementById("low-count")        as HTMLSpanElement;
const totalCount    = document.getElementById("total-count")      as HTMLSpanElement;
const fillErrors    = document.getElementById("fill-errors")      as HTMLDivElement;
const clearBtn      = document.getElementById("clear-btn")        as HTMLButtonElement;
const refillBtn     = document.getElementById("refill-btn")       as HTMLButtonElement;

// Resources
const resTabs       = document.querySelectorAll<HTMLButtonElement>(".res-tab");
const resPanels     = document.querySelectorAll<HTMLDivElement>(".res-panel");
const resCountBadge = document.getElementById("res-count-badge")  as HTMLSpanElement;
const resourceList  = document.getElementById("resource-list")    as HTMLDivElement;
const resTextInput  = document.getElementById("res-text-input")   as HTMLTextAreaElement;
const addTextBtn    = document.getElementById("add-text-btn")      as HTMLButtonElement;
const fileDropZone  = document.getElementById("file-drop-zone")   as HTMLDivElement;
const fileInput     = document.getElementById("file-input")        as HTMLInputElement;
const fileStatus    = document.getElementById("file-status")       as HTMLDivElement;
const resUrlInput   = document.getElementById("res-url-input")    as HTMLInputElement;
const addUrlBtn     = document.getElementById("add-url-btn")       as HTMLButtonElement;
const urlStatus     = document.getElementById("url-status")        as HTMLDivElement;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

type AppState = "idle" | "filling" | "no-fields" | "results" | "error";

let resources:    Resource[] = [];
let hasApiKey     = false;
let currentState: AppState = "idle";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function setState(state: AppState): void {
  currentState = state;

  const isFilling = state === "filling";

  // Visibility of each section
  statusArea.style.display   = isFilling       ? "flex"  : "none";
  progressSteps.style.display = isFilling       ? "flex"  : "none";
  noFieldsArea.style.display = state === "no-fields" ? "block" : "none";
  resultsArea.style.display  = state === "results"   ? "block" : "none";
  errorArea.style.display    = state === "error"     ? "block" : "none";

  // Fill button
  fillBtn.disabled = isFilling || !hasApiKey;
  fillBtnLabel.textContent =
    isFilling ? "Working…" :
    state === "results" ? "Fill Again" :
    "Fill This Page";
}

function setStep(step: "scan" | "ai" | "fill"): void {
  const steps = { scan: stepScan, ai: stepAi, fill: stepFill };
  const order = ["scan", "ai", "fill"] as const;
  const idx   = order.indexOf(step);

  order.forEach((s, i) => {
    const el = steps[s];
    el.className = "progress-step" + (i < idx ? " done" : i === idx ? " active" : "");
  });
  statusText.textContent =
    step === "scan" ? "Scanning page for questions…" :
    step === "ai"   ? "Asking AI for answers…"       :
                     "Filling fields…";
}

function showResults(summary: FillSummary): void {
  highCount.textContent  = String(summary.highConfidence);
  medCount.textContent   = String(summary.medConfidence);
  lowCount.textContent   = String(summary.lowConfidence);
  totalCount.textContent = String(summary.totalFilled);
  clearBtn.style.display = "block";

  if (summary.errors.length > 0) {
    fillErrors.style.display = "block";
    fillErrors.textContent   = `⚠ ${summary.errors.length} field(s) could not be filled: ` +
                               summary.errors.slice(0, 3).join("; ");
  } else {
    fillErrors.style.display = "none";
  }

  setState("results");
}

function showError(html: string): void {
  errorArea.innerHTML = `⚠️ ${html}`;
  setState("error");
}

// ---------------------------------------------------------------------------
// Friendly error classifier
// ---------------------------------------------------------------------------

function classifyError(msg: string): string {
  const m = msg.toLowerCase();

  if (m.includes("no fillable fields") || m.includes("no fields")) {
    // Handled separately via setState("no-fields")
    return "";
  }
  if (m.includes("invalid") && (m.includes("api key") || m.includes("key"))) {
    return `Invalid API key. <a id="err-settings-link">Update it in Settings →</a>`;
  }
  if (m.includes("rate limit") || m.includes("429") || m.includes("quota")) {
    // Pass the provider's message through; it says which limit was hit.
    return escHtml(msg.length > 400 ? msg.slice(0, 400) + "…" : msg);
  }
  if (m.includes("could not establish connection") || m.includes("receiving end does not exist")) {
    return "QuizFill can't run on this page (browser system page or empty tab).";
  }
  if (m.includes("network") || m.includes("fetch")) {
    return "Network error. Check your internet connection and try again.";
  }
  if (m.includes("active tab")) {
    return "Could not access the active tab. Try closing and reopening the extension.";
  }
  // Generic fallback — show the raw message but cap its length
  return escHtml(msg.length > 160 ? msg.slice(0, 160) + "…" : msg);
}

// ---------------------------------------------------------------------------
// API key check
// ---------------------------------------------------------------------------

async function checkApiKey(): Promise<boolean> {
  const result   = await browser.storage.local.get("llmSettings");
  const settings = result.llmSettings as LLMSettings | undefined;
  hasApiKey      = Boolean(settings?.apiKey);

  noKeyBanner.style.display = hasApiKey ? "none" : "block";
  // Only enable fill button if we're in idle/results state
  if (currentState !== "filling") {
    fillBtn.disabled = !hasApiKey;
  }
  return hasApiKey;
}

// ---------------------------------------------------------------------------
// Fill flow — full three-phase state machine
// ---------------------------------------------------------------------------

async function startFill(): Promise<void> {
  setState("filling");
  setStep("scan");

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      showError("Could not access the active tab.");
      return;
    }

    const resourceContext = buildResourceContext(resources) ?? undefined;

    // Phase 2: AI call (content script will scan + call AI + fill internally)
    setStep("ai");

    const response = (await browser.tabs.sendMessage(tab.id, {
      type: MessageType.FILL_PAGE,
      resourceContext,
    })) as { success: boolean; summary?: FillSummary; error?: string } | undefined;

    // Phase 3: filling (content script does this, we just update the step label)
    setStep("fill");

    // Small delay so user sees "Filling fields…" before we transition
    await new Promise<void>((r) => setTimeout(r, 400));

    if (!response) {
      showError("No response from the page. The content script may not have loaded yet — try refreshing the page.");
      return;
    }

    if (response.error === "No fillable fields detected on this page.") {
      setState("no-fields");
      return;
    }

    if (!response.success) {
      const friendly = classifyError(response.error ?? "Unknown error.");
      showError(friendly || (response.error ?? "Unknown error."));
      // Wire settings link inside error area if present
      document
        .getElementById("err-settings-link")
        ?.addEventListener("click", () => browser.runtime.openOptionsPage());
      return;
    }

    showResults(response.summary!);

  } catch (err: unknown) {
    const msg     = err instanceof Error ? err.message : String(err);
    const friendly = classifyError(msg);
    showError(friendly || msg);
    document
      .getElementById("err-settings-link")
      ?.addEventListener("click", () => browser.runtime.openOptionsPage());
  }
}

// ---------------------------------------------------------------------------
// Clear / reset
// ---------------------------------------------------------------------------

async function handleClearAll(): Promise<void> {
  await clearResources();
  resources = [];
  renderResourceList();
  setState("idle");
  clearBtn.style.display = "none";
  fillBtnLabel.textContent = "Fill This Page";
}

// ---------------------------------------------------------------------------
// Resource list renderer
// ---------------------------------------------------------------------------

function renderResourceList(): void {
  resourceList.innerHTML  = "";
  resCountBadge.textContent =
    resources.length > 0
      ? `${resources.length} resource${resources.length > 1 ? "s" : ""}`
      : "";

  for (const res of resources) {
    const item = document.createElement("div");
    item.className = "resource-item";

    const iconClass =
      res.type === "text" ? "ri-text" :
      res.type === "url"  ? "ri-url"  : "ri-file";
    const iconText =
      res.type === "text" ? "T"  :
      res.type === "url"  ? "🔗" : "📄";

    item.innerHTML = `
      <div class="resource-item-icon ${iconClass}">${iconText}</div>
      <div class="resource-item-label" title="${escAttr(res.label)}">${escHtml(res.label)}</div>
      <button class="resource-remove-btn" data-id="${escAttr(res.id)}" title="Remove">✕</button>
    `;
    item
      .querySelector<HTMLButtonElement>(".resource-remove-btn")!
      .addEventListener("click", async (e) => {
        const id = (e.currentTarget as HTMLButtonElement).dataset.id!;
        resources = await removeResource(id);
        renderResourceList();
      });

    resourceList.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function activateTab(tabName: string): void {
  resTabs.forEach((btn)   => btn.classList.toggle("active", btn.dataset.tab === tabName));
  resPanels.forEach((panel) =>
    panel.classList.toggle("active", panel.id === `panel-${tabName}`)
  );
}

// ---------------------------------------------------------------------------
// Text resource
// ---------------------------------------------------------------------------

async function handleAddText(): Promise<void> {
  const text = resTextInput.value.trim();
  if (!text) return;
  const label = text.slice(0, 40) + (text.length > 40 ? "…" : "");
  resources = await addResource("text", `Pasted text: ${label}`, text);
  resTextInput.value = "";
  renderResourceList();
}

// ---------------------------------------------------------------------------
// File resource
// ---------------------------------------------------------------------------

function setFileStatus(msg: string, kind: "ok" | "err" | "loading" | ""): void {
  fileStatus.textContent = msg;
  fileStatus.className   = kind;
}

async function handleFiles(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return;

  for (const file of Array.from(files)) {
    setFileStatus(`Processing ${file.name}…`, "loading");
    try {
      const kind = classifyFile(file);
      let text: string;

      if (kind === "pdf") {
        text = await parsePdf(await readFileAsArrayBuffer(file));
      } else if (kind === "docx") {
        text = await parseDocx(await readFileAsArrayBuffer(file));
      } else {
        text = await readFileAsText(file);
      }

      if (!text.trim()) {
        setFileStatus(`"${file.name}" appears empty or unreadable.`, "err");
        continue;
      }

      resources = await addResource("file", file.name, text);
      setFileStatus(`✓ Added "${file.name}"`, "ok");
      renderResourceList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFileStatus(`Failed to parse "${file.name}": ${msg}`, "err");
    }
  }
  fileInput.value = "";
}

// ---------------------------------------------------------------------------
// URL resource
// ---------------------------------------------------------------------------

function setUrlStatus(msg: string, kind: "ok" | "err" | ""): void {
  urlStatus.textContent = msg;
  urlStatus.className   = kind;
}

async function handleAddUrl(): Promise<void> {
  const url = resUrlInput.value.trim();
  if (!url) return;

  try { new URL(url); } catch {
    setUrlStatus("⚠ Please enter a valid URL.", "err");
    return;
  }

  addUrlBtn.disabled  = true;
  urlStatus.innerHTML =
    `<div style="width:12px;height:12px;border:2px solid var(--s3);` +
    `border-top-color:var(--p500);border-radius:50%;` +
    `animation:spin .65s linear infinite;flex-shrink:0"></div> Fetching…`;
  urlStatus.className = "";

  try {
    const result = (await browser.runtime.sendMessage({
      type: MessageType.FETCH_URL,
      url,
    })) as FetchUrlResult;

    if (!result.success || !result.text) {
      setUrlStatus(`⚠ ${result.error ?? "Could not fetch URL."}`, "err");
      return;
    }

    const plainText = stripHtml(result.text);
    if (!plainText.trim()) {
      setUrlStatus("⚠ Page returned no readable text.", "err");
      return;
    }

    const parsed = new URL(url);
    const label  = parsed.hostname + parsed.pathname.slice(0, 30);
    resources    = await addResource("url", label, plainText);
    resUrlInput.value = "";
    setUrlStatus(`✓ Added "${label}"`, "ok");
    renderResourceList();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setUrlStatus(`⚠ ${msg}`, "err");
  } finally {
    addUrlBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function escAttr(s: string): string {
  return s.replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  [resources] = await Promise.all([loadResources(), checkApiKey()]);
  renderResourceList();

  // Core buttons
  fillBtn.addEventListener("click", startFill);
  refillBtn.addEventListener("click", () => { setState("idle"); startFill(); });
  settingsBtn.addEventListener("click", () => browser.runtime.openOptionsPage());
  setupLink.addEventListener("click",   () => browser.runtime.openOptionsPage());
  clearBtn.addEventListener("click", handleClearAll);

  // Resource tabs
  resTabs.forEach((btn) =>
    btn.addEventListener("click", () => activateTab(btn.dataset.tab!))
  );

  // Text tab
  addTextBtn.addEventListener("click", handleAddText);
  resTextInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleAddText();
  });

  // File tab
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));
  fileDropZone.addEventListener("dragover",  (e) => { e.preventDefault(); fileDropZone.classList.add("drag-over"); });
  fileDropZone.addEventListener("dragleave", ()  => { fileDropZone.classList.remove("drag-over"); });
  fileDropZone.addEventListener("drop",      (e) => {
    e.preventDefault();
    fileDropZone.classList.remove("drag-over");
    handleFiles(e.dataTransfer?.files ?? null);
  });

  // URL tab
  addUrlBtn.addEventListener("click", handleAddUrl);
  resUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAddUrl();
  });
});
