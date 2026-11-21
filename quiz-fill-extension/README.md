# QuizFill — AI-Powered Browser Extension

QuizFill is a cross-browser extension (Chrome/Chromium + Firefox) that reads quiz and survey pages and auto-fills answers using a user-configured LLM (OpenAI GPT-4o or Google Gemini). It works on demand — the extension only acts when you click the toolbar button.

---

## Features

- **On-demand filling** — zero passive behaviour; activates only when you click the toolbar button.
- **Full form support** — text fields, radio buttons, checkboxes, dropdowns, and textareas. Works on React, Vue, and Angular-controlled inputs.
- **Confidence indicators** — each filled field gets a colour-coded badge (green ≥ 80%, yellow ≥ 50%, red < 50%).
- **Optional resources** — paste notes, upload PDF/DOCX files, or add reference URLs to improve accuracy.
- **Your own API key** — bring your OpenAI or Google Gemini key; nothing is stored on any server.
- **Cross-browser** — single codebase, builds for Chrome MV3 and Firefox MV3.

---

## Getting API Keys

### OpenAI (GPT-4o)
1. Create an account at [platform.openai.com](https://platform.openai.com).
2. Navigate to **API Keys** → **Create new secret key**.
3. Copy the key (it starts with `sk-`).

### Google Gemini (gemini-1.5-flash)
1. Visit [aistudio.google.com](https://aistudio.google.com).
2. Click **Get API key** → **Create API key**.
3. Copy the key.

Both keys are stored locally in `chrome.storage.local` and never leave your browser except when making API calls to the respective service.

---

## Development

### Prerequisites
- Node.js 18+ (Node 20 LTS recommended)
- npm 9+

### Install dependencies

```bash
cd quiz-fill-extension
npm install
```

### Run in development mode (with hot reload)

```bash
# Chrome / Chromium
npm run dev

# Firefox
npm run dev:firefox
```

WXT will open a browser window with the extension pre-loaded and reload it on every file change.

### Production build

```bash
# Chrome only
npm run build

# Firefox only
npm run build:firefox

# Both browsers
npm run build:all
```

Build output is placed in:
- `dist/chrome-mv3/`
- `dist/firefox-mv3/`

### Create distributable ZIPs

```bash
npm run zip           # Chrome zip for Web Store submission
npm run zip:firefox   # Firefox zip for AMO submission
```

### Type checking

```bash
npm run typecheck
```

---

## Loading the Extension Manually

### Chrome / Chromium
1. Navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select `dist/chrome-mv3/`.

### Firefox
1. Navigate to `about:debugging`.
2. Click **This Firefox** → **Load Temporary Add-on…**.
3. Select any file inside `dist/firefox-mv3/` (e.g. `manifest.json`).

---

## Project Structure

```
quiz-fill-extension/
├── src/
│   ├── entrypoints/
│   │   ├── popup/          # Toolbar popup (UI + fill trigger)
│   │   ├── options/        # Settings page (API key, provider, model)
│   │   ├── background.ts   # Service worker (LLM API calls, URL fetching)
│   │   └── content.ts      # Content script (DOM extraction, field filling)
│   ├── lib/
│   │   ├── llm/
│   │   │   ├── openai.ts   # OpenAI GPT-4o integration
│   │   │   ├── gemini.ts   # Google Gemini integration
│   │   │   └── router.ts   # Provider selection logic
│   │   └── types.ts        # Shared TypeScript interfaces
│   └── public/
│       └── icons/          # Extension icons (16, 32, 48, 128 px)
├── wxt.config.ts           # WXT + manifest configuration
├── tsconfig.json
└── package.json
```

---

## Known Limitations

- **Shadow DOM fields** — inputs inside closed Shadow DOM roots (some custom web components) are not detected.
- **CSP-locked pages** — pages with a strict Content-Security-Policy that blocks script injection will prevent field filling. The extension will still extract and show questions but cannot write to the DOM.
- **iFrame questions** — questions rendered inside cross-origin iframes cannot be read (browser security restriction).
- **Image-based questions** — purely visual questions (e.g. images of text with no accessible text) are not extracted.

---

## Implementation Status

| Task | Description | Status |
|------|-------------|--------|
| 1 | Project scaffold & dev environment | ✅ Done |
| 2 | Options page — API key & provider | ✅ Done |
| 3 | Background service worker — LLM router | 🔲 Pending |
| 4 | Content script — DOM question extractor | 🔲 Pending |
| 5 | Content script — answer injector + badges | 🔲 Pending |
| 6 | Resource manager — text, files, URLs | 🔲 Pending |
| 7 | Popup UI — full fill flow & state machine | 🔲 Pending |
| 8 | Packaging & cross-browser verification | 🔲 Pending |
