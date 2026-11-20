# Act Mode — Spotlight module design

> Status and progress are tracked in `PROGRESS.md`. This document is the design contract for the
> Act Mode phases (A1–A4).

Act Mode turns the extension from a chat box into an agent that can see, highlight, and operate
page elements. Everything hangs off one data structure and one visual layer.

## 1. The element index ("lattice")

Built on demand by the content script; the shared language between humans, visuals, and the LLM.

- Scanner walks the DOM (piercing open shadow roots), skipping script/style/svg/iframe and the
  extension's own hosts.
- Indexes **interactive** elements (`a`, `button`, `input`, `textarea`, `select`, `[role=…]`,
  `[onclick]`, contenteditable, summary) and **content** elements (`p`, `h1`–`h6`, `li`, `td`,
  `blockquote`, `figcaption`, `img`+alt, `pre`/`code`).
- Each entry: integer id, tag, role (explicit `role` attr or implicit ARIA mapping), accessible
  name (aria-label → placeholder → label[for] → alt → innerText → title → value), href, viewport
  rect. Lookup maps both ways (id ⇄ element).
- Serialization for the LLM is token-cheap (~1–2 kB/page vs ~60 kB raw HTML):
  `[12] button "Sign in"` / `[31] link "Charlemagne" → /wiki/Charlemagne`.
- A `MutationObserver` marks the table dirty; it is rebuilt lazily (never while an action is in
  flight). Stale ids are detected and the agent is told to re-observe (A3).

## 2. Spotlight — the visual layer

A dedicated closed-shadow-root overlay (`position: fixed`, `pointer-events: none` pool of boxes
positioned over `getBoundingClientRect()`s; the page DOM is never touched for visuals):

- **Focus highlight**: pulsing outline + label chip `[12] button · "Sign in"`. Boxes *animate*
  between targets so multi-step actions read like attention moving through the page.
- **Sweep** (A3): rapid sequential highlights while the agent enumerates candidates.
- **Intent colors**: blue = focus/observe, green = success, red = error/needs confirmation,
  gray = scan/hover.
- **Drill-down**: scroll-into-view + spotlight.
- **X-ray** (optional, later): dim page, cut a hole around the target.
- **Human picking**: hover highlights; click pins and captures the click (Act mode is explicit —
  page navigation is suppressed while it is on; `Esc` unpins, `Esc` again exits).

## 3. Context-sensitive action bar (human-driven, A1)

Pinned element + its kind → floating action bar (overlay layer, never page DOM):

| Element | Actions |
|---|---|
| p / heading / li / td / blockquote | Copy · Ask about this |
| img | Copy alt · Ask about this |
| a | Open · Copy link · Ask about this |
| button | Click · Ask about this |
| input / textarea / select | Fill… · Clear · Focus · Ask about this |

"Ask about this" prefills the chat input with the element reference and text. Fill uses the
React-compatible native-setter trick (`prototype.value.set` + `input`/`change` events) so SPA
frameworks notice. Copy uses `navigator.clipboard` with an `execCommand` fallback.

The action bar exercises exactly the primitives the agent (A3) will call programmatically.

## 4. Declarative instruction set (A2)

Versioned JSON grammar, tolerant-parsed from the model's reply (schema-in-prompt works on every
OpenAI-compatible local server; later it can become real function-calling tools):

```json
{ "v": 1,
  "thought": "The search box is index 17",
  "actions": [
    { "op": "click",   "target": 17 },
    { "op": "type",    "target": 17, "text": "Ottoman Empire", "submit": true },
    { "op": "wait",    "ms": 400 },
    { "op": "extract", "target": 40, "note": "grab section heading" },
    { "op": "done",    "summary": "Opened the History section" }
  ]}
```

Ops: `click`, `type`, `scroll`, `extract`, `navigate`, `wait`, `done`. Safety rails: op allowlist,
no actions on invisible elements, confirmation gate for destructive ops, per-turn action cap, max
steps, global Stop, hard timeout.

## 5. Agent loop (A3)

- **Background = brain**: goal, plan, step transcript, autonomy level per tab (`storage.session`);
  survives page navigations. **Content script = hands and eyes**: index, execute, highlight,
  screenshot on request.
- Loop: pull element table (+screenshot if vision model, +trimmed HTML for gnarly pages — existing
  embed machinery) → prompt → parse actions → execute with Spotlight visuals → observation →
  repeat until `done` / max steps / user Stop.
- **Autonomy levels**: Supervise (approve each step), Normal (auto safe ops, confirm destructive),
  Auto. Every step is narrated in the panel and visible on the page.
- **Multi-page (A4)**: `click` on links / `navigate` triggers real loads; the content script
  re-injects, the background detects readiness, pulls the fresh table, continues the same goal.
  Tab-scoped by design in v1. (Wikipedia hops are the canonical test.)

## 6. Platform constraints (honest list)

- Synthetic events are `isTrusted: false` — fine for React/Vue/etc., but user-activation-gated
  APIs (clipboard in some cases, file pickers, auth popups, payments) may refuse. Mitigation
  ladder: dispatchEvent → (Chrome, opt-in) `chrome.debugger` trusted input (shows the debugging
  banner) → "needs a human click" with a highlighted target.
- Closed shadow roots of other extensions are invisible; open ones are pierced.
- Virtualized lists / canvas apps: index only the visible window; re-index on scroll.

## 7. Module layout

```
entrypoints/content/act/
  indexer.ts     DOM → element table (accessible-name heuristics), serializer
  spotlight.ts   overlay: highlights, label chip, action bar, fill bar, banner
  executor.ts    click/focus/setValue/copy primitives
  act.ts         controller: mode toggle, hover, pin, action-bar wiring
  act.css        overlay styles
entrypoints/background/agent.ts   (A3) loop, prompts, autonomy, per-tab state
shared/protocol.ts                (A2) element-table + action-schema types
```

## 8. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| A1 | Indexer + Spotlight + action bar (hover, pin, Copy/Ask/Open/Click/Fill/Clear/Focus) | Works with no LLM on real pages incl. SPAs |
| A2 | Executor + JSON schema, manual drive from chat | "click 17", "type X into 17" work with confirmations |
| A3 | Agent loop (Observe→Think→Act), autonomy levels, Stop, step narration | Multi-step goal completes on one page |
| A4 | Multi-page goals, vision grounding, optional trusted-input mode | Wikipedia hop goal completes end-to-end |
