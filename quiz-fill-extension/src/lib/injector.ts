/**
 * Answer injector — fills form fields and fires the events frameworks listen for.
 *
 * `fillFields` is deliberately ONE self-contained function: no imports, no
 * references to anything outside its own body. That lets it be serialised by
 * chrome.scripting.executeScript({ world: "MAIN", func: fillFields }) and run
 * inside the page's own JS context, and also be called directly from the
 * content script (isolated world) as a fallback, for example in Firefox's MV2
 * build where the scripting API does not exist.
 *
 * Why the native setter?
 * React tracks an input's value through a property it installs on the element
 * itself. Assigning el.value goes through that property, React sees no change,
 * and the next render wipes the text. Calling the prototype's original setter
 * skips React's property, then the dispatched `input` event makes React notice
 * the difference and update its state.
 *
 * Checkboxes and radios use el.click() so the browser toggles them and fires
 * its own click/input/change events, exactly as for a real user.
 *
 * Fields may sit in open shadow roots or same-origin iframes; each answer's
 * `selector` is a locator (see locator.ts) that fillFields resolves itself.
 */

import type { AnswerResult } from "./types.js";

export interface InjectorPayload {
  answers: Array<{
    fieldId:  string;
    answer:   string;
    selector?: string;
  }>;
}

export interface FillOutcome {
  fieldId: string;
  filled:  boolean;
  reason:  string;
}

/** Self-contained: must not reference any identifier defined outside this function. */
export function fillFields(payload: InjectorPayload): FillOutcome[] {
  // ── Locator resolution (same logic as locator.ts; keep in sync) ────────
  const SEP = " >>> ";

  const step = (root: ParentNode, hop: string): Element | null => {
    if (hop.startsWith("@")) {
      let cur: ParentNode = root;
      for (const part of hop.slice(1).split("/")) {
        const next = cur.children[Number(part)];
        if (!next) return null;
        cur = next;
      }
      return cur as Element;
    }
    try { return root.querySelector(hop); } catch { return null; }
  };

  const locateScope = (locator: string): { root: ParentNode; last: string } | null => {
    const hops = locator.split(SEP);
    const last = hops.pop() as string;
    let root: ParentNode = document;
    for (const hop of hops) {
      const host = step(root, hop);
      if (!host) return null;
      let next: ParentNode | null = null;
      if (host.tagName === "IFRAME" || host.tagName === "FRAME") {
        try { next = (host as HTMLIFrameElement).contentDocument; } catch { next = null; }
      } else {
        next = host.shadowRoot;
      }
      if (!next) return null;
      root = next;
    }
    return { root, last };
  };

  const findOne = (locator: string): Element | null => {
    const scope = locateScope(locator);
    return scope ? step(scope.root, scope.last) : null;
  };

  // ── Window-aware helpers: a field inside an iframe has its own window ──
  const winOf = (el: Element): typeof window =>
    (el.ownerDocument.defaultView || window) as typeof window;

  const fire = (el: Element, names: string[]): void => {
    const win = winOf(el);
    for (const name of names) {
      el.dispatchEvent(new win.Event(name, { bubbles: true, cancelable: true }));
    }
  };

  const fillText = (el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean => {
    const win = winOf(el);
    const proto = el.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    fire(el, ["input", "change"]);
    return true;
  };

  const fillSelect = (el: HTMLSelectElement, value: string): boolean => {
    const wanted = value.trim().toLowerCase();
    const options = Array.from(el.options);
    const match =
      options.find((o) => o.value === value) ||
      options.find((o) => o.value.toLowerCase() === wanted) ||
      options.find((o) => o.text.trim().toLowerCase() === wanted);
    if (!match) return false;
    el.value = match.value;
    fire(el, ["input", "change"]);
    return true;
  };

  const fillRadioGroup = (locator: string, value: string): boolean => {
    const scope = locateScope(locator);
    if (!scope) return false;
    let radios: HTMLInputElement[] = [];
    try {
      radios = Array.from(scope.root.querySelectorAll<HTMLInputElement>(scope.last));
    } catch { return false; }
    const wanted = value.trim().toLowerCase();
    const match = radios.find((r) => r.value.toLowerCase() === wanted);
    if (!match) return false;
    if (!match.checked) match.click();
    return match.checked;
  };

  const fillCheckbox = (el: HTMLInputElement, value: string): boolean => {
    const want = ["true", "yes", "1", "checked", "on"].includes(value.trim().toLowerCase());
    if (el.checked !== want) el.click();
    return el.checked === want;
  };

  // ── Main loop ──────────────────────────────────────────────────────────
  const outcomes: FillOutcome[] = [];

  for (const item of payload.answers) {
    const { fieldId, answer, selector } = item;

    if (!answer) {
      outcomes.push({ fieldId, filled: false, reason: "no answer returned" });
      continue;
    }

    try {
      if (fieldId.startsWith("radio-") && selector) {
        const ok = fillRadioGroup(selector, answer);
        outcomes.push({ fieldId, filled: ok, reason: ok ? "ok" : "no radio option matches the answer" });
        continue;
      }

      const el = selector ? findOne(selector) : document.getElementById(fieldId);
      if (!el) {
        outcomes.push({ fieldId, filled: false, reason: "element not found" });
        continue;
      }

      const tag  = el.tagName.toLowerCase();
      const type = ((el as HTMLInputElement).type || "").toLowerCase();
      let ok = false;

      if (tag === "select")         ok = fillSelect(el as HTMLSelectElement, answer);
      else if (tag === "textarea")  ok = fillText(el as HTMLTextAreaElement, answer);
      else if (type === "checkbox") ok = fillCheckbox(el as HTMLInputElement, answer);
      else                          ok = fillText(el as HTMLInputElement, answer);

      outcomes.push({ fieldId, filled: ok, reason: ok ? "ok" : "value did not match any option" });
    } catch (err) {
      outcomes.push({ fieldId, filled: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return outcomes;
}

/** Maps answers + the extractor's selectors into the payload `fillFields` takes. */
export function buildInjectorPayload(
  answers: AnswerResult[],
  selectorMap: Map<string, string>
): InjectorPayload {
  return {
    answers: answers.map((a) => ({
      fieldId:  a.fieldId,
      answer:   a.answer,
      selector: selectorMap.get(a.fieldId),
    })),
  };
}
