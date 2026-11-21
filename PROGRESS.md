# Progress / State

> **Resume protocol (for agent sessions):** read this file first, then `git log --oneline -10`
> and `ACT_MODE.md`. Work in the phase marked "next", update this file in the same commit as the
> code, commit incrementally with phase-tagged messages (`A1: …`).

## Current status

- **Extension version:** 0.11.0 (C1 auto page context + C2 camera/multi-screenshot). Kayak/MMT
  retest pending on user's machine; flight booking still imperfect (complex unique pages —
  accepted for now, move on).
- **Next phase: C3 (voice: mic STT + TTS)** — see "Chat context + voice phases" below.
  A4 (vision grounding, Wikipedia-hop e2e, chrome.debugger trusted input) deferred until after C3.
- **v0.11.0**:
  - **C1 — HTML button removed**; every chat send auto-attaches a fresh page snapshot captured
    at send time (`collectPageContext()` in dom-context.ts): act indexer outline
    (`serializeTable(buildElementTable())`) + `extractMainText()` (8k cap); falls back to raw
    cleaned HTML when both are near-empty (<600 chars). Navigation-safe — always the current DOM.
  - **Prompt-window policy**: only the LAST message carrying `pageContext` includes it in the
    LLM prompt (`buildApiMessages`); stored history keeps the last 2 snapshots
    (`trimStoredContexts`), older ones stripped to bound storage.session growth.
  - **C2 — camera icon button** (left of composer input) replaces the big "Embed Screenshot"
    button; each click APPENDS a numbered screenshot chip (`Screenshot 1`, `Screenshot 2`, …).
    Protocol: `chat.send.screenshots: string[]` / `ChatMessage.images` — one image part per
    screenshot; all messages keep their images in the prompt (explicit attachments stay).
  - `ChatMessage.html` renamed → `pageContext` (session-only history; old entries simply lose
    context). SYSTEM_PROMPT updated (outline attached automatically).
- v0.10.0 from Kayak/MMT failures (React-handler widgets, unverifiable typing, 120s timeout
  aborting runs):
  - **Cursor:pointer heuristic**: elements with `cursor:pointer` (React/Vue onClick widgets with
    no DOM attr) are indexed interactive (bounded: widget-host tags, textContent ≤ 400 chars) and
    clicked directly at execute time as last-resort drill-down
  - **All form fields are behavioral** now (input/textarea/select) — clicking a textbox focuses
    it instead of drilling to a parent label/div
  - **Type truth**: setValue returns readback; observation reports `field now "DEL"` and fails
    (`ok:false`) if the value didn't stick; readonly/disabled detected; contenteditable fields
    supported (select-all + insertText)
  - **`key` op**: `{"op":"key","target":N,"key":"Enter"}` — synthetic keydown/keyup for combobox
    flows; local command `key <Enter|ArrowDown|Escape|…> in <n>`
  - **Timeout retry**: LLM TimeoutError retries the step once instead of failing the whole run
  - Prompt guidance: autocomplete flow = type (no submit) → wait → click option row / press Enter
- **Act Mode phase:** A1–A3 done — next: **A4** (vision grounding, Wikipedia-hop end-to-end test,
  optional chrome.debugger trusted input)
- v0.9.2: since v0.8.0 the agent only runs with Act mode ON, and Act's document-level capture
  click listener (`preventDefault` + `stopPropagation` to enable pinning) was swallowing the
  executor's own synthetic `el.click()` — anchors never navigated, model looped on dead clicks.
  Fix: `isSyntheticClick()` depth guard in executor.ts bypasses the capture listener during
  executor-driven clicks; anchor clicks defer 50ms (like `navigate`) so the observation response
  escapes before unload.
- **Act Mode phase:** A1–A3 done — next: **A4** (vision grounding, Wikipedia-hop end-to-end test,
  optional chrome.debugger trusted input)
- v0.9.1 fixes from the Main-Page stuck-click run (agent clicked `[297] li` 6× while `[298] a`
  held the href):
  - **Click drill-down** (`findClickTarget` in executor.ts): if the target has no behavior, click
    the nearest interactive *descendant* (a[href]/button/[role]/[onclick], visible), else nearest
    interactive ancestor; observation reports what was actually clicked incl. href and
    "drilled from [N]"
  - **Non-interactive = explicit failure**: content elements with no clickable inside return
    `ok:false — "is a listitem, not clickable - click a link/button inside it, or extract it"`
    so the model never burns steps on silent no-ops
  - **Type drill-down**: type falls back to input/textarea descendants
  - **No-progress guard**: 3 consecutive steps with same URL + same primary target inject a
    WARNING into the next prompt forcing a different element/strategy
  - System prompt rule added: click only interactive roles; content roles are for extract
- **Act Mode phase:** A1–A3 done — next: **A4** (vision grounding, Wikipedia-hop end-to-end test,
  optional chrome.debugger trusted input)
- v0.9.0 fixes from HAR/log analysis of the Ram→Rama→Rama Navami runs:
  - **Snapshot pinning (the "Dhyana mystery")**: `act:observe` builds a fresh table and PINS it;
    `act:execute` uses the pinned table instead of rebuilding — ids in the prompt now always
    match ids at execute time. Previously MutationObserver-driven rebuilds renumbered ids between
    observe and execute → wrong element clicked ("ok — avatars" → Dhyana page) → cascade of
    bfcache/channel-closed errors
  - **Empty-index readiness retry**: observe results with near-empty index are retried until the
    15s deadline (page still rendering after navigation)
  - **Serialization budget rebalance**: max 280 entries = 120 interactive + 160 content; unnamed
    entries and `label` elements dropped — article text is now visible to the model
  - **`extract` with no target** = main-text extraction (main/article/[role=main] heuristic, 8k
    cap) so the model can read articles; `extract all` local command too
  - **Answer synthesis**: after every non-stopped run, the bg makes one streaming call over the
    goal+narration and posts the final answer into chat history + panel as a real assistant
    message (`chat.answer`) — runs no longer end silently
- v0.8.3: replaced `window.setInterval/clearInterval/setTimeout` with bare globals in background
  context (keepalive.ts, agent.ts delay()) — `window` is undefined in MV3 service workers; the
  crash killed runLoop before the first LLM call (v0.8.2 regression).
- **Act Mode phase:** A1–A3 done — next: **A4** (vision grounding, Wikipedia-hop end-to-end test,
  optional chrome.debugger trusted input)
- v0.8.2 fixes from real-world agent testing (Wikipedia hops, flight sites):
  - **Keepalive** (`background/keepalive.ts`, refcounted 20s API ping): holds the MV3 SW alive
    during long agent runs AND chat streams — kills the "SW died mid-run → silent death, dead
    Stop, decaying inference" class
  - **Runs are terminal + persisted**: status now `idle|running|finished`; narration is complete
    (errors + final summary pushed into it); `getAgentSummary` replays state even when finished;
    panel shows "Last agent run … type `agent log` to replay" after navigation instead of
    vanishing
  - **`agent log` command** replays the stored run; **`debug` command** toggles per-step details
    (observe entry count + ms, LLM ms + chars, parse retries) shown in the panel and always
    logged to the SW console (`[agent]` prefix)
  - **Confirm semantics**: ask-first OFF now confirms only high-risk buttons
    (delete/remove/pay/checkout/buy/sign out/place order/trash); `submit:true` no longer forces a
    prompt. Ask-first ON confirms every click/fill.
- v0.8.1 reliability fixes (root cause: MV3 SW death during minutes-long NON-streaming agent
  calls on huge indexes → in-flight request dropped, activeRuns lost, Stop no-op, panel stuck):
  - `background/llm.ts`: shared `streamChat()` — ALL LLM calls now stream (keeps SW/connection
    alive), 120s hard timeout via `AbortSignal.any([run, timeout])`, timeout surfaced as clean
    error; chat.ts refactored onto it
  - Index cap: `serializeTable(table, maxEntries=280)` — interactive elements prioritized, 
    truncation note appended (fixes prompt bloat on flight/e-commerce pages)
  - **Auto-resume**: `resumeAgentIfStale(tabId)` on every port connect — if storage says running
    but no active run (SW restarted), the loop resumes from saved state/step
  - **Stop hardening**: stopAgent marks stale running state idle; panel Stop falls back to
    force-unlock after 2s if no done/error arrives
- v0.8.0 redesign highlights:
  - **Composer is just [input][Send]** — Agent button + autonomy select removed. Send behavior:
    Act OFF → chat; Act ON → agent goal; `click 12`-style commands always local; Send reads
    **Stop** (red) while a chat stream or agent run is active and routes the click accordingly.
  - **Ask-first toggle lives in the Act banner on the page** (click it): ON = confirm every
    click/fill, OFF = confirm only destructive/submit (hard rail).
  - **Port registry** (`tabPorts` in background/chat.ts): all chat/agent notifications route via
    `getTabPort(tabId)` — fixes the dead-port "greyed forever" bug after navigations.
  - **Per-mode LLM config** in Options: act endpoint/model (blank = reuse chat), optional
    `reasoning_effort` (only sent when set), extra agent instructions appended to AGENT_SYSTEM.

## Base extension milestones (done)

- [x] M1 WXT scaffold, RPC, pill + panel, options page (v0.1.0)
- [x] M2 streaming chat over Port, per-tab history, Stop (v0.2.x)
- [x] M3 simple embeds: HTML chips + screenshot chips (v0.2.0)
- [x] Endpoint normalization (/v1 handling) (v0.2.1–0.2.2)
- [x] Reasoning-model stream rendering (v0.2.3)
- [x] Auto-hide pill + snap-to-side resizable sidebar (v0.3.0)
- [x] Markdown rendering (marked + DOMPurify) (v0.4.0)
- [x] Chat clear + Markdown export (v0.5.1)
- [x] GitHub repo: https://github.com/1decodemaster/browser-agent (private)

## Act Mode phases

- [x] **A1 — Indexer + Spotlight + action bar** (v0.5.0)
  - `entrypoints/content/act/`: indexer.ts (element table, accessible names, `serializeTable()`
    ready for LLM prompts), spotlight.ts (overlay: highlight boxes w/ intent colors + pulse,
    label chip, action bar, fill bar, banner), executor.ts (click/focus/React-safe setValue/copy
    with execCommand fallback), act.ts (mode toggle via panel "Act" button, hover highlight via
    rAF-throttled elementFromPoint, click-capture pin, per-kind action bar, MutationObserver
    dirty-flag rebuild, Esc = unpin then exit)
  - "Ask about this" prefills chat input via `prefillInput` export; panel Escape handler disabled
    while Act mode is on
- [x] **A2 — Executor + declarative schema** (v0.6.0)
  - `shared/protocol.ts`: ActionOp grammar (click/type/scroll/extract/navigate/wait/done) +
    ActionObservation
  - `act/commands.ts`: strict local command grammar (`click 12`, `type "x" into 17 [and submit]`,
    `clear 17`, `extract 23`, `scroll top|bottom|up|down`, `navigate <url>`, `help`) — non-matching
    input still goes to the LLM
  - `act.ts executeActions()`: sequential executor w/ Spotlight narration, stale-index detection,
    confirmation gate (red confirm bar) for destructive names (delete/pay/submit/sign out/…) and
    `submit:true`, form.requestSubmit + Enter fallback
- [x] **A3 — Agent loop** (v0.7.0)
  - `entrypoints/background/agent.ts`: per-tab state (`session:agent:{tabId}`), 12-step loop,
    Observe→Think→Act, JSON-only action prompts + tolerant parse with one retry, observe retry
    (15s) doubles as post-navigation readiness detection, Stop via port + AbortController,
    narration replay on panel remount
  - Composer: Agent button (flips to red Stop while running) + autonomy select
    (Supervise = confirm every action on-page, Normal = destructive-only confirms, Auto = none);
    chat send/embeds disabled while the agent runs
  - RPC: `agent:get` (bg), `act:observe` / `act:execute{confirmMode}` (bg→content)
- [ ] **A4 — Multi-page + grounding** (DEFERRED until after C3): cross-page navigate works via
  the loop; remaining: screenshot/vision grounding in observe, Wikipedia-hop end-to-end test,
  optional chrome.debugger trusted input (Chrome, opt-in)

## Chat context + voice phases (planned)

- [x] **C1 — Auto page context (v0.11.0)**: done as described above — snapshot at send time,
  outline + main text with raw-HTML fallback, prompt-window keeps only the newest snapshot,
  storage keeps the last two.
- [x] **C2 — Camera button + multi-screenshot (v0.11.0)**: done as described above — small
  camera icon in the composer, append-only numbered chips, `screenshots: string[]` protocol with
  one image part per screenshot.
- [ ] **C3 — Voice (v0.12.0)**: mic button in the composer that fills the input with the
  transcript — works for chat AND Act goals alike (Send stays manual).
  - STT: Web Speech API (`webkitSpeechRecognition`) when available (Chrome); fallback =
    OpenAI-compatible `/v1/audio/transcriptions` (MediaRecorder capture → base64 POST), new
    settings `sttEndpointUrl` + `sttModel` (blank = disabled). Interim transcript rendered live
    in the input.
  - TTS: play button per assistant message via `speechSynthesis` (local voices, both browsers)
    + optional "auto-read responses" toggle in settings; playback stops on Send/Stop.

## Decisions log

- Act mode captures clicks while active (explicit mode; Vimium-visual-style). Esc unpins, Esc
  again exits. Panel Escape handler is disabled while Act mode is on.
- Clicks inside the extension's own closed shadow roots are ignored by the pin logic (retargeted
  to host ids `browser-agent-root` / `browser-agent-act-root`).
- Snap/sidebar state lives in the page's `sessionStorage` (`__ba_ui`); Act mode state is
  session-only (off on reload).
- Element table rebuilds lazily on dirty flag from MutationObserver; never mid-action.
- v1 agent (A3) is tab-scoped; state in `storage.session`, never in the page.

## Open issues / known caveats

- Pages with full-width `position:fixed` navbars underlap the snapped sidebar (inherent to
  content-script sidebars; native sidePanel is the eventual fix).
- Reasoning models: only `content` deltas are saved to history; reasoning shown dimmed and capped.
- Clipboard write may need the execCommand fallback on some pages.

## Environment notes

- Node must be >= 20.12 for WXT 0.21: use `PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"`
  for npm/wxt commands on this machine.
- Verify with: `npm run build` + `npm run build:firefox` + `npm run compile`, ship zip via
  `npm run zip` (`.output/browser-agent-<ver>-chrome.zip`).
