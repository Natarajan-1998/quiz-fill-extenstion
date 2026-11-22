# QuizFill

QuizFill is a browser extension for Chrome-based browsers and Firefox. When you click its toolbar button, it reads the quiz or survey questions on the current page, asks an AI model you choose (OpenAI or Google Gemini, with your own API key) for answers, and fills them in. Each filled field gets a confidence badge.

It does nothing until you click. The content script is loaded on every page but stays idle.

> **Check every answer before you submit.** The AI can be wrong even when it reports high confidence. Many quiz pages save your choice as soon as a field changes, so a fill is effectively an answer. Make sure your course or institution allows this kind of tool.

---

## What it can fill

| Field | Notes |
|---|---|
| Text, email, number, phone, textarea | Values are set so React, Vue and Angular see the change |
| Dropdown (`<select>`) | Matched by option value or visible text |
| Radio group | One question per group; the AI sees the question and every option's text |
| Single checkbox | Treated as a yes/no question |

Fields are found in the main page, inside open shadow roots (web components), and inside iframes from the same site. Learning platforms such as Brightspace (D2L) put the quiz in an iframe and the question text inside web components, and both are handled.

## Optional resources

You can give the AI reference material from the popup:

- **Text:** paste notes.
- **Files:** PDF, DOCX, TXT, MD, CSV. Parsed in the browser; nothing is uploaded except the extracted text, which goes to your AI provider.
- **URLs:** the page is fetched and reduced to plain text.

Resources stay in the extension's storage until you remove them or click **Clear Resources & Reset**. Up to about 12,000 characters of combined resource text are sent with each fill.

---

## Install

### Chrome, Edge, Brave and other Chromium browsers

1. Extract `quiz-fill-extension-<version>-chrome.zip` to a folder (or build it, see below).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted folder (the one containing `manifest.json`).

### Firefox (115 or later)

1. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Select `quiz-fill-extension-<version>-firefox.zip`.

A temporary add-on is removed when Firefox restarts. A permanent install needs the add-on signed by Mozilla, either listed on addons.mozilla.org or signed as an unlisted add-on.

## Set up

1. Click the QuizFill icon → the gear icon, or right-click the icon → **Options**.
2. Choose **OpenAI** or **Google Gemini** and paste your API key.
   - OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   - Gemini: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
3. The model list loads from your provider, showing only models your key can use. If it can't load, pick **Custom model name…** and type one.
4. Click **Test Connection**, then **Save Settings**.

Model names are retired often (Google shut down `gemini-1.5-*` in September 2025). If Test Connection says a model was not found, pick another from the list.

## Use

1. Open the quiz page and wait for the questions to appear.
2. Click the QuizFill icon → **Fill This Page**.
3. Check the answers. Hover a badge to see the chosen option, the confidence and the AI's one-line reasoning.

### Free-tier quota

On a free Gemini key, some models allow only a few requests per minute or none at all. A `429` error shows the provider's own message, which names the limit you hit. Opening Settings, Test Connection and each fill all send requests.

---

## Privacy and data flow

| Data | Where it goes |
|---|---|
| API key | Saved in the browser's extension storage (not encrypted), and sent only to the provider you chose |
| Question text, option text, field labels | Sent to your AI provider when you click Fill |
| Values you already typed into the page | Not read, not sent |
| Resource text | Saved in extension storage; sent to your AI provider with each fill |
| URL resources | Fetched by the extension from the URL you entered |

There is no QuizFill server, no analytics and no remote code. The extension pages use local fonts only.

The Firefox build declares `websiteContent` as data it transmits, which Firefox 140+ shows at install time.

### Permissions

| Permission | Why |
|---|---|
| `storage` | Save settings and resources |
| `scripting` | Fill fields inside the page's own JavaScript context so framework-controlled inputs register the change (Chrome) |
| `activeTab` | Act on the tab you clicked from |
| `<all_urls>` host access | Run the idle content script on any quiz page, and fetch URL resources |
| `api.openai.com`, `generativelanguage.googleapis.com` | Call the AI providers |

---

## Known limitations

- **Multi-select questions** ("select all that apply") built from several checkboxes are sent to the AI as separate yes/no items, and the shared question text may not be included. Answers to these are less reliable.
- **Cross-origin iframes** and **closed shadow roots** can't be read by any extension and are skipped.
- **Image-only questions** (text drawn in an image) aren't read.
- **Custom widgets** that don't use real form fields underneath (for example a clickable `<div>` acting as a radio button) aren't detected.
- **Very large pages:** the AI's reply budget grows with the number of questions, up to 8,192 tokens. A page with many long questions can still be cut off; the popup reports this.
- **Firefox 115–139** ignore the data-collection declaration (a linter warning, not an error).

---

## Development

Requires Node.js 18+ (20 recommended).

```bash
npm install
npm run dev            # Chrome, with reload on change
npm run dev:firefox    # Firefox
npm run typecheck
npm run build:all      # dist/chrome-mv3/ and dist/firefox-mv2/
npm run zip            # dist/quiz-fill-extension-<version>-chrome.zip
npm run zip:firefox    # Firefox zip plus a sources zip for Mozilla review
```

The Firefox build is Manifest V2 (WXT's default for Firefox); the Chrome build is Manifest V3. On Firefox, fields are filled from the content script directly because the MV2 build has no `scripting` API.

### Structure

```
src/
├── entrypoints/
│   ├── background.ts       # Provider calls, model list, URL fetch, page-world fill (Chrome)
│   ├── content.ts          # Fill flow: extract → ask AI → fill → badges
│   ├── popup/              # Toolbar popup: fill button, results, resources
│   └── options/            # Settings: provider, key, model list
├── lib/
│   ├── extractor.ts        # Finds fields and their labels (shadow DOM and iframes)
│   ├── locator.ts          # Addresses for fields inside iframes / shadow roots
│   ├── injector.ts         # fillFields(): self-contained fill function
│   ├── badge.ts            # Confidence badges
│   ├── resources.ts        # Resource storage and parsing helpers
│   ├── types.ts
│   └── llm/                # prompt.ts, openai.ts, gemini.ts, models.ts, router.ts
└── public/icons/           # 16/32/48/128 px icons
```

---

## Release checks

Verified for version 0.1.0 (Chromium 159 and Firefox 160, both headless, with mock AI providers):

- Both packages load, every file the manifest names is present, and web pages can't read the extension's files.
- Options: model list, custom-model fallback, Test Connection (success, invalid key, retired model), save and restore.
- Fill: plain form (all six field types), React-controlled inputs surviving a re-render, and a page built like a Brightspace quiz (iframe plus shadow-DOM question and option text), on both providers.
- Popup: results counts, no-fields notice, the provider's own 429 message, no-key state.
- Resources: text, PDF, DOCX, TXT and URL all reach the prompt; remove, persist and clear.
- Mozilla's add-on linter: 0 errors.

Not covered by those checks, so test by hand before a release:

- [ ] A real fill against OpenAI and against Gemini with a real key
- [ ] The real target quiz page in each browser
- [ ] Opening the popup from the toolbar icon (the automated run opened it as a tab)
- [ ] Branded Google Chrome and Microsoft Edge, not just Chromium
- [ ] Firefox ESR 115
