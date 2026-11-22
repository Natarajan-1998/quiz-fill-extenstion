import { defineConfig } from "wxt";

export default defineConfig({
  // Source directory for entrypoints, public assets, and lib
  srcDir: "src",

  // Output directory
  outDir: "dist",

  // Build output naming: dist/chrome-mv3, dist/firefox-mv2
  outDirTemplate: "{{browser}}-mv{{manifestVersion}}",

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

    icons: {
      16: "icons/16.png",
      32: "icons/32.png",
      48: "icons/48.png",
      128: "icons/128.png",
    },

    // Action (toolbar button)
    action: {
      default_popup: "popup.html",
      default_title: "QuizFill — Auto-fill this page",
      default_icon: {
        16: "icons/16.png",
        32: "icons/32.png",
        48: "icons/48.png",
        128: "icons/128.png",
      },
    },

    // Firefox-specific settings (ignored by Chrome)
    browser_specific_settings: {
      // Cast: WXT's manifest types predate data_collection_permissions (Firefox 140+).
      gecko: {
        id: "quizfill@extension",
        // pdf.js runs as a module worker, which needs Firefox 114+ (115 is the ESR).
        strict_min_version: "115.0",
        // Shown to users at install. When the user clicks Fill, the page's
        // question and option text is sent to the AI provider they configured.
        data_collection_permissions: {
          required: ["websiteContent"],
        },
      } as { id: string; strict_min_version: string },
    },
  },
});
