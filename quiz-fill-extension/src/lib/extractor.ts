/**
 * DOM Question Extractor — Task 4
 *
 * Scans the current page for fillable form fields and returns a structured
 * array of ExtractedQuestion objects that the LLM can reason about.
 *
 * Strategy
 * ────────
 * 1. Collect every visible, interactable input, select, and textarea.
 * 2. Resolve the best human-readable label for each field by checking
 *    (in order): <label for=id>, aria-label, aria-labelledby, title,
 *    placeholder, closest fieldset legend, then walking up the DOM tree
 *    for the nearest non-empty heading or paragraph.
 * 3. Group radio buttons by their `name` attribute — they form one question.
 * 4. Assign a stable fieldId to each question for round-tripping with the LLM.
 * 5. Skip hidden, disabled, and purely decorative fields.
 *
 * The extractor runs entirely in the content script's isolated world and
 * never modifies the DOM.
 */

import type { ExtractedQuestion, FieldType, SelectOption } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractQuestions(): ExtractedQuestion[] {
  const questions: ExtractedQuestion[] = [];
  const seenRadioGroups = new Set<string>(); // track radio `name` groups
  const seenSelectors   = new Set<string>(); // skip duplicate elements

  // Query all candidate elements in DOM order
  const candidates = document.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"])' +
    ':not([type="reset"]):not([type="image"]):not([type="file"])' +
    ':not([type="color"]):not([type="range"]):not([type="search"]),' +
    "select," +
    "textarea"
  );

  let index = 0;

  for (const el of Array.from(candidates)) {
    if (!isVisible(el) || isDisabled(el)) continue;

    const selector = buildSelector(el);
    if (seenSelectors.has(selector)) continue;
    seenSelectors.add(selector);

    const tagName = el.tagName.toLowerCase();
    const inputType = (el as HTMLInputElement).type?.toLowerCase() ?? "";

    // ── Radio button group ──────────────────────────────────────────────
    if (tagName === "input" && inputType === "radio") {
      const name = (el as HTMLInputElement).name;
      if (!name || seenRadioGroups.has(name)) continue;
      seenRadioGroups.add(name);

      const radioGroup = Array.from(
        document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`)
      ).filter(isVisible);

      if (radioGroup.length === 0) continue;

      const options: SelectOption[] = radioGroup.map((r) => ({
        value: r.value,
        label: resolveLabel(r) || r.value,
      }));

      // Label for the whole group: try the first radio's label, then the
      // nearest fieldset legend, then a heading above the group
      const groupLabel =
        resolveGroupLabel(radioGroup[0]) ||
        resolveLabel(radioGroup[0]) ||
        `Question ${++index}`;

      questions.push({
        fieldId: `radio-${sanitizeId(name)}`,
        type: "radio",
        labelText: groupLabel,
        options,
        selector: `input[type="radio"][name="${CSS.escape(name)}"]`,
      });
      continue;
    }

    // ── Checkbox ────────────────────────────────────────────────────────
    if (tagName === "input" && inputType === "checkbox") {
      const label = resolveLabel(el) || `Checkbox ${++index}`;
      const id = buildFieldId(el, `checkbox-${index}`);

      questions.push({
        fieldId: id,
        type: "checkbox",
        labelText: label,
        options: [
          { value: "true",  label: "Check (yes)" },
          { value: "false", label: "Uncheck (no)" },
        ],
        selector,
      });
      continue;
    }

    // ── Select (dropdown) ───────────────────────────────────────────────
    if (tagName === "select") {
      const selectEl = el as HTMLSelectElement;
      const options: SelectOption[] = Array.from(selectEl.options)
        .filter((o) => o.value !== "" && o.value !== "--" && o.value !== "0")
        .map((o) => ({ value: o.value, label: o.text.trim() }));

      if (options.length === 0) continue; // skip empty selects (e.g. dynamic)

      const label = resolveLabel(el) || `Select ${++index}`;
      const id = buildFieldId(el, `select-${index}`);

      questions.push({
        fieldId: id,
        type: "select",
        labelText: label,
        options,
        selector,
      });
      continue;
    }

    // ── Textarea ────────────────────────────────────────────────────────
    if (tagName === "textarea") {
      const label = resolveLabel(el) || `Text area ${++index}`;
      const id = buildFieldId(el, `textarea-${index}`);

      questions.push({
        fieldId: id,
        type: "textarea",
        labelText: label,
        selector,
      });
      continue;
    }

    // ── Text-like inputs (text, email, number, tel, url, date, etc.) ────
    if (tagName === "input") {
      const type = normaliseInputType(inputType);
      const label = resolveLabel(el) || `Field ${++index}`;
      const id = buildFieldId(el, `input-${index}`);

      questions.push({
        fieldId: id,
        type,
        labelText: label,
        selector,
      });
    }
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Visibility / disability checks
// ---------------------------------------------------------------------------

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if ((el as HTMLInputElement).type === "hidden") return false;
  // Ignore truly zero-dimension elements (decorative spacers)
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

/**
 * Resolve the best human-readable label for a single form element.
 * Checks multiple sources in priority order.
 */
function resolveLabel(el: HTMLElement): string {
  // 1. Explicit <label for="id">
  if (el.id) {
    const labelEl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (labelEl) {
      const text = getTextContent(labelEl);
      if (text) return text;
    }
  }

  // 2. Wrapping <label> ancestor
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) {
    // Clone and remove the input itself to get just the label text
    const clone = wrappingLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input,select,textarea").forEach((n) => n.remove());
    const text = getTextContent(clone);
    if (text) return text;
  }

  // 3. aria-label attribute
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  // 4. aria-labelledby → concatenate referenced elements' text
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((ref) => getTextContent(ref!))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }

  // 5. title attribute
  const title = el.getAttribute("title")?.trim();
  if (title) return title;

  // 6. placeholder (weakest inline hint)
  const placeholder = (el as HTMLInputElement).placeholder?.trim();
  if (placeholder) return placeholder;

  // 7. Walk up the DOM looking for a nearby label-like text
  return walkUpForLabel(el);
}

/**
 * Resolve the label for a radio group (the question being asked),
 * not for the individual option.
 * Checks: fieldset > legend, then role="group" aria-label, then
 * the nearest heading/paragraph before the first radio.
 */
function resolveGroupLabel(firstRadio: HTMLElement): string {
  // fieldset > legend
  const fieldset = firstRadio.closest("fieldset");
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend) {
      const text = getTextContent(legend);
      if (text) return text;
    }
  }

  // role="group" or role="radiogroup" with aria-label / aria-labelledby
  const group = firstRadio.closest('[role="group"],[role="radiogroup"]');
  if (group) {
    const al = group.getAttribute("aria-label")?.trim();
    if (al) return al;

    const lby = group.getAttribute("aria-labelledby");
    if (lby) {
      const ref = document.getElementById(lby);
      if (ref) {
        const text = getTextContent(ref);
        if (text) return text;
      }
    }
  }

  // Walk up for heading/paragraph — same as individual fields
  return walkUpForLabel(firstRadio);
}

/**
 * Walk up the DOM tree from `el` looking for the nearest non-empty
 * heading (h1–h6) or paragraph/div that appears to be a question label.
 * Stops at form, fieldset, or body.
 */
function walkUpForLabel(el: HTMLElement): string {
  const STOP_TAGS = new Set(["form", "fieldset", "body", "html"]);
  const LABEL_TAGS = new Set(["label", "legend", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "div", "li"]);

  let node: HTMLElement | null = el.parentElement;
  let depth = 0;

  while (node && !STOP_TAGS.has(node.tagName.toLowerCase()) && depth < 6) {
    // Look at the previous sibling chain for a label-like element
    let sibling: Element | null = el.previousElementSibling;
    if (depth > 0) sibling = node.previousElementSibling;

    while (sibling) {
      const tag = sibling.tagName.toLowerCase();
      if (LABEL_TAGS.has(tag)) {
        const text = getTextContent(sibling as HTMLElement);
        if (text && text.length < 300) return text;
      }
      sibling = sibling.previousElementSibling;
    }

    // Also check the direct text of the parent if it has minimal children
    if (node.children.length <= 3) {
      const clone = node.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
      const text = getTextContent(clone);
      if (text && text.length > 2 && text.length < 300) return text;
    }

    node = node.parentElement;
    depth++;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise input[type] to our FieldType union. */
function normaliseInputType(inputType: string): FieldType {
  switch (inputType) {
    case "email":  return "email";
    case "number": return "number";
    case "tel":    return "tel";
    case "textarea": return "textarea";
    default:       return "text"; // date, url, week, month → treat as text
  }
}

/** Build a stable, unique CSS selector for the element. */
function buildSelector(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const tag  = el.tagName.toLowerCase();
  const name = (el as HTMLInputElement).name;
  const type = (el as HTMLInputElement).type;

  if (name) {
    const base = type ? `${tag}[type="${type}"][name="${CSS.escape(name)}"]`
                      : `${tag}[name="${CSS.escape(name)}"]`;
    // If the selector is not unique, disambiguate with nth-of-type
    const matches = document.querySelectorAll(base);
    if (matches.length === 1) return base;

    const idx = Array.from(matches).indexOf(el);
    return idx >= 0 ? `${base}:nth-of-type(${idx + 1})` : base;
  }

  // Fallback: positional selector
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.querySelectorAll(tag));
    const idx = siblings.indexOf(el);
    if (idx >= 0) {
      const parentSel = buildSelector(parent as HTMLElement);
      return `${parentSel} > ${tag}:nth-of-type(${idx + 1})`;
    }
  }

  return tag;
}

/** Build a stable fieldId from the element's id/name or a fallback. */
function buildFieldId(el: HTMLElement, fallback: string): string {
  if (el.id)                              return sanitizeId(el.id);
  if ((el as HTMLInputElement).name)      return sanitizeId((el as HTMLInputElement).name);
  return fallback;
}

/** Sanitize a string to be safe as a fieldId. */
function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

/** Get trimmed text content of an element, collapsing whitespace. */
function getTextContent(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}
