# Agent loop — how a run works

> Reference for `v0.20.x`. Generated from the fix-branch code; line numbers drift, function
> names are stable. The loop lives in `entrypoints/background/agent.ts`; the page side in
> `entrypoints/content/act/`.

```
You (panel)                 Background SW (agent.ts)              Page (content script)
    │  agent.start (port)          │                                    │
    ├─────────────────────────────►│ startAgent                         │
    │                              │ runLoop  ── loop ≤ MAX_STEPS ──────┤
    │                              │   │                                │
    │                              │   │ 1. OBSERVE                    │
    │                              │   ├──act:observe (RPC)────────────►│ observePage
    │                              │   │  ▲ index string                │   buildElementTable (fresh diff)
    │                              │   │                                │   serializeTable (320 cap,
    │                              │   │ 2. THINK                       │    "Recently appeared" pinned)
    │                              ├──completeOnce                      │
    │                              │   │  agentSystem (prompt)          │
    │                              │   │  effortExtraBody (effort)      │
    │                              ├──streamChat (llm.ts)──────────────► HTTP POST {base}/v1/chat/completions
    │                              │   │  ▲ streamed reply              │   (SSE deltas; first-token 120s +
    │                              │   │                                │    total 600s abort controllers)
    │                              │   │  parseActionResponse ──► {thought, memory?, effort?, actions}
    │                              │   │  coerceAction ──► validated ops
    │                              │   │ 3. ACT                        │
      │                              ├──act:execute (RPC)────────────────►│ executeActions
      │                              │   │  ▲ observations[]              │   runAction → click/type/key/
      │                              │   │                                │   select/find/inspect/focus/
       │                              │   │                                │   extract/navigate/wait/look;
        │                              │   │                                │   confirm gate; submitForm
        │                              │   │                                │   (Enter-first); look is
        │                              │   │                                │   captured loop-side (R5);
       │                              │   │                                │   batch stops on nav
    │                              │   │ 4. NARRATE + PUSH              │
    │  ◄── agent.step (port) ───────┤ notify (tabPorts)                  │
    │                              │   repeat: done/stop end,            │
    │                              │   blocked/step-cap pause            │
    │  ◄── chat.answer (port) ──────┤ deliverAnswer ──► synthesizeAnswer │
```

## Stage by stage

1. **Start** — `background/chat.ts` `watchChatPorts()`: every panel connects a port named
   `chat`; the SW keeps them in `tabPorts` (`getTabPort`). `agent.start` →
   `agent.ts` `startAgent`: persists per-tab `AgentState` (`storage.session` key
   `agent:<tabId>`: goal, step, narration, working memory, next effort), spawns `runLoop`,
   and releases the run slot (`activeRuns`) as soon as the loop ends.

2. **Observe** — `observeWithRetry` RPCs `act:observe` into the tab, retrying up to 15s
   (doubles as post-navigation readiness detection). Content side `act.ts` `observePage()`
   builds the element table (`indexer.ts` `buildElementTable(previous)`) — freshness is a diff
   against the last *observed* table (new/visibility-toggled elements, sticky while present);
   element **ids persist across observations** while an element lives (module-level WeakMap +
   counter), so ids referenced in earlier narration keep pointing at the same node —
   and serializes under the 320-entry budget (150 interactive; fresh first, then in-viewport,
   then DOM order) with fresh interactive entries pinned at the top under a "Recently appeared"
   header. Lines carry live state: `= "value"` / selected option + `opts:` for selects,
   `[checked]`, `[disabled]`, `[expanded]` (`serializeTable`).

3. **Think** — `completeOnce` assembles: system prompt (`agentSystem`: base rules; v2 schema +
   memory/effort rules only when `agentWorkingMemory` is on), goal, step N of the step budget
   (`state.maxSteps`, default 12), page title/URL, working notes, the tab's last ~10 chat
   messages (`Conversation with the user …`, oldest first, so a resumed/blocked run sees its own
   question and answer), element index, last-6 narration lines, feedback (stuck + idle warnings
   ride here). `effortExtraBody` maps the
   model's self-chosen `effort` (`low|medium|high|off|default`) to `reasoning_effort` or
   `chat_template_kwargs:{enable_thinking:false}`. `llm.ts` `streamChat` does the streaming POST:
   first-token timeout (default 120s) + total stream cap (default 600s) via one AbortController,
   typed `LlmTimeoutError`, `[llm] POST …` logged per attempt.

4. **Parse** — `parseActionResponse` tolerantly extracts the JSON object (fenced or bare),
   `coerceAction` whitelists ops (`click/type/key/select/find/inspect/focus/scroll/extract/
   navigate/wait/done`). The reply also carries a plan-level `status`
   (`continue`|`done`|`blocked`, default `continue`) and a `summary`. Invalid replies retry once
   with feedback; two consecutive timeouts abort the run with a readable error.

5. **Act** — `executeOnContent` RPCs `act:execute` → `executeActions` runs ops sequentially
   against the **pinned** table (ids in the prompt == ids at execute time). Confirmation:
   `confirmMode = askFirst ? 'always' : 'destructive'`; destructive asks on HIGH_RISK names
   (delete/remove/pay/purchase/checkout/buy/sign out/log out/place order/trash/empty/**submit**/
   **send**) and on any `type` with `submit:true` (R1: Auto keeps the submit rail). The bar renders
   via `awaitConfirm`, which flips the spotlight root visible even with Act mode off (a run that
   survived a navigation gets an *unclickable invisible* bar otherwise → dead run), focuses Confirm
   (Enter = yes), and publishes its center to `sessionStorage['__ba_confirm']` while pending (test
   hook; closed shadow DOM is otherwise unreachable). A pending confirm resolves false on `pagehide`
   (the document is going away). Batch semantics: once an action starts a cross-document navigation
   (navigate op, anchor click, Navigation API detection, type+submit), remaining actions are
   reported `skipped - the page is navigating` and the response escapes before unload. `type`
   reports a post-submit readback (field value + nearby chip text). `submitForm` dispatches Enter on
   the field first (autocomplete commit), falling back to `form.requestSubmit`. The loop then
   settles before the next observe: 800 ms after a navigating batch, 400 ms otherwise
   (`ActionObservation.navigating`, carried by the channel-lost fallback too). Reasoning ops
   (R3): `select` sets a native `<select>` through the prototype value setter + input/change
   (option matched by text or value; a miss lists the options) and joins the batch navigation
   check; `find` matches indexed elements by name/state/text, then falls back to any visible
   element whose own direct text matches — those are added to the table on the fly
   (`markDiscovered`, ids persist into later tables) with each non-interactive hit listing the
   interactive controls in its nearest container; `inspect` reports text, ordinal position,
   before/after text, ancestor context, and the controls sharing the container; `focus` focuses
    a field. Read-only ops never ask for confirmation. ≤8 ops run per step (R4): the prompt
    makes the model keep navigation/submission/menu-open last, and the loop splices off any
    overflow with a `batch → failed — dropped N action(s)…` observation. **`look` (R5)** is a
    loop-level op, never forwarded to the page (the page side reports it loop-handled): with
    `Settings.actVision` on (Options → Act mode), the loop captures the tab
    (`background/screenshot.ts`: Chrome `captureVisibleTab` / Firefox `captureTab`) and stores
    the JPEG as `state.pendingScreenshot`; the *next* `completeOnce` attaches it as an
    `image_url` part with a marker line and consumes it (one shot per look). Vision off →
    `look → failed` pointing at the Options switch; the prompt only advertises the op when the
    gate is on (it costs tokens).

6. **Narrate + push** — observations are formatted into the narration (trimmed to 40 lines /
   16k chars), pushed over the panel port via `notify` (`agent.step`). A missing port is logged
   (`notification dropped`) instead of failing silently.

7. **Finish or pause** — a `done` op / `status:"done"`, an error, or `run.stop` ends the loop;
   `status:"blocked"` or hitting the step budget *pauses* instead (R4). A blocked pause stores
   `pausedReason:'blocked'` + `pauseQuestion`, pushes the question into chat history as an
   assistant message + `chat.answer`, then `agent.paused`; the user's next message arrives as
   `agent.resume` → `resumeAgent`: the goal grows by the follow-up (`Follow-up from the user: …`),
   the message is saved to chat history, and the run continues (the plan prompt now sees the
   whole conversation). A step-limit pause (`pausedReason:'steplimit'`) resumes on "continue"
   with `step` reset and `maxSteps += 12`; a bare "continue" never touches the goal. Two idle
   steps (no actions, `status:"continue"`) are tolerated with a WARNING into the next plan, the
   third aborts. A finished run's `deliverAnswer` (runs *after* the run slot is released, with
   its own keepalive): `synthesizeAnswer` sends a trimmed transcript (~6k chars) + working notes
   with the model's self-chosen effort, saves the answer to chat history, pushes `chat.answer`;
   on synthesis failure the run's own summary is delivered as the final chat message. Paused runs
   skip answer synthesis — the question *is* the output.

## Cross-cutting

- **Keepalive** (`background/keepalive.ts`): refcounted 20s ping holds the MV3 service worker
  alive during runs, chat streams, and answer synthesis.
- **Stop**: `agent.stop` over the port sets `run.stop` + aborts the in-flight LLM call.
- **Pause/resume** (R4): `agent.paused` over the port (reason `blocked`|`steplimit`) flips the
  panel into reply-to-continue mode (`agentPaused`; restored from `agent:get` on reload). The
  next composer message becomes `agent.resume` instead of a chat turn — `resumeAgent` in
  `agent.ts` continues the stored `AgentState`.
- **Panel port lifecycle**: connected eagerly at panel mount (`chat-client.ts`
  `ensureChatPort`); if a run finishes while notifications were lost across a navigation, the
  panel's catch-up re-checks the state 2.5s after restore and renders the finish + any answer
  saved after mount.
- **Voice**: STT via `voice:transcribe` (multipart to an OpenAI-compatible
  `/v1/audio/transcriptions`), TTS via `voice:speak` (JSON to `/v1/audio/speech`, played as a
  blob URL), both with built-in browser fallbacks.
