# Progress / State

> **Resume protocol (for agent sessions):** read this file first, then `git log --oneline -10`
> and `ACT_MODE.md`. Work in the phase marked "next", update this file in the same commit as the
> code, commit incrementally with phase-tagged messages (`A1: …`).

## Current status

- **Extension version:** 0.15.2 (staged TTS prefetch + auto-read stop button). A4 next.
- **v0.15.2 — TTS pipeline fixes from real uvicorn/Kokoro testing**:
  - **Speech started only after ALL chunk responses**: the initial prefetch fired 3 concurrent
    requests; servers that queue/batch concurrent requests (uvicorn workers, GPU locks) respond
    to the burst as a whole, so chunk 0's audio waited for the batch. Now the **first chunk fires
    alone**; once its response arrives (playback starting), up to `TTS_PREFETCH` (2) more chunks
    are kept in flight. If the next chunk is not back when the current one ends, the loop simply
    waits — a natural end-of-sentence pause — then continues (no skip/restart).
  - **Auto-read now drives the message's ▶ button**: `speakText` takes the message's TTS button —
    during auto-play it shows `…` then `⏹` (click = stop, previously it showed ▶ and a click
    triggered a duplicate read); the button resets on natural completion; the fallback
    (speechSynthesis) path manages the button too. `attachTts` returns the button.
  - **Per-chunk diagnostics**: `[panel] tts: chunk N/M fetched in Xms` + `playing chunk N/M at Xms`
    in the page console (relative to pipeline start) — makes server-side latency visible.
  - Button reset bug fixed: the chunked pipeline left the button stuck on ⏹ after the last chunk.
  - E2E: mock speech records carry arrival + response timestamps and support `voice=slow-<sec>`
    per-request delay; T11 asserts the staged recv pattern (first request alone, no upfront burst,
    refills tracking pipeline progress) and in-order coverage; T10/T11 concat checks are resilient
    to the mock's thread-scheduling record order (client playback order is FIFO by design). 70/70.
- **v0.15.1 — chunked TTS for fast first word**:
  - `speakWithEndpoint` splits the spoken text into sentence-ish chunks
    (`splitSpeechChunks`: split on `[.!?…]` + whitespace, merge to bounds — first chunk ≤160
    chars for low time-to-first-audio, later chunks ≤320; over-long sentences hard-split at
    word boundaries). Numbers like 3.14 and abbreviations don't split (whitespace required
    after the punctuation).
  - **Pipelined playback**: fetch chunk 0 → play immediately while up to 2 more chunks are in
    flight (`TTS_PREFETCH`); `ended → play next` from the prefetch queue (fetches start in
    order, queue order == chunk order), so playback is seamless with no inter-chunk fetch gap
    in the common case. Blob URLs revoked per chunk; `currentAudio` tracked so Stop pauses
    instantly; token guard discards stale results.
  - **Failure semantics**: chunk 0 fails → full fallback to built-in `speechSynthesis` (unchanged
    UX); a later chunk fails → stop cleanly with a console warning (no mid-read voice switch).
  - E2E: mock records per-chunk requests; T10 asserts first chunk ≤160 with the answer start,
    ≥3 chunks for a ~700-char answer, each ≤320, and the chunks concatenating back to the exact
    full text in order. Suite at 66/66.
- **v0.15.0 — endpoint TTS (voice of preference) + docs**:
  - **TTS endpoint** (`voice:speak` RPC → `background/voice.ts` `synthesizeSpeech`): OpenAI-compatible
    `POST {base}/v1/audio/speech` with `{model, input, voice, response_format:'mp3'}` — Kokoro served
    via uvicorn/fastapi works as is. Settings: `ttsEndpointUrl`, `ttsModel` (default 'kokoro'),
    `ttsVoice` (voice of preference, e.g. `af_heart`; omitted → server default), uses the chat API key.
    Audio returns base64 → blob URL → `HTMLAudioElement`; 60s timeout; errors logged and the panel
    falls back to built-in `speechSynthesis`.
  - **Playback state machine** (panel.ts): token-guarded (`ttsToken`) stop semantics so a Stop during
    the fetch/play window can't resurrect audio; play button shows `…` while loading, `⏹` while playing;
    object URLs revoked on stop/end/error; both the per-message ▶ button and auto-read go through the
    same path (endpoint first, browser voices fallback).
  - **STT path fixed** to the standard `{base}/v1/audio/transcriptions` (was missing `/v1`).
  - **Options → Voice**: TTS endpoint/model/voice fields + updated notes.
  - **Docs**: `docs/agent-loop.md` — the full Observe→Think→Act flow with file/function references.
  - **E2E**: mock `/v1/audio/speech` (generates a real WAV, records model/voice/input); T10 asserts the
    auto-read chain reaches the endpoint with the configured voice and that a dead endpoint falls back
    to built-in speech with a console warning while chat keeps working. Suite at 63/63.
- **v0.14.x**: working memory/effort (v0.14.0, experimental flag `agentWorkingMemory`); `[llm] POST`
  request logging + endpoint-in-errors (v0.14.1); answer-delivery fallback to the run summary (v0.14.2);
  eager panel port connect + finish catch-up (v0.14.3).
- **v0.14.0 — agent working memory + self-managed reasoning effort (experimental, default off)**:
  - Flag `agentWorkingMemory` (Options → Act mode, off by default). Off = byte-identical v0.13.1
    behavior. All work on the `fix/issue-1-kayak-dropdown-timeout` branch, unmerged.
  - **Response schema v2** (only when the flag is on): `{"v":2,"thought","memory","effort","actions"}`
    — parser stays tolerant of v1 replies (missing fields = no change).
  - **Working memory**: the model rewrites short working notes each step (goal interpretation,
    page model, what failed, plan; ≤600 chars guidance, 1200 hard cap). Stored per-run in agent
    state and re-injected into the next step's user prompt above the element index
    ("Working notes from your previous steps…"). Omitting the field keeps the previous notes.
  - **Self-managed effort**: `effort` returned at step N is forwarded as `reasoning_effort` at
    step N+1; `off` maps to `chat_template_kwargs:{enable_thinking:false}` (no reasoning_effort;
    harmless no-op on templates that ignore it); `default`/omitted/junk falls back to the
    configured `actReasoningEffort` setting. First step uses the setting.
  - **System prompt** built per-run: v2 schema + memory/effort rules only when enabled (keeps the
    static block prefix-cache friendly; unchanged bytes when off).
  - **Visibility**: memory/effort shown in the panel only with `debug` ON (in per-step details) and
    always logged to the SW console (`[agent] tab=N memory=…`); memory is also fed to
    `synthesizeAnswer` for better final summaries.
  - **E2E**: mock model `memsched` returns scheduled memory/effort and echoes what it RECEIVED
    (memory marker, truncation markers, received effort) in `thought` — T6 asserts injection,
    rewrite-carry, effort forwarding, `off`→thinking-disabled, junk-effort ignored, 1200-char
    truncation; T7 asserts flag OFF sends no memory section / no reasoning_effort / no thinking
    overrides (via mock `/debug/requests` records). Suite at 52/52.
  - Harness note: the agent prompt uses `filter(Boolean)` so blank-line separators collapse — the
    memory section sits directly above `Element index:` with single newlines.
- **Extension version:** 0.13.1 (issue #1 follow-ups from the first real-Kayak retest).
- **v0.13.1 — real-Kayak retest findings** (batched observations lost on navigation + trip-type
  dropdown still missed):
  - **Freshness rewritten as a diff against the last observed table** (replaces the
    mutation-recorded set): an element is fresh when it is absent from the previous table
    (new node, or was invisible/filtered) **or was already fresh** (sticky - stays pinned while
    it remains present, so an open dropdown stays clickable across steps; gone once closed).
    Catches Kayak-style pre-rendered popups toggled visible on a container anywhere in the DOM,
    which the mutation-target approach missed. First working version had a bug: inheritance from
    non-indexable ancestors (never in the previous WeakMap) marked EVERYTHING fresh - freshness
    is now per-element only, no inheritance.
  - **Action batches stop-and-report when the page starts navigating** (`executeActions`): after
    a `navigate` op, an anchor click (deferred 50ms), or a click/type+submit that the Navigation
    API reports as a cross-document navigation, remaining actions in the batch are returned as
    `ok:false - "skipped - the page is navigating; observe the new page next"` instead of the
    whole batch's RPC response dying with "message channel closed" (the observed
    `navigate → failed` / `wait → failed` on real Kayak). `wait` polls `navigation` and cuts
    itself short when navigation starts. The agent-side fallback message for a lost channel is
    now "the page navigated or reloaded before the actions finished reporting - observe the new
    page state before retrying".
  - E2E: T5 covers the batch-stop semantics (anchor click + navigate followed by wait/extract).
- **Extension version:** 0.13.0 (issue #1 fixes: portal dropdowns in the index, LLM timeout
  rework, post-submit verification). A4 (vision grounding) still next.
- **v0.13.0 — issue #1 (Kayak flight search: dropdowns never indexed, `signal timed out` death)**:
  - **Fresh-element pinning in the indexer** (`indexer.ts` + `act.ts`): the MutationObserver now
    records inserted nodes + attribute-mutated targets (excluding the extension's own hosts and
    body/html); `observePage()` builds the table with that set, marks those entries `fresh`, and
    `serializeTable()` pins fresh *interactive* entries (cap 60) at the TOP under a
    "Recently appeared (new since the last step…)" header, outside the 120/280 budgets. Body-end
    portals (Kayak's airport suggestion list) now always reach the model. Freshness = "changed
    since the previous observe", cleared per observe — survives long LLM think times (a
    time-based window did not: it expired during the 120s+ step calls).
  - **LLM timeout rework** (`llm.ts`): the single 120s `AbortSignal.timeout` became a
    **first-token timeout (default 120s) + generous total stream cap (default 600s)**; both
    configurable via `llmFirstTokenTimeoutMs` / `llmTotalTimeoutMs` settings (Options → endpoint
    form). Timeouts throw a typed `LlmTimeoutError` ("no response from the model within Ns…" /
    "stream exceeded Ns in total") — the raw `signal timed out` DOMException never reaches the
    UI; chat errors and the agent's double-timeout abort carry the specific reason.
  - **Post-submit verification** (`act.ts` type op): after `submit`, the observation waits 400ms
    and appends `[post-submit: …]` — the field's post-submit value (or "the field is gone"),
    plus nearby chip text found by searching the field's captured ancestor chain for the typed
    text. `submitForm` now dispatches Enter on the field FIRST (autocomplete handlers commit the
    suggestion + preventDefault) and only falls back to `form.requestSubmit()` — the old
    requestSubmit-first skipped combobox Enter handlers and navigated on plain forms.
  - **Agent prompt**: check whether the index already shows the desired state before re-entering
    values; "Recently appeared" section explained in the autocomplete rule.
  - **Answer synthesis moved out of the run slot** (`agent.ts`): `activeRuns` is released when
    the loop ends; `deliverAnswer()` runs independently with its own keepalive — previously a
    slow synthesis kept the tab "already running" and bounced the next goal.
  - **E2E harness** (`tests/`): Playwright + Chrome for Testing (MV3 extensions need headed
    Chrome → Xvfb) loading the built extension; local Kayak-like fixture (budget-exhausting
    page + body-end portal dropdown + chip commits) and a mock OpenAI SSE server with scripted
    / delay-first-N / dribble-N models. 32 checks incl. A/B against main's indexer (old code
    reproduces the issue: dropdown never indexed, run hits the 12-step limit). Panel is driven
    via its sessionStorage snap persistence + coordinate clicks (closed shadow DOM is not
    reachable via selectors or CDP DOM traversal).
- **Extension version:** 0.12.0 (C3 voice: mic STT + TTS). Kayak/MMT retest pending on user's
  machine; flight booking still imperfect (complex unique pages — accepted for now, move on).
- **Next phase: A4** (vision grounding in observe, Wikipedia-hop e2e test, optional
  chrome.debugger trusted input) — C-track done.
- **v0.12.0 (C3 — Voice)**:
  - **Mic button** between camera and composer input: click to dictate, click again to stop,
    Send stays manual (works for chat AND Act goals). Interim transcript renders live in the
    input (appended to whatever was already typed).
  - **STT**: Web Speech API (`SpeechRecognition`/`webkitSpeechRecognition`, continuous +
    interim) when available (Chrome/Edge); fallback = OpenAI-compatible
    `POST {base}/v1/audio/transcriptions` — MediaRecorder capture → base64 → RPC
    `voice:transcribe` → `background/voice.ts` posts multipart (`file` + `model`, chat API key
    if set, 60s timeout). Settings: `sttEndpointUrl`, `sttModel` (Options → Voice). Chrome mic
    permission is per-site (page origin); Firefox users must configure an STT endpoint.
  - **TTS**: `speechSynthesis` play button (▶/⏹) on every assistant message (also on restored
    history + agent-synthesized answers); markdown stripped before speaking (code blocks →
    "(code omitted)", links → anchor text). "Auto-read responses" toggle in Options
    (`ttsAutoRead`); playback stops on Send/Stop. Any new play cancels the previous one.
  - Sending while recording cancels capture (discards late transcripts) but keeps whatever
    interim text is already in the input.
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
- [x] **C3 — Voice (v0.12.0)**: done as described above — mic button (Web Speech API primary,
  OpenAI-compatible `/v1/audio/transcriptions` fallback via background RPC), per-message TTS
  play button + auto-read toggle.

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
