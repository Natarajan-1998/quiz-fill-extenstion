/**
 * Shared TypeScript interfaces and types used across all extension contexts
 * (background service worker, content scripts, popup, options page).
 */

// ---------------------------------------------------------------------------
// Message types — all runtime messages between extension contexts
// ---------------------------------------------------------------------------

export enum MessageType {
  /** Popup → Content Script: start the fill flow for the current page */
  FILL_PAGE = "FILL_PAGE",

  /** Content Script → Background: send extracted questions, get back answers */
  AI_COMPLETE = "AI_COMPLETE",

  /** Popup → Background: test that the saved API key/provider is valid */
  TEST_CONNECTION = "TEST_CONNECTION",

  /** Popup → Background: fetch a URL and return its plain-text content */
  FETCH_URL = "FETCH_URL",

  /** Options → Background: ask the provider which models this key can use */
  LIST_MODELS = "LIST_MODELS",

  /** Background → Popup/Content Script: stream a status update */
  STATUS_UPDATE = "STATUS_UPDATE",
}

// ---------------------------------------------------------------------------
// Extracted questions (produced by the DOM extractor in the content script)
// ---------------------------------------------------------------------------

export type FieldType =
  | "text"
  | "textarea"
  | "email"
  | "number"
  | "tel"
  | "radio"
  | "checkbox"
  | "select";

export interface SelectOption {
  /** Display text shown to the user */
  label: string;
  /** HTML value attribute */
  value: string;
}

export interface ExtractedQuestion {
  /** Stable identifier — used to match answers back to DOM elements.
   *  For most fields: the field's `id` attribute or a generated index-based key.
   *  For radio groups: the shared `name` attribute. */
  fieldId: string;

  /** HTML input type or element type */
  type: FieldType;

  /** Human-readable question text resolved from label, aria-label, placeholder,
   *  or nearest heading/paragraph in the DOM hierarchy */
  labelText: string;

  /** Available choices for radio/checkbox/select fields */
  options?: SelectOption[];

  /** CSS selector that uniquely identifies this element in the DOM */
  selector?: string;
}

// ---------------------------------------------------------------------------
// LLM answer results (returned by the background service worker)
// ---------------------------------------------------------------------------

export interface AnswerResult {
  /** Matches ExtractedQuestion.fieldId */
  fieldId: string;

  /** The value to fill into the field.
   *  For radio/checkbox/select: the option value string.
   *  For text/textarea: the answer text. */
  answer: string;

  /** Confidence score from 0 to 1 (e.g. 0.92 = 92% confident) */
  confidence: number;

  /** Optional short reasoning from the LLM for debugging */
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// LLM provider settings (stored in chrome.storage.local)
// ---------------------------------------------------------------------------

export type LLMProvider = "openai" | "gemini";

export interface LLMSettings {
  provider: LLMProvider;
  apiKey: string;
  /** e.g. "gpt-4o" or "gemini-1.5-flash" */
  model: string;
}

// ---------------------------------------------------------------------------
// User-provided resources
// ---------------------------------------------------------------------------

export type ResourceType = "text" | "file" | "url";

export interface Resource {
  /** Unique ID for the resource item (used for removal) */
  id: string;

  type: ResourceType;

  /** Display name shown in the resource list (filename, URL, or "Pasted text") */
  label: string;

  /** Extracted plain-text content ready to include in the LLM prompt */
  content: string;
}

// ---------------------------------------------------------------------------
// Message payloads
// ---------------------------------------------------------------------------

export interface AiCompletePayload {
  questions: ExtractedQuestion[];
  /** Combined plain-text from all user resources; undefined if none provided */
  resourceContext?: string;
}

export interface AiCompleteResponse {
  success: true;
  answers: AnswerResult[];
}

export interface AiCompleteError {
  success: false;
  error: string;
}

export type AiCompleteResult = AiCompleteResponse | AiCompleteError;

export interface TestConnectionPayload {
  provider: LLMProvider;
  apiKey: string;
  model: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
}

export interface ModelInfo {
  /** Model id sent in API requests, e.g. "gpt-4o" */
  id: string;
  /** Human-readable name shown in the dropdown */
  label: string;
}

export interface ListModelsPayload {
  provider: LLMProvider;
  apiKey: string;
}

export interface ListModelsResult {
  success: boolean;
  models?: ModelInfo[];
  error?: string;
}

export interface FetchUrlPayload {
  url: string;
}

export interface FetchUrlResult {
  success: boolean;
  text?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Fill results reported back to the popup
// ---------------------------------------------------------------------------

export interface FillSummary {
  totalFilled: number;
  highConfidence: number;   // confidence >= 0.8
  medConfidence: number;    // confidence >= 0.5 and < 0.8
  lowConfidence: number;    // confidence < 0.5
  errors: string[];
}
