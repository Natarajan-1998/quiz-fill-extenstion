/**
 * Locators — addresses for form fields that may sit inside shadow roots or
 * same-origin iframes, where a plain document.querySelector cannot reach.
 *
 * A locator is a chain of hops joined by LOCATOR_SEP:
 *
 *   "iframe#content >>> d2l-quiz >>> input[name=\"q1\"]"
 *
 * Every hop except the last selects an <iframe> (continue in its document) or
 * a shadow host (continue in its open shadow root). The last hop selects the
 * field itself. A hop is either a CSS selector or an index path "@0/3/1",
 * the element-child index at each level from the current root.
 *
 * injector.ts contains its own copy of the resolver because fillFields has to
 * be a single self-contained function. Keep the two in sync.
 */

export const LOCATOR_SEP = " >>> ";

function resolveStep(root: ParentNode, hop: string): Element | null {
  if (hop.startsWith("@")) {
    let cur: ParentNode = root;
    for (const part of hop.slice(1).split("/")) {
      const next = cur.children[Number(part)];
      if (!next) return null;
      cur = next;
    }
    return cur as Element;
  }
  try {
    return root.querySelector(hop);
  } catch {
    return null;
  }
}

function enterHost(host: Element): ParentNode | null {
  if (host.tagName === "IFRAME" || host.tagName === "FRAME") {
    try {
      return (host as HTMLIFrameElement).contentDocument;
    } catch {
      return null; // cross-origin frame
    }
  }
  return host.shadowRoot;
}

/** Resolve everything except the last hop; returns the root the last hop applies to. */
export function locateScope(locator: string): { root: ParentNode; last: string } | null {
  const hops = locator.split(LOCATOR_SEP);
  const last = hops.pop() as string;
  let root: ParentNode = document;

  for (const hop of hops) {
    const host = resolveStep(root, hop);
    if (!host) return null;
    const next = enterHost(host);
    if (!next) return null;
    root = next;
  }
  return { root, last };
}

/** The single element a locator points at, or null if it can no longer be found. */
export function resolveElement(locator: string): Element | null {
  const scope = locateScope(locator);
  return scope ? resolveStep(scope.root, scope.last) : null;
}
