# Browser Agent — Design

A cross-browser (Chrome + Firefox) WebExtension that injects a floating pill into every page; the
pill pulls out a small panel with a chat box plus "Embed HTML" / "Embed Screenshot" buttons. User
messages, page context, and screenshots are sent to a **local, OpenAI-compatible LLM endpoint**
(Ollama, LM Studio, llama.cpp server, …) and the streamed answer is rendered in the panel. Later
phases let the model take actions on the page.

## 1. Research findings that shaped the design

- **Vimium's architecture** (philc/vimium, MIT): MV3 manifest, a single background entry
  (`background_scripts/main.js`) built as a service worker for Chrome and a background event page
  for Firefox from one source tree; content scripts injected at `document_start` with
  `all_frames: true`; UI surfaces (Vomnibar, HUD) rendered as extension pages in iframes via
  `web_accessible_resources`; options page is a plain extension page; `host_permissions:
  ["<all_urls>"]`.
- **Cross-browser reality (2026):** the `browser.*` namespace with promises is natively supported
  in Chrome 148+ (use `webextension-polyfill` only for older targets). Firefox MV3 uses a
  background **event page** (`background.scripts`) instead of a service worker and requires
  `browser_specific_settings.gecko.id`. Firefox treats `host_permissions` as user-revocable —
  code must degrade gracefully when a grant is missing.
- **Screenshots:** `tabs.captureVisibleTab()` (Chrome) / `tabs.captureTab()` (Firefox) capture the
  visible viewport only, require `<all_urls>` or `activeTab`, and Chrome rate-limits to 2/sec.
  Full-page capture on Chrome requires `chrome.debugger` (CDP `Page.captureScreenshot` with
  `captureBeyondViewport`); Firefox has no equivalent. Extensions have **no filesystem access** —
  ephemeral storage is `storage.session` (memory, cleared on browser exit); blobs live in IndexedDB.
- **Local LLM calls:** fetches from the background context with `host_permissions` covering the
  endpoint bypass page CORS. Gotcha: **Ollama validates the `Origin` header** and rejects
  `chrome-extension://` / `moz-extension://` origins unless the user starts it with e.g.
  `OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*"`; LM Studio needs its CORS toggle
  enabled. The options page therefore ships a "Test connection" button that surfaces these errors.
- **Tooling:** WXT (Vite-based) is the framework of choice — one codebase, per-browser manifests
  via `wxt build -b firefox`, handles the service-worker/event-page split, dev HMR.

## 2. Architecture

```
┌───────────────────────────── Browser ─────────────────────────────┐
│                                                                    │
│  ┌── Content Script (ISOLATED world, top frame) ────────────────┐  │
│  │  panel.ts ──► host div ──► ShadowRoot (mode:'closed')        │  │
│  │      • floating pill (top-right)                             │  │
│  │      • slide-out panel: [Embed HTML] [Embed Screenshot]      │  │
│  │        + chat log + input + send                             │  │
│  │  dom-context.ts (M3): cleaned DOM / Readability extract      │  │
│  │  actions.ts (M5): dispatch click/fill/scroll events          │  │
│  └──────────────▲───────────────────────────┬────────────────────┘  │
│      commands   │ typed RPC (runtime Port)  │                       │
│                 │ (stream chunks up)        │                       │
│  ┌──────────────┴───────────────────────────▼────────────────────┐  │
│  │  Background (Chrome: MV3 service worker / FF: event page)     │  │
│  │   • message router        • LLM client: fetch(baseURL +       │  │
│  │   • screenshot capture      /chat/completions, stream:true),   │  │
│  │     captureVisibleTab/      SSE parse → port.postMessage      │  │
│  │     captureTab/debugger    • per-tab chat state (storage.     │  │
│  │   • storage (settings,      session + IndexedDB snapshots)    │  │
│  │     screenshot blobs)      • commands API (hotkey toggle)     │  │
│  └───────────────────────────┬───────────────────────────────────┘  │
└──────────────────────────────┼──────────────────────────────────────┘
                               ▼
                 Local LLM endpoint (OpenAI-compatible)
                 http://localhost:11434 (Ollama) / :1234 (LM Studio) / …

┌── Options page (extension page, full API access) ──┐
│  endpoint URL, model, API key, site settings,      │
│  hotkey info, "Test connection"                    │
└────────────────────────────────────────────────────┘
```

### Components (one WXT project)

| Component | Role |
|---|---|
| `entrypoints/background.ts` | RPC router, screenshot orchestration (M3), LLM streaming client (M2), hotkey command |
| `entrypoints/content/` | Injects pill + panel (closed Shadow DOM), DOM extraction (M3), actions (M5) |
| `entrypoints/options/` | Settings UI + connection tester |
| `shared/rpc.ts` | Typed request/response protocol over `runtime`/`tabs` messaging (Port-based streaming in M2) |
| `shared/settings.ts` | `storage.local` item with defaults (endpoint, model, key, per-site config) |
| `shared/types.ts` | Shared protocol types |

## 3. Key design decisions

### a) Panel UI: content script + closed Shadow DOM

A single host `<div id="browser-agent-root">` is appended to `document.body`; the UI lives in
`attachShadow({ mode: 'closed' })`, so page scripts cannot reach in and read the conversation, and
`all: initial` on the root blocks page CSS inheritance. CSS is bundled as a string
(`?inline`) and injected as a `<style>` inside the shadow root, so no page-visible CSS file and no
`web_accessible_resources` are needed.

Rejected alternatives:
- *Extension-page iframe* (Vimium's Vomnibar approach): strongest isolation but complicates
  positioning/dragging and messaging; overkill for a chat panel.
- *Native `chrome.sidePanel` / Firefox `sidebar_action`*: steals layout width, is not overlayable,
  and lives in a separate document. Kept as a future option; the snap mode below approximates it.

Panel modes:
- **Overlay (default):** floating panel under an auto-hiding pill. The pill slides into the right
  edge after ~1.2s idle and reappears on hover.
- **Snapped:** the dock button turns the panel into a full-height right sidebar that does *not*
  overlay the page — the page is narrowed by setting `margin-right` + `width: calc(100% - N)` on
  `<html>`. A drag handle on the panel's left edge resizes it (min 280px, persisted per tab in the
  page's `sessionStorage`). Caveat: pages with their own full-width `position:fixed` elements still
  span the viewport underneath — only a browser-native side panel reserves true layout space.

### b) Permissions model (Vimium-style)

```jsonc
"permissions": ["storage", "tabs", "activeTab", "scripting", "commands"],
"host_permissions": ["<all_urls>"]
```

- `<all_urls>` grants DOM access + `captureVisibleTab` in one shot; Vimium ships the same, so it is
  precedent-acceptable. A per-site kill switch (`settings.sites[origin]`) lets users disable the
  panel per origin without revoking the host grant.
- Non-localhost endpoints (e.g. `http://192.168.x.x:1234`) are already covered by `<all_urls>`;
  if that is ever narrowed, `optional_host_permissions` + a runtime `permissions.request` from the
  options page is the fallback.
- Hotkey: `commands` API, `toggle-panel`, default `Alt+Shift+B` (Mac: `MacCtrl+Shift+B`),
  user-remappable at `chrome://extensions/shortcuts`.

### c) Chat flow (the core loop, M2)

1. Panel sends `chat.send {text, embeds}` over a long-lived `runtime.Port` to the background.
2. Embed buttons stage context as **removable chips** attached to the next message:
   - **Embed HTML** → cleaned serialization: strip `<script>/<style>/<noscript>/<svg>/<iframe>`,
     drop inline `style` attrs, collapse whitespace, cap at `MAX_HTML_CHARS` (60k). Collected
     locally in the content script.
   - **Embed Screenshot** → background `captureVisibleTab(windowId, {format:'jpeg', quality:70})`
     (Firefox: `captureTab`), base64 data URL staged as a chip; sent along as an OpenAI-style
     `image_url` content part.
   - Smart/auto selection of context type is intentionally deferred; the chips are the manual
     mechanism.
3. Background builds `POST {endpoint}/chat/completions` with `stream:true`, parses SSE deltas, and
   forwards each chunk to the panel via `port.postMessage({type:'chat.delta'})`, ending with
   `chat.done`.
4. Rendering: treat everything from the LLM and the page as untrusted — `textContent` only
   (DOMPurify later if markdown rendering is added). Never `innerHTML` raw.

### d) Background lifecycle

MV3 service workers die after ~30s idle. Rules: all state in `storage`/IndexedDB (never module
globals), everything promise-based; active ports and in-flight fetches keep the worker alive. The
Firefox event-page build behaves identically through WXT's abstraction.

### e) Page actions (M5)

The LLM returns structured JSON (`{action:"click|fill|scroll|extract", selector|index, value}`) in
"act" mode; the content script resolves it against the live DOM — using indexed interactive
elements (browser-use style) rather than raw LLM-provided CSS — executes via `el.click()` /
`dispatchEvent(...)`, and confirms destructive actions with the user. Note: synthetic events lack
user activation, so clipboard/downloads/navigation-restricted APIs will not fire.

## 4. Storage map

| Data | Where | Why |
|---|---|---|
| Settings (endpoint, model, key, sites) | `storage.local` (`local:settings`) | Persistent config |
| Per-tab chat history | `storage.session` (M2) | Survives panel close, dies with the browser session |
| Screenshot blobs | IndexedDB (M3) | Binary blobs, LRU-evicted |
| Live stream buffer | In-memory in background while port is open | Ephemeral by nature |

## 5. Milestones

| Phase | Scope | Status |
|---|---|---|
| M1 | WXT scaffold, background + content + options, typed RPC, pill + panel toggle (click + hotkey), settings persistence, connection tester | **Done** |
| M2 | Chat: `chat.send` over a Port → OpenAI-compatible SSE streaming → render deltas live; per-tab history in `storage.session`; Stop (abort) support; history restore on panel open; tab-close cleanup | **Done** |
| M3 | Embed HTML + Embed Screenshot, simple form: chips staged on next message, cleaned/truncated DOM, JPEG screenshot as `image_url` | **Done (simple)** — remaining: Readability extraction, IndexedDB snapshot store, auto-selection of context type |
| M4 | Polish: auto-hide pill, snap-to-side resizable sidebar (done); remaining: per-site enable/disable UI, selection-aware "ask about this", error/toast states, icons | **In progress** |
| M5 | Page actions: structured action protocol + confirmation flow; Chrome-only full-page capture via `chrome.debugger` (opt-in) | Pending |

## 6. Build & run

```sh
npm install
npm run dev              # Chrome, HMR, auto-opens browser
npm run dev:firefox      # Firefox
npm run build            # .output/chrome-mv3
npm run build:firefox    # .output/firefox-mv3
npm run compile          # tsc --noEmit
```

Load unpacked from `.output/chrome-mv3` (chrome://extensions → Developer mode → Load unpacked) or
`.output/firefox-mv3` (about:debugging → This Firefox → Load Temporary Add-on).

## 7. Security notes

- Closed shadow root keeps conversation DOM out of page reach; page CSS is blocked by
  `all: initial` + shadow boundary.
- All dynamic text is inserted with `textContent`; no `eval`, no raw `innerHTML`, no
  `setTimeout(string)` anywhere.
- Chat content and page-derived data are untrusted input; never executed, only displayed or sent
  to the configured endpoint.
- API keys are stored in `storage.local` (local machine only); the extension makes no network
  calls other than to the user-configured endpoint.
