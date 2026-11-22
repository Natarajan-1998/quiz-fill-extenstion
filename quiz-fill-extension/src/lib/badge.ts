/**
 * Confidence Badge Renderer — Task 5
 *
 * Renders a small floating badge next to each filled form field showing the
 * LLM's confidence score as a colour-coded percentage pill.
 *
 * Uses Shadow DOM so the badge's CSS is completely isolated from the host
 * page's styles — the badge looks consistent on any website.
 *
 * Runs in the content script's ISOLATED world (not the page's MAIN world)
 * because it only reads/writes the DOM, not JS framework internals.
 *
 * Confidence colour mapping:
 *   ≥ 80%  →  green   (#22c55e)
 *   ≥ 50%  →  amber   (#f59e0b)
 *   < 50%  →  red     (#ef4444)
 *
 * All badges are stored in `window.__quizfillBadges` so they can be removed
 * on the next fill run or when the user clears resources.
 */

import type { AnswerResult } from "./types.js";
import type { ExtractedQuestion } from "./types.js";
import { resolveElement } from "./locator.js";

// ---------------------------------------------------------------------------
// Badge colour helpers
// ---------------------------------------------------------------------------

type ConfidenceLevel = "high" | "med" | "low";

function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "med";
  return "low";
}

const BADGE_COLORS: Record<ConfidenceLevel, { bg: string; text: string; border: string }> = {
  high: { bg: "#052e16", text: "#86efac", border: "#166534" },
  med:  { bg: "#1c1200", text: "#fcd34d", border: "#92400e" },
  low:  { bg: "#1f0a0a", text: "#fca5a5", border: "#991b1b" },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Badges placed by the current run. Tracked here, not found by querying the
 * document, because they may sit inside shadow roots or iframes.
 */
let placedBadges: Element[] = [];

/** Remove any badges placed by a previous fill run. */
export function clearBadges(): void {
  placedBadges.forEach((el) => el.remove());
  placedBadges = [];
}

/**
 * Place confidence badges next to every filled field.
 *
 * @param answers    AnswerResult[] returned by the LLM
 * @param questions  ExtractedQuestion[] from the extractor (used to find elements)
 */
export function renderBadges(
  answers: AnswerResult[],
  questions: ExtractedQuestion[]
): void {
  // Clear any badges from a previous run first
  clearBadges();

  // Build a map of fieldId → selector for fast lookup
  const selectorMap = new Map<string, string>();
  for (const q of questions) {
    if (q.selector) selectorMap.set(q.fieldId, q.selector);
  }

  const questionById = new Map(questions.map((q) => [q.fieldId, q]));

  for (const answer of answers) {
    if (!answer.answer) continue; // skip unfilled fields

    const selector = selectorMap.get(answer.fieldId);
    const target   = resolveTarget(answer.fieldId, selector);
    if (!target) continue;

    // Show the option's text, not its internal value (which can be an opaque id).
    const q = questionById.get(answer.fieldId);
    const shown = q?.options?.find((o) => o.value === answer.answer)?.label ?? answer.answer;

    placeBadge(target, answer, shown);
  }
}

// ---------------------------------------------------------------------------
// Element resolver
// ---------------------------------------------------------------------------

function resolveTarget(fieldId: string, selector?: string): HTMLElement | null {
  // The extractor's locator reaches into shadow roots and same-origin iframes.
  if (selector) {
    const el = resolveElement(selector);
    if (el) return el as HTMLElement;
  }
  return document.getElementById(fieldId);
}

// ---------------------------------------------------------------------------
// Badge placement
// ---------------------------------------------------------------------------

function placeBadge(anchor: HTMLElement, answer: AnswerResult, shown: string): void {
  const level  = confidenceLevel(answer.confidence);
  const colors = BADGE_COLORS[level];
  const pct    = Math.round(answer.confidence * 100);
  const icon   = level === "high" ? "✓" : level === "med" ? "~" : "?";

  // ── Create the host element ───────────────────────────────────────────
  // Create the badge in the field's own document (it may be inside an iframe).
  const host = anchor.ownerDocument.createElement("span");
  host.setAttribute("data-quizfill-badge", answer.fieldId);
  host.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "vertical-align:middle",
    "margin-left:6px",
    "position:relative",
    "z-index:2147483647",   // top of stacking context
    "pointer-events:auto",
  ].join(";");

  // ── Attach a Shadow DOM so page CSS can't bleed in ────────────────────
  const shadow = host.attachShadow({ mode: "open" });

  // ── Badge HTML inside the shadow root ─────────────────────────────────
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 7px;
        border-radius: 999px;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.4;
        white-space: nowrap;
        cursor: default;
        background: ${colors.bg};
        color: ${colors.text};
        border: 1px solid ${colors.border};
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        transition: transform 0.1s ease, box-shadow 0.1s ease;
        user-select: none;
      }
      .badge:hover {
        transform: scale(1.08);
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      }
      .dot {
        font-size: 10px;
        line-height: 1;
      }
      .tooltip {
        display: none;
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        background: #0f0a1a;
        color: #f1eeff;
        font-size: 11px;
        padding: 5px 9px;
        border-radius: 6px;
        border: 1px solid #3d2b7a;
        white-space: nowrap;
        max-width: 240px;
        white-space: normal;
        z-index: 10;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.6);
      }
      .tooltip::after {
        content: "";
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        border: 5px solid transparent;
        border-top-color: #3d2b7a;
      }
      .badge:hover + .tooltip,
      .badge:focus + .tooltip {
        display: block;
      }
      .wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }
    </style>
    <div class="wrap">
      <div class="badge" tabindex="0" role="status"
           aria-label="QuizFill confidence: ${pct}%">
        <span class="dot">${icon}</span>
        <span>${pct}%</span>
      </div>
      <div class="tooltip">
        ${buildTooltipText(answer, level, shown)}
      </div>
    </div>
  `;

  // ── Insert badge after the target element ─────────────────────────────
  insertAfter(host, anchor);
  placedBadges.push(host);
}

// ---------------------------------------------------------------------------
// Tooltip text
// ---------------------------------------------------------------------------

function buildTooltipText(answer: AnswerResult, level: ConfidenceLevel, shown: string): string {
  const pct  = Math.round(answer.confidence * 100);
  const label = level === "high" ? "High confidence"
              : level === "med"  ? "Medium confidence"
              :                    "Low confidence";

  const filled = answer.answer
    ? `Filled: <strong>${escapeHtml(shown.slice(0, 80))}</strong>`
    : "Not filled";

  const reasoning = answer.reasoning
    ? `<br/><em>${escapeHtml(answer.reasoning.slice(0, 120))}</em>`
    : "";

  return `${label} (${pct}%)<br/>${filled}${reasoning}`;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function insertAfter(newEl: Element, ref: Element): void {
  // For radio/checkbox groups, insert after the last element in the group
  // parentNode, not parentElement: a field can be a direct child of a shadow root.
  const parent = ref.parentNode;
  if (!parent) return;

  const next = ref.nextSibling;
  if (next) {
    parent.insertBefore(newEl, next);
  } else {
    parent.appendChild(newEl);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
