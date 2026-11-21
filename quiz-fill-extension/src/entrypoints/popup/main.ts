/**
 * Popup — Tasks 1, 6 & 7
 *
 * Handles:
 *  - Task 1/7: API-key check, fill-flow state machine
 *  - Task 6:   Resource manager (text, file upload, URL fetch, resource list)
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
// Lazy-loaded parsers (pdfjs-dist and mammoth are heavy — load on demand)
// ---------------------------------------------------------------------------

async function parsePdf(buffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  // Point the worker at the bundled worker file (declared in web_accessible_resources)
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");
  }
  const pdf   = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
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
const noKeyBanner  = document.getElementById("no-key-banner")  as HTMLDivElement;
const setupLink    = document.getElementById("setup-link")      as HTMLAnchorElement;
const settingsBtn  = document.getElementById("settings-btn")    as HTMLButtonElement;
const fillBtn      = document.getElementById("fill-btn")        as HTMLButtonElement;
const statusArea   = document.getElementById("status-area")     as HTMLDivElement;
const statusText   = document.getElementById("status-text")     as HTMLSpanElement;
const resultsArea  = document.getElementById("results-area")    as HTMLDivElement;
const errorArea    = document.getElementById("error-area")      as HTMLDivElement;
const highCount    = document.getElementById("high-count")      as HTMLSpanElement;
const medCount     = document.getElementById("med-count")       as HTMLSpanElement;
const lowCount     = document.getElementById("low-count")       as HTMLSpanElement;
const totalCount   = document.getElementById("total-count")     as HTMLSpanElement;
const clearBtn     = document.getElementById("clear-btn")       as HTMLButtonElement;

// Resources
const resTabs       = document.querySelectorAll<HTMLButtonElement>(".res-tab");
const resPanels     = document.querySelectorAll<HTMLDivElement>(".res-panel");
const resCountBadge = document.getElementById("res-count-badge")  as HTMLSpanElement;
const resourceList  = document.getElementById("resource-list")    as HTMLDivElement;

// Text tab
const resTextInput  = document.getElementById("res-text-input")  as HTMLTextAreaElement;
const addTextBtn    = document.getElementById("add-text-btn")     as HTMLButtonElement;

// File tab
const fileDropZone  = document.getElementById("file-drop-zone")  as HTMLDivElement;
const fileInput     = document.getElementById("file-input")       as HTMLInputElement;
const fileStatus    = document.getElementById("file-status")      as HTMLDivElement;

// URL tab
const resUrlInput   = document.getElementById("res-url-input")   as HTMLInputElement;
const addUrlBtn     = document.getElementById("add-url-btn")      as HTMLButtonElement;
const urlStatus     = document.getElementById("url-status")       as HTMLDivElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let resources: Resource[] = [];

// ---------------------------------------------------------------------------
// Core UI state machine
// ---------------------------------------------------------------------------

function showState(state: "idle" | "filling" | "results" | "error"): void {
  statusArea.style.display  = state === "filling" ? "flex"  : "none";
  resultsArea.style.display = state === "results" ? "block" : "none";
  errorArea.style.display   = state === "error"   ? "block" : "none";
  fillBtn.disabled           = state === "filling";
}

function showResults(summary: FillSummary): void {
  highCount.textContent  = String(summary.highConfidence);
  medCount.textContent   = String(summary.medConfidence);
  lowCount.textContent   = String(summary.lowConfidence);
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
  const result   = await browser.storage.local.get("llmSettings");
  const settings = result.llmSettings as LLMSettings | undefined;
  const hasKey   = Boolean(settings?.apiKey);

  noKeyBanner.style.display = hasKey ? "none" : "block";
  fillBtn.disabled           = !hasKey;
  return hasKey;
}

// ---------------------------------------------------------------------------
// Fill flow
// ---------------------------------------------------------------------------

async function startFill(): Promise<void> {
  showState("filling");
  setStatus("Scanning page for questions…");

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { showError("Could not access the active tab."); return; }

    const resourceContext = buildResourceContext(resources) ?? undefined;

    setStatus("Asking AI for answers…");
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
    if (msg.includes("Could not establish connection")) {
      showError("QuizFill can't run on this page (browser system page or empty tab).");
    } else {
      showError(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Resource list renderer
// ---------------------------------------------------------------------------

function renderResourceList(): void {
  resourceList.innerHTML = "";

  resCountBadge.textContent =
    resources.length > 0 ? `${resources.length} resource${resources.length > 1 ? "s" : ""}` : "";

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
      <div class="resource-item-label" title="${escapeAttr(res.label)}">${escapeHtml(res.label)}</div>
      <button class="resource-remove-btn" data-id="${escapeAttr(res.id)}" title="Remove">✕</button>
    `;

    item.querySelector(".resource-remove-btn")?.addEventListener("click", async (e) => {
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
  resTabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabName));
  resPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${tabName}`);
  });
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
        const buffer = await readFileAsArrayBuffer(file);
        text = await parsePdf(buffer);
      } else if (kind === "docx") {
        const buffer = await readFileAsArrayBuffer(file);
        text = await parseDocx(buffer);
      } else {
        text = await readFileAsText(file);
      }

      if (!text.trim()) {
        setFileStatus(`"${file.name}" appears to be empty or unreadable.`, "err");
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

  // Reset input so the same file can be re-added after removal
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

  // Basic client-side validation before hitting the network
  try { new URL(url); } catch {
    setUrlStatus("⚠ Please enter a valid URL.", "err");
    return;
  }

  addUrlBtn.disabled = true;
  urlStatus.innerHTML = `<div style="width:12px;height:12px;border:2px solid var(--s3);border-top-color:var(--p500);border-radius:50%;animation:spin .65s linear infinite;flex-shrink:0"></div> Fetching…`;
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

    const label = new URL(url).hostname + new URL(url).pathname.slice(0, 30);
    resources = await addResource("url", label, plainText);
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
// Clear all resources
// ---------------------------------------------------------------------------

async function handleClearAll(): Promise<void> {
  await clearResources();
  resources = [];
  renderResourceList();
  showState("idle");
  clearBtn.style.display = "none";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function escapeAttr(s: string): string {
  return s.replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  // Load persisted resources and API key
  [resources] = await Promise.all([loadResources(), checkApiKey()]);
  renderResourceList();

  // Core buttons
  fillBtn.addEventListener("click", startFill);
  settingsBtn.addEventListener("click", () => browser.runtime.openOptionsPage());
  setupLink.addEventListener("click", () => browser.runtime.openOptionsPage());
  clearBtn.addEventListener("click", handleClearAll);

  // Tab switching
  resTabs.forEach((btn) =>
    btn.addEventListener("click", () => activateTab(btn.dataset.tab!))
  );

  // Text tab
  addTextBtn.addEventListener("click", handleAddText);
  resTextInput.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+Enter to add
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleAddText();
  });

  // File tab — click and drag-drop
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));

  fileDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    fileDropZone.classList.add("drag-over");
  });
  fileDropZone.addEventListener("dragleave", () => {
    fileDropZone.classList.remove("drag-over");
  });
  fileDropZone.addEventListener("drop", (e) => {
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
