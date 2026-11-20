# Progress / State

> **Resume protocol (for agent sessions):** read this file first, then `git log --oneline -10`
> and `ACT_MODE.md`. Work in the phase marked "next", update this file in the same commit as the
> code, commit incrementally with phase-tagged messages (`A1: …`).

## Current status

- **Extension version:** 0.4.0 (base) — chat, embeds, snap sidebar, markdown rendering
- **Act Mode phase:** **A1 in progress** (design agreed, implementation started this session)
- **Next up:** finish A1, then A2

## Base extension milestones (done)

- [x] M1 WXT scaffold, RPC, pill + panel, options page (v0.1.0)
- [x] M2 streaming chat over Port, per-tab history, Stop (v0.2.x)
- [x] M3 simple embeds: HTML chips + screenshot chips (v0.2.0)
- [x] Endpoint normalization (/v1 handling) (v0.2.1–0.2.2)
- [x] Reasoning-model stream rendering (v0.2.3)
- [x] Auto-hide pill + snap-to-side resizable sidebar (v0.3.0)
- [x] Markdown rendering (marked + DOMPurify) (v0.4.0)
- [x] GitHub repo: https://github.com/1decodemaster/browser-agent (private)

## Act Mode phases

- [ ] **A1 — Indexer + Spotlight + action bar** ← current
  - indexer.ts (element table, accessible names, serialize), spotlight.ts (overlay: highlight,
    label chip, action bar, fill bar, banner), executor.ts (click/focus/setValue/copy), act.ts
    (mode toggle, hover, pin, wiring), panel Act toggle + Escape coordination, "Ask about this"
    prefills chat input
- [ ] **A2 — Executor + declarative schema**: JSON action grammar (click/type/scroll/extract/
  navigate/wait/done), tolerant parse, confirmations for destructive ops, manual drive from chat
- [ ] **A3 — Agent loop**: background orchestrator, Observe→Think→Act, autonomy levels (Supervise/
  Normal/Auto), Stop, step narration, sweep highlights
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
