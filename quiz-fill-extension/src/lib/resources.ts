/**
 * Resource Store — Task 6
 *
 * Manages the list of user-provided resources (text snippets, parsed file
 * contents, fetched URL text) that are included as context in every LLM call.
 *
 * Resources are persisted in chrome.storage.local under the key "resources"
 * so they survive popup close/reopen within the same browser session.
 *
 * The combined resourceContext string is built on demand by joining all
 * resource contents with clear section separators.
 */

import browser from "webextension-polyfill";
import type { Resource, ResourceType } from "./types.js";

const STORAGE_KEY = "resources";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

export async function loadResources(): Promise<Resource[]> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as Resource[]) ?? [];
}

export async function saveResources(resources: Resource[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: resources });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function addResource(
  type: ResourceType,
  label: string,
  content: string
): Promise<Resource[]> {
  const resources = await loadResources();
  const newResource: Resource = {
    id:      crypto.randomUUID(),
    type,
    label:   label.slice(0, 120),   // cap display label
    content: content.slice(0, 50_000), // cap per-resource to ~50k chars
  };
  const updated = [...resources, newResource];
  await saveResources(updated);
  return updated;
}

export async function removeResource(id: string): Promise<Resource[]> {
  const resources = await loadResources();
  const updated = resources.filter((r) => r.id !== id);
  await saveResources(updated);
  return updated;
}

export async function clearResources(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Combine all resource contents into a single string ready to include in
 * the LLM system prompt. Returns undefined if no resources exist.
 */
export function buildResourceContext(resources: Resource[]): string | undefined {
  if (resources.length === 0) return undefined;

  const sections = resources.map((r, i) => {
    const header = `[Resource ${i + 1}: ${r.label} (${r.type})]`;
    return `${header}\n${r.content}`;
  });

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// File parsing helpers (run in popup context, not service worker)
// ---------------------------------------------------------------------------

/**
 * Read a File as an ArrayBuffer using FileReader.
 * Compatible with extension popup contexts where fetch() on blob: URLs
 * may be restricted.
 */
export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`FileReader error: ${reader.error?.message}`));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Extract plain text from a plain-text file (txt, md, csv, etc.).
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`FileReader error: ${reader.error?.message}`));
    reader.readAsText(file);
  });
}

/**
 * Determine the resource type from a file's MIME type / extension.
 */
export function classifyFile(file: File): "pdf" | "docx" | "text" {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  )
    return "docx";
  return "text";
}

// ---------------------------------------------------------------------------
// HTML stripping (for fetched URL text)
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from a string, collapse whitespace, and return plain text.
 * Used client-side to process HTML returned by FETCH_URL.
 */
export function stripHtml(html: string): string {
  // Use DOMParser to safely parse — no script execution risk
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Remove scripts, styles, nav, header, footer — keep readable content
    doc.querySelectorAll(
      "script,style,noscript,nav,header,footer,aside,iframe,svg"
    ).forEach((el) => el.remove());
    return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  } catch {
    // Fallback: regex strip
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}
