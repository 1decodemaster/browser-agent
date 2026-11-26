# Browser Agent

A cross-browser (Chrome + Firefox) WebExtension that puts an LLM chat panel on every page. Ask
questions about what you are looking at, attach screenshots, dictate with your voice — and flip
on **Act mode** to let the model actually operate the page for you: it indexes the DOM, clicks,
fills forms, navigates, and narrates every step.

Works with any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, llama.cpp server, or a
remote API. Your data goes only to the endpoint you configure; there is no telemetry and no
third-party service.

## Features

- **Chat about the page** — the page's DOM outline (interactive elements + main text) is
  attached to every message automatically, so the model always has current context, even after
  you navigate.
- **Streaming responses** with reasoning-model support (thinking shown dimmed, answers rendered
  as sanitized Markdown).
- **Screenshots** — a camera button in the composer; every click appends a numbered screenshot
  chip, and all of them are sent to the model as images.
- **Voice** — a mic button transcribes your speech into the composer (Chrome/Edge use the
  browser's built-in speech recognition; Firefox can use any OpenAI-compatible whisper-style
  STT server). Assistant replies get a ▶ read-aloud button, with an optional auto-read toggle.
- **Act mode** — the model indexes the page into a numbered element table, shows Spotlight
  highlights as it works, and runs an autonomous Observe → Think → Act loop (15 turns by default,
  configurable up to 100 in Options) toward a goal you type into the composer.
- **Per-tab history** — each tab keeps its own chat, cleared when the tab closes. Export any
  conversation as Markdown.

## Requirements

- Node.js **≥ 20.12** (for building only)
- Chrome 120+ or Firefox 128+
- An OpenAI-compatible LLM endpoint (local or remote)

## Installation (from source)

```bash
git clone https://github.com/1decodemaster/browser-agent.git
cd browser-agent
npm install
npm run build          # Chrome build → .output/chrome-mv3
npm run build:firefox  # Firefox build → .output/firefox-mv3
```

### Chrome / Edge

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select `.output/chrome-mv3/`

Or use the packaged zip: `npm run zip` produces `.output/browser-agent-<version>-chrome.zip`.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select any file inside `.output/firefox-mv3/` (e.g. `manifest.json`)

Temporary add-ons are removed when Firefox restarts; for persistent use, sign the build with
Mozilla's [web-ext tooling](https://extensionworkshop.com/documentation/publish/).

## Configuration

Open the extension's **Options** page (right-click the toolbar icon → Options, or via
`chrome://extensions` → Details → Extension options).

### Chat

| Setting | Description |
| --- | --- |
| Endpoint URL | Base URL of an OpenAI-compatible server, with or without `/v1` (e.g. `http://localhost:11434`) |
| Model | Model name, e.g. `llama3.2` |
| API key | Optional; sent as `Authorization: Bearer …` for remote endpoints |

Local server notes:

- **Ollama**: start it with `OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve`
  so it accepts the extension's origin.
- **LM Studio**: enable CORS in the local server settings.
- **vLLM / other remote servers**: set the API key if the server requires one.

### Act mode (optional overrides)

Leave blank to reuse the chat settings.

- **Act endpoint URL / Act model** — a different (e.g. stronger) model for driving the page
- **Reasoning effort** — sent as `reasoning_effort` only when set
- **Extra instructions** — appended to the agent's system prompt (site-specific tips, style rules)

### Voice

- **STT endpoint URL / STT model** — optional fallback speech-to-text server
  (OpenAI-compatible `POST {base}/v1/audio/transcriptions`, e.g. a faster-whisper server).
  On Chrome/Edge the built-in Web Speech API is used automatically when no endpoint is set.
- **Auto-read assistant responses** — read every reply aloud via the browser's speech synthesis.

## Usage

Toggle the panel with the pill button or **Alt+Shift+B** (Mac: **MacCtrl+Shift+B**).

### Chat mode (Act off)

Just type and send. Page context is attached automatically; click the camera to add screenshots.
Useful prompts: "summarize this article", "what does the pricing table say?", "compare this
product with the one in my screenshot".

### Act mode (Act on)

Click **Act** in the panel header — the page gets indexed and element numbers appear on hover.
Anything you send becomes an **agent goal** that the model pursues autonomously ("find the
cheapest direct flight on March 3 and open it"). The **Autonomy** button in the on-page banner
cycles confirmations: **normal** confirms only high-risk actions (delete, pay, checkout, sign
out, send, submit, …); **ASK FIRST** confirms every click/fill; **AUTO (no confirms)** skips all
confirmations — the agent fills and submits freely, so use it only on pages you trust. Send turns
into a red **Stop** while a run is active.

### Local commands

Always available in the composer (anything else goes to the LLM):

```
click <n>                          click indexed element
type "text" into <n> [and submit]  fill a field
key <Enter|ArrowDown|…> in <n>     press a key on a field
clear <n>                          empty a field
extract <n>                        read element text into the chat
extract all                        read the page's main text into the chat
scroll top|bottom|up|down
navigate <url>
agent log                          replay the last agent run for this tab
debug                              toggle per-step agent timings
```

## Permissions and privacy

- `storage`, `tabs`, `activeTab`, `scripting`, `commands` + host access to `<all_urls>` — needed
  to inject the panel, index the page you are on, and capture screenshots on demand.
- Page content, screenshots, and audio are sent **only** to the endpoints you configure.
- Nothing is ever sent anywhere else; history lives in the browser's session storage and dies
  with the tab.

## Development

```bash
npm run dev            # Chrome with auto-reload
npm run dev:firefox    # Firefox with auto-reload
npm run compile        # type-check (tsc --noEmit)
```

- `entrypoints/content/` — panel UI, page-context collector, and Act mode
  (`act/indexer.ts` element table, `act/spotlight.ts` overlays, `act/executor.ts` actions,
  `act/act.ts` controller, `act/commands.ts` grammar)
- `entrypoints/background/` — MV3 service worker: chat streaming, agent loop (`agent.ts`),
  keepalive, STT proxy (`voice.ts`)
- `shared/` — protocol, types, settings, RPC helpers
- `entrypoints/options/` — settings page

`DESIGN.md`, `ACT_MODE.md`, and `PROGRESS.md` document the architecture, the Act-mode contract,
and the full version history / resume protocol for contributors.

## License

Private project — all rights reserved.
