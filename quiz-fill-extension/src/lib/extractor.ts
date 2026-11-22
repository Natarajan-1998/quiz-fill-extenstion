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
          label: resolveOptionLabel(r, radioGroup) || r.value,
        }));

        const groupLabel = resolveGroupLabel(radioGroup) || `Question ${++index}`;

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
// Reading text (shadow-DOM aware)
// ---------------------------------------------------------------------------

/** Elements whose content is never label text. */
const TEXTLESS_TAGS = new Set([
  "style", "script", "noscript", "template", "svg",
  "input", "select", "textarea", "button",
]);

const MAX_LABEL_CHARS  = 1000;
const MAX_OPTION_CHARS = 300;

/**
 * Collect the text a user would see under `node`, reading INTO open shadow
 * roots. textContent cannot do this: for a web component such as
 * <d2l-html-block> it returns "" because the text lives in its shadow root.
 * Slots are followed to the light-DOM nodes assigned to them.
 */
function collectText(node: Node, out: string[], depth: number): void {
  if (depth > 60) return;

  if (node.nodeType === 3) {
    const t = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
    return;
  }
  if (node.nodeType === 11) {
    node.childNodes.forEach((c) => collectText(c, out, depth + 1));
    return;
  }
  if (node.nodeType !== 1) return;

  const el  = node as Element;
  const tag = el.tagName.toLowerCase();
  // Our own confidence badges must never leak into labels on a re-fill.
  if (TEXTLESS_TAGS.has(tag) || el.hasAttribute("data-quizfill-badge")) return;

  if (tag === "slot") {
    const slot = el as HTMLSlotElement;
    const assigned = typeof slot.assignedNodes === "function" ? slot.assignedNodes({ flatten: true }) : [];
    const nodes = assigned.length > 0 ? assigned : Array.from(el.childNodes);
    nodes.forEach((c) => collectText(c, out, depth + 1));
    return;
  }

  // A shadow host renders its shadow tree, not its light children.
  const children = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
  children.forEach((c) => collectText(c, out, depth + 1));
}

/**
 * Visible text under `node`. Consecutive repeats are always dropped; with
 * `dedupe`, any repeated piece is dropped (widgets often repeat an option's
 * text in hidden helper elements).
 */
function deepText(node: Node, dedupe = false): string {
  const pieces: string[] = [];
  collectText(node, pieces, 0);

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    if (dedupe ? seen.has(piece) : kept[kept.length - 1] === piece) continue;
    seen.add(piece);
    kept.push(piece);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

function getTextContent(el: Element): string {
  return deepText(el).slice(0, MAX_LABEL_CHARS);
}

/** True for text hidden with the "screen reader only" technique (1px box). */
function isVisuallyHidden(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width <= 2 || rect.height <= 2;
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

/** Labels the page states outright: <label>, aria-*, title. No guessing. */
function resolveExplicitLabel(el: HTMLElement): string {
  const root = rootOf(el);

  // <label for="id"> in the same root
  if (el.id) {
    try {
      const labelEl = root.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) {
        const text = getTextContent(labelEl);
        if (text) return text;
      }
    } catch { /* invalid selector, fall through */ }
  }

  // Wrapping <label> (form controls inside it are skipped by deepText)
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) {
    const text = getTextContent(wrappingLabel);
    if (text) return text;
  }

  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  // aria-labelledby (ids resolve within the same root)
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

  return el.getAttribute("title")?.trim() ?? "";
}

/** Best label for a single (non-radio) field, guessing from context if needed. */
function resolveLabel(el: HTMLElement): string {
  return (
    resolveExplicitLabel(el) ||
    (el as HTMLInputElement).placeholder?.trim() ||
    labelFromShadowHost(el) ||
    walkUpForLabel(el)
  );
}

/** Custom elements usually carry their label on the host element. */
function labelFromShadowHost(el: Element): string {
  const host = shadowHostOf(el);
  if (!host) return "";

  const attr = (host.getAttribute("label") || host.getAttribute("aria-label") || "").trim();
  if (attr) return attr;

  const text = getTextContent(host);
  return text.length > 0 && text.length < 200 ? text : "";
}

// ── Radio groups ───────────────────────────────────────────────────────────

/**
 * The smallest ancestor of `radio` that holds no other radio of its group:
 * the "row" of one option (a <tr>, a <label>, a <div>), however deep the
 * radio sits inside it.
 */
function optionContainer(radio: HTMLInputElement, group: HTMLInputElement[]): Element {
  let node: Element = radio;
  for (let i = 0; i < 6; i++) {
    const parent = node.parentElement;
    if (!parent) break;
    if (group.some((r) => r !== radio && parent.contains(r))) break;
    node = parent;
  }
  return node;
}

/** Text after the radio up to the next control or line break. */
function followingText(el: Element): string {
  const parts: string[] = [];
  for (let n = el.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === 1) {
      const tag = (n as Element).tagName.toLowerCase();
      if (tag === "br" || tag === "input" || tag === "select" || tag === "textarea") break;
    }
    const text = deepText(n);
    if (text) parts.push(text);
    if (parts.join(" ").length > MAX_OPTION_CHARS) break;
  }
  return parts.join(" ").slice(0, MAX_OPTION_CHARS);
}

/** The text of ONE option of a radio group (not the question). */
function resolveOptionLabel(radio: HTMLInputElement, group: HTMLInputElement[]): string {
  const explicit = resolveExplicitLabel(radio);
  if (explicit) return explicit;

  const container = optionContainer(radio, group);
  if (container !== radio) {
    const text = deepText(container, true).slice(0, MAX_OPTION_CHARS);
    if (text) return text;
  }
  return followingText(radio);
}

/** The question a radio group answers (not any one option). */
function resolveGroupLabel(group: HTMLInputElement[]): string {
  const first = group[0];
  const root  = rootOf(first);

  // fieldset > legend, unless the legend is visually hidden. Quiz widgets
  // often hide a generic "Question 1 options:" legend while the real question
  // sits above the fieldset; keep the legend only as a last resort.
  const fieldset = first.closest("fieldset");
  let hiddenLegend = "";
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend) {
      const text = getTextContent(legend);
      if (text) {
        if (!isVisuallyHidden(legend)) return text;
        hiddenLegend = text;
      }
    }
  }

  const aria = first.closest('[role="group"],[role="radiogroup"]');
  if (aria) {
    const al = aria.getAttribute("aria-label")?.trim();
    if (al) return al;

    const lby = aria.getAttribute("aria-labelledby");
    if (lby) {
      const ref = root.getElementById(lby);
      if (ref) {
        const text = getTextContent(ref);
        if (text) return text;
      }
    }
  }

  // The question is the text just above the fieldset (or above the first option).
  const stem = walkUpForLabel(fieldset ?? optionContainer(first, group));
  return stem || hiddenLegend;
}

/**
 * Climb from `el` looking for nearby label-like text: earlier siblings at each
 * level, then the parent's own text. Crosses shadow-root boundaries via the host.
 * Siblings that contain form controls belong to other fields and are skipped.
 */
function walkUpForLabel(el: Element): string {
  const STOP_TAGS  = new Set(["form", "fieldset", "body", "html"]);
  const LABEL_TAGS = new Set(["label", "legend", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "div", "li"]);
  // Custom elements (tag names with a hyphen) often hold the question text.
  const isLabelLike = (tag: string): boolean => LABEL_TAGS.has(tag) || tag.includes("-");

  let current: Element = el;
  let node: Element | null = parentOf(el);
  let depth = 0;

  while (node && depth < 6) {
    // Read the earlier siblings first, even when the parent is a form or body:
    // a question is often a <p> sitting directly above the field.
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      if (isLabelLike(sibling.tagName.toLowerCase()) && !sibling.querySelector("input,select,textarea")) {
        const text = getTextContent(sibling);
        if (text && text.length < 800) return text;
      }
      sibling = sibling.previousElementSibling;
    }

    // Do not climb past a form, fieldset or body.
    if (STOP_TAGS.has(node.tagName.toLowerCase())) break;

    if (node.children.length <= 3) {
      const text = getTextContent(node);
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
