/**
 * DOM Question Extractor
 *
 * Scans the page for fillable form fields and returns ExtractedQuestion
 * objects the LLM can reason about.
 *
 * Where it looks
 * ──────────────
 * The main document, every OPEN shadow root, and every same-origin iframe,
 * recursively. Closed shadow roots and cross-origin iframes are not reachable
 * from a content script and are skipped. Each field gets a locator (see
 * locator.ts) that says how to reach it again from the top document.
 *
 * Per field
 * ─────────
 * 1. Skip hidden, disabled, and decorative fields.
 * 2. Resolve the best label: <label for>, wrapping label, aria-label,
 *    aria-labelledby, title, placeholder, the label on a custom-element host,
 *    then the nearest text above the field (climbing out of shadow roots).
 * 3. Group radios by `name` within their root; they form one question.
 * 4. Give every question a fieldId that is unique across the whole page.
 *
 * The extractor never modifies the DOM.
 */

import type { ExtractedQuestion, FieldType, SelectOption } from "./types.js";
import { LOCATOR_SEP } from "./locator.js";

type Root = Document | ShadowRoot;

interface Scope {
  root: Root;
  /** Hops from the top document to this root (frame and shadow-host selectors). */
  prefix: string[];
}

const MAX_DEPTH  = 8;    // nesting limit for shadow roots / iframes
const MAX_SCOPES = 500;  // safety cap on pages with huge component trees

const CANDIDATE_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"])' +
  ':not([type="reset"]):not([type="image"]):not([type="file"])' +
  ':not([type="color"]):not([type="range"]):not([type="search"]),' +
  "select," +
  "textarea";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractQuestions(): ExtractedQuestion[] {
  const questions: ExtractedQuestion[] = [];
  const usedIds = new Set<string>();
  let index = 0;

  const uniqueId = (base: string): string => {
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };

  for (const scope of collectScopes()) {
    const seenRadioGroups = new Set<string>();
    const locate = (selector: string): string => [...scope.prefix, selector].join(LOCATOR_SEP);

    const candidates = scope.root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR);

    for (const el of Array.from(candidates)) {
      if (!isVisible(el) || isDisabled(el)) continue;

      const tagName   = el.tagName.toLowerCase();
      const inputType = (el as HTMLInputElement).type?.toLowerCase() ?? "";

      // ── Radio group ───────────────────────────────────────────────────
      if (tagName === "input" && inputType === "radio") {
        const name = (el as HTMLInputElement).name;
        if (!name || seenRadioGroups.has(name)) continue;
        seenRadioGroups.add(name);

        const groupSelector = `input[type="radio"][name="${CSS.escape(name)}"]`;
        const radioGroup = Array.from(
          scope.root.querySelectorAll<HTMLInputElement>(groupSelector)
        ).filter(isVisible);
        if (radioGroup.length === 0) continue;

        const options: SelectOption[] = radioGroup.map((r) => ({
          value: r.value,
          label: resolveLabel(r) || r.value,
        }));

        const groupLabel =
          resolveGroupLabel(radioGroup[0]) ||
          resolveLabel(radioGroup[0]) ||
          `Question ${++index}`;

        questions.push({
          fieldId: uniqueId(`radio-${sanitizeId(name)}`),
          type: "radio",
          labelText: groupLabel,
          options,
          selector: locate(groupSelector),
        });
        continue;
      }

      // ── Checkbox ──────────────────────────────────────────────────────
      if (tagName === "input" && inputType === "checkbox") {
        const label = resolveLabel(el) || `Checkbox ${++index}`;
        questions.push({
          fieldId: uniqueId(buildFieldId(el, `checkbox-${index}`)),
          type: "checkbox",
          labelText: label,
          options: [
            { value: "true",  label: "Check (yes)" },
            { value: "false", label: "Uncheck (no)" },
          ],
          selector: locate(buildSelector(el)),
        });
        continue;
      }

      // ── Select (dropdown) ─────────────────────────────────────────────
      if (tagName === "select") {
        const options: SelectOption[] = Array.from((el as HTMLSelectElement).options)
          .filter((o) => o.value !== "" && o.value !== "--" && o.value !== "0")
          .map((o) => ({ value: o.value, label: o.text.trim() }));
        if (options.length === 0) continue;

        const label = resolveLabel(el) || `Select ${++index}`;
        questions.push({
          fieldId: uniqueId(buildFieldId(el, `select-${index}`)),
          type: "select",
          labelText: label,
          options,
          selector: locate(buildSelector(el)),
        });
        continue;
      }

      // ── Textarea ──────────────────────────────────────────────────────
      if (tagName === "textarea") {
        const label = resolveLabel(el) || `Text area ${++index}`;
        questions.push({
          fieldId: uniqueId(buildFieldId(el, `textarea-${index}`)),
          type: "textarea",
          labelText: label,
          selector: locate(buildSelector(el)),
        });
        continue;
      }

      // ── Text-like inputs ──────────────────────────────────────────────
      if (tagName === "input") {
        const label = resolveLabel(el) || `Field ${++index}`;
        questions.push({
          fieldId: uniqueId(buildFieldId(el, `input-${index}`)),
          type: normaliseInputType(inputType),
          labelText: label,
          selector: locate(buildSelector(el)),
        });
      }
    }
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Finding every root to search
// ---------------------------------------------------------------------------

function collectScopes(): Scope[] {
  const scopes: Scope[] = [];

  const visit = (root: Root, prefix: string[], depth: number): void => {
    if (scopes.length >= MAX_SCOPES) return;
    scopes.push({ root, prefix });
    if (depth >= MAX_DEPTH) return;

    for (const el of Array.from(root.querySelectorAll("*"))) {
      const shadow = el.shadowRoot;
      if (shadow) {
        visit(shadow, [...prefix, buildSelector(el as HTMLElement)], depth + 1);
      }

      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let doc: Document | null = null;
        try {
          doc = (el as HTMLIFrameElement).contentDocument; // null when cross-origin
        } catch {
          doc = null;
        }
        if (doc && isVisible(el)) {
          visit(doc, [...prefix, buildSelector(el as HTMLElement)], depth + 1);
        }
      }
    }
  };

  visit(document, [], 0);
  return scopes;
}

// ---------------------------------------------------------------------------
// Visibility / disability checks
// ---------------------------------------------------------------------------

function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  // Use the element's own window: it may live in an iframe.
  const win = el.ownerDocument.defaultView;
  if (!win) return false;

  const style = win.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if ((el as HTMLInputElement).type === "hidden") return false;

  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function isDisabled(el: HTMLElement): boolean {
  return (
    (el as HTMLInputElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true" ||
    el.closest("fieldset[disabled]") !== null
  );
}

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

function rootOf(el: Element): Root {
  return el.getRootNode() as Root;
}

/** The shadow host if `el` lives in a shadow root, otherwise null. */
function shadowHostOf(el: Element): Element | null {
  const root = el.getRootNode() as Partial<ShadowRoot>;
  return root.host ?? null;
}

/** Parent element, climbing out of a shadow root to its host. */
function parentOf(el: Element): Element | null {
  return el.parentElement ?? shadowHostOf(el);
}

function resolveLabel(el: HTMLElement): string {
  const root = rootOf(el);

  // 1. Explicit <label for="id"> in the same root
  if (el.id) {
    try {
      const labelEl = root.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) {
        const text = getTextContent(labelEl);
        if (text) return text;
      }
    } catch { /* invalid selector, fall through */ }
  }

  // 2. Wrapping <label>
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) {
    const clone = wrappingLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input,select,textarea").forEach((n) => n.remove());
    const text = getTextContent(clone);
    if (text) return text;
  }

  // 3. aria-label
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  // 4. aria-labelledby (ids resolve within the same root)
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => root.getElementById(id))
      .filter((n): n is HTMLElement => n !== null)
      .map(getTextContent)
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }

  // 5. title
  const title = el.getAttribute("title")?.trim();
  if (title) return title;

  // 6. placeholder
  const placeholder = (el as HTMLInputElement).placeholder?.trim();
  if (placeholder) return placeholder;

  // 7. Custom elements usually carry their label on the host element
  const hostLabel = labelFromShadowHost(el);
  if (hostLabel) return hostLabel;

  // 8. Nearest text above the field
  return walkUpForLabel(el);
}

function labelFromShadowHost(el: Element): string {
  const host = shadowHostOf(el);
  if (!host) return "";

  const attr = (host.getAttribute("label") || host.getAttribute("aria-label") || "").trim();
  if (attr) return attr;

  const text = getTextContent(host);
  return text.length > 0 && text.length < 200 ? text : "";
}

/** Label for a radio group (the question), not for one option. */
function resolveGroupLabel(firstRadio: HTMLElement): string {
  const root = rootOf(firstRadio);

  const fieldset = firstRadio.closest("fieldset");
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend) {
      const text = getTextContent(legend);
      if (text) return text;
    }
  }

  const group = firstRadio.closest('[role="group"],[role="radiogroup"]');
  if (group) {
    const al = group.getAttribute("aria-label")?.trim();
    if (al) return al;

    const lby = group.getAttribute("aria-labelledby");
    if (lby) {
      const ref = root.getElementById(lby);
      if (ref) {
        const text = getTextContent(ref);
        if (text) return text;
      }
    }
  }

  return walkUpForLabel(firstRadio);
}

/**
 * Climb from `el` looking for nearby label-like text: earlier siblings at each
 * level, then the parent's own text. Crosses shadow-root boundaries via the host.
 */
function walkUpForLabel(el: Element): string {
  const STOP_TAGS  = new Set(["form", "fieldset", "body", "html"]);
  const LABEL_TAGS = new Set(["label", "legend", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "div", "li"]);

  let current: Element = el;
  let node: Element | null = parentOf(el);
  let depth = 0;

  while (node && depth < 6) {
    // Read the earlier siblings first, even when the parent is a form or body:
    // a question is often a <p> sitting directly above the field.
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      if (LABEL_TAGS.has(sibling.tagName.toLowerCase())) {
        const text = getTextContent(sibling);
        if (text && text.length < 300) return text;
      }
      sibling = sibling.previousElementSibling;
    }

    // Do not climb past a form, fieldset or body.
    if (STOP_TAGS.has(node.tagName.toLowerCase())) break;

    if (node.children.length <= 3) {
      const clone = node.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
      const text = getTextContent(clone);
      if (text && text.length > 2 && text.length < 300) return text;
    }

    current = node;
    node = parentOf(node);
    depth++;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseInputType(inputType: string): FieldType {
  switch (inputType) {
    case "email":  return "email";
    case "number": return "number";
    case "tel":    return "tel";
    default:       return "text"; // date, url, week, month → treat as text
  }
}

/**
 * A selector for `el` that is unique within its own root. Prefers #id, then
 * tag[name], and falls back to an index path ("@0/3/1") when neither is unique.
 */
function buildSelector(el: Element): string {
  const root = rootOf(el);

  const isUnique = (sel: string): boolean => {
    try {
      const found = root.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  };

  if (el.id) {
    const sel = `#${CSS.escape(el.id)}`;
    if (isUnique(sel)) return sel;
  }

  const tag  = el.tagName.toLowerCase();
  const name = (el as HTMLInputElement).name;
  if (name) {
    const type = (el as HTMLInputElement).type;
    const sel = type
      ? `${tag}[type="${type}"][name="${CSS.escape(name)}"]`
      : `${tag}[name="${CSS.escape(name)}"]`;
    if (isUnique(sel)) return sel;
  }

  return indexPath(el, root);
}

/** Element-child index at each level from `root` down to `el`. */
function indexPath(el: Element, root: Root): string {
  const parts: number[] = [];
  let node: Element = el;

  for (;;) {
    const parent = node.parentNode as ParentNode | null;
    if (!parent) break;
    parts.unshift(Array.prototype.indexOf.call(parent.children, node));
    if (parent === root) break;
    node = parent as Element;
  }
  return "@" + parts.join("/");
}

function buildFieldId(el: HTMLElement, fallback: string): string {
  if (el.id)                         return sanitizeId(el.id);
  if ((el as HTMLInputElement).name) return sanitizeId((el as HTMLInputElement).name);
  return fallback;
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function getTextContent(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}
