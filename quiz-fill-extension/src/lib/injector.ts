/**
 * MAIN-world Answer Injector — Task 5
 *
 * This module is NOT imported as a normal ES module.
 * It exports a single function `buildInjectorScript()` which returns a
 * self-contained JS string. That string is injected into the PAGE's MAIN
 * JavaScript world via chrome.scripting.executeScript({ world: "MAIN" }).
 *
 * Why MAIN world?
 * ───────────────
 * Content scripts run in an "isolated world" — a separate JS context from
 * the page. The page's React/Vue/Angular components track state through
 * their own copies of HTMLInputElement.prototype descriptors. Calling
 * element.value = "..." from the isolated world bypasses the framework's
 * change detection entirely, so the fill appears visually but the framework
 * ignores it.
 *
 * The fix: run the setter in the page's OWN world so we use the same
 * HTMLInputElement.prototype the framework patched, then fire synthetic
 * input + change events that the framework's listeners pick up.
 *
 * Security note
 * ─────────────
 * The answer payload is serialised to JSON and embedded as a literal string
 * in the injected script. No user-controlled strings are interpolated
 * directly into JS — only into the JSON blob which is then JSON.parse()d.
 */

import type { AnswerResult } from "./types.js";

// ---------------------------------------------------------------------------
// Payload type (mirrored inside the injected script — cannot import types)
// ---------------------------------------------------------------------------

export interface InjectorPayload {
  answers: Array<{
    fieldId:    string;
    answer:     string;
    confidence: number;
    selector?:  string;
  }>;
}

// ---------------------------------------------------------------------------
// Public API: build the self-contained script string
// ---------------------------------------------------------------------------

/**
 * Returns a JS string that, when executed in the page's MAIN world,
 * fills every form field described in `payload` and fires appropriate
 * synthetic events so React/Vue/Angular pick up the changes.
 *
 * Returns `window.__quizfillResult` — an array of per-field outcomes
 * that the content script can read back via executeScript's return value.
 */
export function buildInjectorScript(payload: InjectorPayload): string {
  // Serialize payload safely — only JSON, never raw string interpolation
  const payloadJson = JSON.stringify(payload);

  return `
(function() {
  "use strict";

  const payload = ${payloadJson};

  // ── Native setter access (bypasses framework value tracking) ──────────
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  )?.set;

  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  )?.set;

  // ── Event helpers ─────────────────────────────────────────────────────
  function fireEvents(el, events) {
    for (const name of events) {
      el.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }));
    }
  }

  function fireInputChange(el) {
    fireEvents(el, ["input", "change"]);
  }

  // ── Field fillers ─────────────────────────────────────────────────────

  function fillTextField(el, value) {
    try {
      if (nativeInputSetter) {
        nativeInputSetter.call(el, value);
      } else {
        el.value = value;
      }
      fireInputChange(el);
      return true;
    } catch (e) {
      return false;
    }
  }

  function fillTextarea(el, value) {
    try {
      if (nativeTextareaSetter) {
        nativeTextareaSetter.call(el, value);
      } else {
        el.value = value;
      }
      fireInputChange(el);
      return true;
    } catch (e) {
      return false;
    }
  }

  function fillSelect(el, value) {
    try {
      // Find the matching option (exact value match first, then label match)
      let found = Array.from(el.options).find(o => o.value === value);
      if (!found) {
        found = Array.from(el.options).find(
          o => o.text.trim().toLowerCase() === value.toLowerCase()
        );
      }
      if (!found) return false;

      el.value = found.value;
      fireInputChange(el);
      return true;
    } catch (e) {
      return false;
    }
  }

  function fillRadio(selector, value) {
    // selector is  input[type="radio"][name="..."]
    // value is the option's .value attribute to select
    const radios = document.querySelectorAll(selector);
    if (radios.length === 0) return false;

    let filled = false;
    for (const radio of radios) {
      const isMatch =
        radio.value === value ||
        radio.value.toLowerCase() === value.toLowerCase();

      if (isMatch && !radio.checked) {
        radio.checked = true;
        fireEvents(radio, ["click", "change"]);
        filled = true;
      } else if (!isMatch && radio.checked) {
        // Uncheck other radios in the group (some frameworks watch this)
        radio.checked = false;
      }
    }
    return filled;
  }

  function fillCheckbox(el, value) {
    try {
      const shouldCheck =
        value === "true" ||
        value === "yes" ||
        value === "1" ||
        value === "checked" ||
        value.toLowerCase() === "true";

      if (el.checked !== shouldCheck) {
        el.checked = shouldCheck;
        fireEvents(el, ["click", "change"]);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── Main fill loop ────────────────────────────────────────────────────

  const results = [];

  for (const item of payload.answers) {
    const { fieldId, answer, confidence, selector } = item;

    if (!answer) {
      results.push({ fieldId, filled: false, reason: "empty answer" });
      continue;
    }

    // Resolve the element.
    // Try the selector first (most precise), then fall back to common patterns.
    let el = null;

    if (selector) {
      try { el = document.querySelector(selector); } catch (_) {}
    }

    // Fallbacks by fieldId pattern
    if (!el) {
      if (fieldId.startsWith("radio-")) {
        // Radio groups use a name-based selector, not a single element
        const name = fieldId.replace(/^radio-/, "").replace(/_/g, function(_, i, s) {
          // Try to recover the original special chars — best effort
          return "_";
        });
        // Try the stored selector from payload
        const radioSel = selector || ("input[type=\\"radio\\"][name=\\"" + name + "\\"]");
        const filled = fillRadio(radioSel, answer);
        results.push({ fieldId, filled, reason: filled ? "ok" : "no matching radio option" });
        continue;
      }

      // Try id selector
      try { el = document.getElementById(fieldId); } catch (_) {}
    }

    // Try name attribute
    if (!el) {
      try {
        el = document.querySelector(
          "[name=\\"" + fieldId.replace(/"/g, '\\\\"') + "\\"]"
        );
      } catch (_) {}
    }

    if (!el) {
      results.push({ fieldId, filled: false, reason: "element not found" });
      continue;
    }

    const tag  = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    let filled = false;

    if (tag === "select") {
      filled = fillSelect(el, answer);
    } else if (tag === "textarea") {
      filled = fillTextarea(el, answer);
    } else if (type === "radio") {
      filled = fillRadio(selector || ("[name=\\"" + el.name + "\\"]"), answer);
    } else if (type === "checkbox") {
      filled = fillCheckbox(el, answer);
    } else {
      // text, email, number, tel, url, date, etc.
      filled = fillTextField(el, answer);
    }

    results.push({ fieldId, filled, reason: filled ? "ok" : "fill failed" });
  }

  return results;
})();
`;
}

// ---------------------------------------------------------------------------
// Selector extractor — maps fieldId → selector from ExtractedQuestion[]
// (used by content.ts when building the InjectorPayload)
// ---------------------------------------------------------------------------

export function buildInjectorPayload(
  answers: AnswerResult[],
  selectorMap: Map<string, string>
): InjectorPayload {
  return {
    answers: answers.map((a) => ({
      fieldId:    a.fieldId,
      answer:     a.answer,
      confidence: a.confidence,
      selector:   selectorMap.get(a.fieldId),
    })),
  };
}
