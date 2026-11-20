# Progress / State

> **Resume protocol (for agent sessions):** read this file first, then `git log --oneline -10`
> and `ACT_MODE.md`. Work in the phase marked "next", update this file in the same commit as the
> code, commit incrementally with phase-tagged messages (`A1: …`).

## Current status

- **Extension version:** 0.8.1 (agent-loop reliability fixes)
- **Act Mode phase:** A1–A3 done — next: **A4** (vision grounding, Wikipedia-hop end-to-end test,
  optional chrome.debugger trusted input)
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
- [ ] **A4 — Multi-page + grounding**: navigate ops across pages work via the loop; remaining:
  screenshot/vision grounding in observe, Wikipedia-hop end-to-end test, optional trusted input
- [ ] **A4 — Multi-page + grounding**: navigate/link ops across pages, readiness detection,
  screenshot/vision grounding, optional chrome.debugger trusted input (Chrome, opt-in)

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
