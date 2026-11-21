import { defineConfig } from "wxt";

export default defineConfig({
  // Source directory for entrypoints, public assets, and lib
  srcDir: "src",

  // Output directory
  outDir: "dist",

  // Build output naming: dist/chrome-mv3, dist/firefox-mv3
  outDirTemplate: "{{browser}}-mv3",

  extensionApi: "chrome",

  manifest: {
    name: "QuizFill",
    short_name: "QuizFill",
    description:
      "AI-powered extension that reads quiz and survey pages and auto-fills answers using your preferred LLM.",
    version: "0.1.0",

    // Permissions needed by the extension
    permissions: ["storage", "scripting", "activeTab"],

    // Cross-origin hosts the service worker can fetch from
    host_permissions: [
      "https://api.openai.com/*",
      "https://generativelanguage.googleapis.com/*",
      // Allow fetching arbitrary URLs for the resource-URL feature;
      // users grant this per-site implicitly when they add a resource URL.
      "<all_urls>",
    ],

    // Action (toolbar button)
    action: {
      default_popup: "popup.html",
      default_title: "QuizFill — Auto-fill this page",
    },

    // Firefox-specific settings (ignored by Chrome)
    browser_specific_settings: {
      gecko: {
        id: "quizfill@extension",
        strict_min_version: "109.0",
      },
    },

    // The pdf.worker script must be accessible from content scripts
    web_accessible_resources: [
      {
        resources: ["pdf.worker.min.mjs", "icons/*"],
        matches: ["<all_urls>"],
      },
    ],
  },
});
