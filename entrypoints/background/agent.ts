import { rpc } from '@/shared/rpc';
import { getSettings } from '@/shared/settings';
import { normalizeEndpoint } from '@/shared/endpoint';
import { streamChat, isLlmTimeout, type ApiContentPart, type ApiMessage } from './llm';
import { acquireKeepalive, releaseKeepalive } from './keepalive';
import { capturePageScreenshot } from './screenshot';
import { getHistory, saveHistory } from './chat';
import type {
  ActionObservation,
  ActionOp,
  AgentSummary,
  ConfirmMode,
  ObserveResult,
  ScrollTarget,
} from '@/shared/protocol';
import type { ChatMessage, ChatPortMessage, Settings } from '@/shared/types';
import { getTabPort } from './chat';

const agentKey = (tabId: number) => `session:agent:${tabId}` as const;
const DEFAULT_MAX_TURNS = 15;
const MAX_TURNS_UPPER_BOUND = 100;
const MAX_OPS_PER_STEP = 8;
const IDLE_STEP_TOLERANCE = 2;
const OBSERVE_TIMEOUT_MS = 15_000;

interface AgentState {
  goal: string;
  confirmMode: ConfirmMode;
  step: number;
  status: 'idle' | 'running' | 'paused' | 'finished';
  narration: string[];
  debug?: boolean;
  memory?: string;
  nextEffort?: AgentEffort;
  maxSteps?: number;
  pausedReason?: 'blocked' | 'steplimit';
  pauseQuestion?: string;
  pendingScreenshot?: string;
}

type AgentEffort = 'low' | 'medium' | 'high' | 'off' | 'default';
const EFFORT_VALUES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'off', 'default']);
const MEMORY_MAX_CHARS = 1200;

function configuredMaxTurns(settings: Settings): number {
  const raw = settings.actMaxTurns;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_TURNS_UPPER_BOUND) {
    return raw;
  }
  return DEFAULT_MAX_TURNS;
}

interface RunHandle {
  stop: boolean;
  abort: AbortController;
}

const activeRuns = new Map<number, RunHandle>();

const AGENT_SYSTEM_LINES = [
  'You are Browser Agent, an autonomous assistant operating the user\'s web page through a numbered element index.',
  'Respond ONLY with a single JSON object, no prose:',
  '{"v":1,"thought":"short reasoning","status":"continue|done|blocked","summary":"...","actions":[...]}',
  'Ops: {"op":"click","target":N} | {"op":"type","target":N,"text":"...","submit":true?} | {"op":"key","target":N,"key":"Enter"|"ArrowDown"|"Escape"} | {"op":"select","target":N,"value":"..."} (native <select>; value is matched against option text or value) | {"op":"find","text":"..."} (search the whole page for an element by name/text and get its id - use it when the element you need is not in the index instead of scrolling blindly) | {"op":"inspect","target":N} (full detail on one element: text, position, surrounding text, nearby controls) | {"op":"focus","target":N} | {"op":"scroll","to":"top"|"bottom"|"up"|"down"} | {"op":"scroll","target":N} | {"op":"extract","target":N} | {"op":"extract"} (no target: returns the page\'s main readable text) | {"op":"navigate","url":"..."} | {"op":"wait","ms":N} | {"op":"done","summary":"..."}',
  'Before setting a value, check whether the index already shows the desired state (e.g. a button or chip already labeled with the target date, city, or passenger count) - if it does, act on that element instead of re-entering the value.',
  'Index lines carry live state: = "..." is a field\'s current value or a select\'s selected option (selects also list their options after "opts:"), and [checked] / [disabled] / [expanded] are flags - read the state instead of guessing, and extract on a field re-reads its value / checked state.',
  'Status: "continue" while you are working. When the goal is achieved set "done" and put the user-facing answer in summary (the done op also works). When you cannot proceed without the user - missing info, an ambiguous choice, a login you lack - set "blocked" and put the exact question for the user in summary; the run pauses and the user\'s next message resumes it with your question answered. Every step should act: an empty actions array with status "continue" wastes a step, and two idle steps in a row abort the run.',
  'Rules: up to 8 actions per step; navigation, form submission, and any action that opens a menu/dropdown must be the LAST action of the step - the page changes under the actions after them. "navigate" must be the LAST action of a step - the next step observes the new page, so never batch extract/wait/click after it. On article pages, use extract with no target to read the main text before answering. Use select on native <select> dropdowns - clicking one only opens the OS dropdown. For autocomplete fields: type without submit, wait, then click the matching option row (or press key Enter). New dropdown/popover options opened by your last action are listed first under "Recently appeared" - look there for suggestion rows. find "text" returns matching elements with their ids (found elements stay in later indexes) - run find in one step, then act on the id in the next step. Submit only to run the final search. Targets must exist in the provided index. Click targets must be interactive (link/button/textbox/combobox); content roles like paragraph/listitem/heading are for extract - clicking them falls back to the nearest clickable inside.',
];

const SCHEMA_V1 = '{"v":1,"thought":"short reasoning","status":"continue|done|blocked","summary":"answer (done) or question (blocked), else omit","actions":[...]}';
const SCHEMA_V2 =
  '{"v":2,"thought":"short reasoning","status":"continue|done|blocked","summary":"answer (done) or question (blocked), else omit","memory":"updated working notes","effort":"low|medium|high|off|default","actions":[...]}';
const MEMORY_RULES = [
  'memory: rewrite your working notes each step - what the goal needs, how this page is structured, what you already tried and what failed, and the plan for the next steps. Update, prune, never append endlessly; keep it under 600 characters. Omit the field to keep your previous notes unchanged.',
  'effort: the reasoning effort for your NEXT step. "low" for single mechanical actions you are sure about (click a visible button, fill one field), "medium" for a normal step, "high" only when the page contradicted your plan and you need to rethink, "off" only for a single trivial action you are fully confident about, "default" to keep the configured effort.',
].join(' ');

function agentSystem(memoryEnabled: boolean, extraInstructions: string, visionEnabled: boolean): string {
  const lines = [...AGENT_SYSTEM_LINES];
  lines[2] = memoryEnabled ? SCHEMA_V2 : SCHEMA_V1;
  if (visionEnabled) {
    lines[3] += ' | {"op":"look"} (see Vision below)';
    lines.push(
      'Vision: {"op":"look"} captures the visible page as a screenshot and attaches it to your NEXT step (the ops list also carries it). Use it only as a last resort - when layout/visual detail matters and the index + extract/find/inspect cannot convey it (canvas, image-only content, visual confirmation after a click). The screenshot costs a lot of tokens: never look twice in a row while an unread screenshot is already attached.',
    );
  }
  if (memoryEnabled) {
    lines.push(MEMORY_RULES);
  }
  if (extraInstructions) {
    lines.push('Additional instructions from the user:', extraInstructions);
  }
  return lines.join('\n');
}

export async function getAgentSummary(tabId: number): Promise<AgentSummary> {
  await resumeAgentIfStale(tabId);
  const state = await loadState(tabId);
  if (!state) {
    return { status: 'idle', step: 0, goal: '', confirmMode: 'destructive', narration: [] };
  }
  const running = state.status === 'running' && activeRuns.has(tabId);
  return {
    status: running ? 'running' : state.status === 'running' ? 'finished' : state.status,
    step: state.step,
    goal: state.goal,
    confirmMode: state.confirmMode,
    narration: state.narration,
    pauseQuestion: state.pauseQuestion,
  };
}

export async function toggleAgentDebug(tabId: number): Promise<boolean> {
  const state =
    (await loadState(tabId)) ??
    { goal: '', confirmMode: 'destructive' as const, step: 0, status: 'idle' as const, narration: [] };
  state.debug = !(state.debug === true);
  await saveState(tabId, state);
  return state.debug;
}

export async function startAgent(
  tabId: number,
  goal: string,
  mode: ConfirmMode,
): Promise<void> {
  if (activeRuns.has(tabId)) {
    notify(tabId, { type: 'agent.error', message: 'Agent is already running.' });
    return;
  }
  console.info(`[agent] start tab=${tabId} goal="${goal}" confirmMode=${mode}`);
  const state: AgentState = {
    goal,
    confirmMode: mode,
    step: 0,
    status: 'running',
    narration: [],
    debug: (await loadState(tabId))?.debug === true,
  };
  await saveState(tabId, state);
  const run: RunHandle = { stop: false, abort: new AbortController() };
  activeRuns.set(tabId, run);
  void runLoop(tabId, run)
    .catch(() => {})
    .finally(() => activeRuns.delete(tabId));
}

export function stopAgent(tabId: number): void {
  const run = activeRuns.get(tabId);
  if (run) {
    console.info(`[agent] stop requested tab=${tabId}`);
    run.stop = true;
    run.abort.abort();
  }
  void markFinishedIfStale(tabId);
}

/** Continues a paused run; the message extends the task (union of the messages). */
export async function resumeAgent(tabId: number, text: string): Promise<void> {
  if (activeRuns.has(tabId)) {
    notify(tabId, { type: 'agent.error', message: 'Agent is already running.' });
    return;
  }
  const state = await loadState(tabId);
  if (!state || state.status !== 'paused') {
    notify(tabId, { type: 'agent.error', message: 'No paused agent run to resume.' });
    return;
  }
  const message = text.trim();
  console.info(`[agent] resume tab=${tabId} reason=${state.pausedReason} text="${message}"`);
  const bareContinue = /^continue\.?$/i.test(message);
  if (message && !(state.pausedReason === 'steplimit' && bareContinue)) {
    state.goal = `${state.goal}\nFollow-up from the user: ${message}`;
  }
  if (message) {
    const history = await getHistory(tabId);
    history.push({ role: 'user', text: message });
    await saveHistory(tabId, history);
  }
  if (state.pausedReason === 'steplimit') {
    const cap = configuredMaxTurns(await getSettings());
    state.maxSteps = (state.maxSteps ?? cap) + cap;
    state.step = 0;
  }
  state.pausedReason = undefined;
  state.pauseQuestion = undefined;
  state.status = 'running';
  state.narration.push(message ? `Resumed by user: "${message}"` : 'Resumed by user.');
  await saveState(tabId, state);
  const run: RunHandle = { stop: false, abort: new AbortController() };
  activeRuns.set(tabId, run);
  void runLoop(tabId, run)
    .catch(() => {})
    .finally(() => activeRuns.delete(tabId));
}

async function markFinishedIfStale(tabId: number): Promise<void> {
  if (activeRuns.has(tabId)) return;
  const state = await loadState(tabId);
  if (state?.status === 'running') {
    state.status = 'finished';
    state.narration.push('Run interrupted (browser suspended the background worker).');
    await saveState(tabId, state);
  }
}

export async function resumeAgentIfStale(tabId: number): Promise<void> {
  if (activeRuns.has(tabId)) return;
  const state = await loadState(tabId);
  if (!state || state.status !== 'running') return;
  console.info(`[agent] resuming interrupted run tab=${tabId} step=${state.step}`);
  const run: RunHandle = { stop: false, abort: new AbortController() };
  activeRuns.set(tabId, run);
  void runLoop(tabId, run).finally(() => activeRuns.delete(tabId));
}

export function removeAgentState(tabId: number): void {
  void storage.removeItem(agentKey(tabId));
}

function notify(tabId: number, message: ChatPortMessage): void {
  const port = getTabPort(tabId);
  if (!port) {
    console.info(`[agent] tab=${tabId} no panel port; notification dropped: ${message.type}`);
    return;
  }
  port.postMessage(message);
}

async function runLoop(tabId: number, run: RunHandle): Promise<void> {
  const state = await loadState(tabId);
  if (!state) return;
  const loopSettings = await getSettings();
  const memoryEnabled = loopSettings.agentWorkingMemory === true;
  const visionEnabled = loopSettings.actVision === true;
  const maxTurns = state.maxSteps ?? configuredMaxTurns(loopSettings);
  state.maxSteps = maxTurns;
  acquireKeepalive();
  let summary: string | undefined;
  let error: string | undefined;
  let pausedReason: 'blocked' | 'steplimit' | undefined;
  let pauseQuestion = '';
  let idleStreak = 0;
  let lastUrl = '';
  let lastPrimaryTarget: number | null = null;
  let repeatCount = 0;
  try {
    while (state.step < maxTurns) {
      if (run.stop) {
        summary = 'Stopped by user.';
        break;
      }
      state.step++;
      await saveState(tabId, state);
      console.info(`[agent] tab=${tabId} step=${state.step}`);

      const observeStart = performance.now();
      const observation = await observeWithRetry(tabId, run);
      if (!observation) {
        error = 'Could not reach the page to observe it.';
        break;
      }
      const details: string[] = [
        `observe: ${observation.index ? observation.index.split('\n').length : 0} entries in ${Math.round(performance.now() - observeStart)}ms`,
      ];
      const stuckWarning =
        repeatCount >= 2 && lastPrimaryTarget != null
          ? `WARNING: clicking [${lastPrimaryTarget}] ${repeatCount + 1} times in a row has not changed the page (still on ${lastUrl}). Choose a DIFFERENT element or a different strategy.`
          : null;
      const idleWarning =
        idleStreak > 0
          ? `WARNING: your last step returned no actions (${idleStreak} idle step${idleStreak > 1 ? 's' : ''} in a row). Act on the page now, or set status "done"/"blocked" - one more idle step aborts the run.`
          : null;
      const guidance = [stuckWarning, idleWarning].filter(Boolean).join('\n') || null;
      const stepHistory = await getHistory(tabId);

      let parsed: {
        thought: string;
        actions: ActionOp[];
        status: 'continue' | 'done' | 'blocked';
        summary?: string;
        memory?: string;
        effort?: string;
      } | null = null;
      let lastError = '';
      let prevTimedOut = false;
      let timedOut = false;
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        const llmStart = performance.now();
        let raw: string;
        const feedback = attempt > 0
          ? prevTimedOut
            ? 'Your previous attempt timed out before producing a reply. Reply with ONLY the JSON object.'
            : `Your previous reply was invalid: ${lastError}. Reply with ONLY the JSON object.`
          : guidance;
        try {
          raw = await completeOnce(tabId, state, observation, stepHistory, run.abort.signal, feedback);
        } catch (callError) {
          if (isLlmTimeout(callError)) {
            timedOut = true;
            prevTimedOut = true;
            lastError = callError instanceof Error ? callError.message : 'the LLM request timed out';
            details.push(`llm attempt ${attempt + 1}: timed out (${lastError})`);
            continue;
          }
          throw callError;
        }
        timedOut = false;
        details.push(
          `llm: ${Math.round(performance.now() - llmStart)}ms, ${raw.length} chars${attempt > 0 ? ' (retry)' : ''}`,
        );
        console.info(`[agent] tab=${tabId} llm=${Math.round(performance.now() - llmStart)}ms chars=${raw.length}`);
        try {
          parsed = parseActionResponse(raw);
        } catch (parseError) {
          lastError = parseError instanceof Error ? parseError.message : String(parseError);
          details.push(`parse failed: ${lastError}`);
        }
      }
      if (!parsed) {
        error = timedOut
          ? `LLM request timed out twice in a row (model too slow for this step) - run aborted. Last error: ${lastError}`
          : `Model did not return valid actions: ${lastError}`;
        break;
      }
      state.pendingScreenshot = undefined;
      console.info(`[agent] tab=${tabId} ops=${JSON.stringify(parsed.actions.map((a) => a.op))}`);
      if (memoryEnabled) {
        if (typeof parsed.memory === 'string') {
          state.memory = parsed.memory.trim().slice(0, MEMORY_MAX_CHARS);
        }
        if (parsed.effort && EFFORT_VALUES.has(parsed.effort)) {
          state.nextEffort = parsed.effort as AgentEffort;
        }
        if (parsed.memory !== undefined) {
          details.push(`memory: ${state.memory || '(cleared)'}`);
          console.info(`[agent] tab=${tabId} memory=${JSON.stringify(state.memory)}`);
        }
        if (parsed.effort !== undefined) {
          details.push(
            `next effort: ${EFFORT_VALUES.has(parsed.effort) ? parsed.effort : `${parsed.effort} (ignored)`}`,
          );
        }
      }
      if (run.stop) {
        summary = 'Stopped by user.';
        break;
      }

      const doneAction = parsed.actions.find(
        (action): action is { op: 'done'; summary?: string } => action.op === 'done',
      );
      const nonDone = parsed.actions.filter((action) => action.op !== 'done');
      const wantsLook = nonDone.some((action) => action.op === 'look');
      const executable = nonDone.filter((action) => action.op !== 'look');
      const overflow = executable.length > MAX_OPS_PER_STEP ? executable.splice(MAX_OPS_PER_STEP) : [];
      const observations = executable.length
        ? await executeOnContent(tabId, executable, state.confirmMode, run)
        : [];
      if (overflow.length) {
        observations.push({
          ok: false,
          op: 'batch',
          message: `dropped ${overflow.length} action(s) beyond the ${MAX_OPS_PER_STEP}-per-step cap (${overflow.map((action) => action.op).join(', ')}) - keep navigation/submission last`,
        });
      }
      if (wantsLook) {
        if (!visionEnabled) {
          observations.push({
            ok: false,
            op: 'look',
            message: 'vision is off - enable "Act model can see screenshots" in Options, or rely on extract/find/inspect',
          });
        } else {
          try {
            state.pendingScreenshot = await capturePageScreenshot(tabId);
            observations.push({ ok: true, op: 'look', message: 'screenshot captured - attached to your next step' });
          } catch (captureError) {
            observations.push({
              ok: false,
              op: 'look',
              message: `screenshot failed: ${captureError instanceof Error ? captureError.message : String(captureError)}`,
            });
          }
        }
      }
      console.info(`[agent] tab=${tabId} executed=${observations.length}`);

      const stepLines = [
        `Step ${state.step}: ${parsed.thought || '(no thought)'}${parsed.status === 'continue' ? '' : ` [${parsed.status}]`}`,
        ...observations.map(formatObservation),
      ];
      state.narration.push(...stepLines);
      trimNarration(state);
      await saveState(tabId, state);
      notify(tabId, {
        type: 'agent.step',
        step: state.step,
        thought: parsed.thought,
        observations,
        details: state.debug ? details : undefined,
      });

      if (run.stop) {
        summary = 'Stopped by user.';
        break;
      }
      if (doneAction || parsed.status === 'done') {
        summary = doneAction?.summary?.trim() || parsed.summary?.trim() || 'Goal marked done.';
        break;
      }
      if (parsed.status === 'blocked') {
        pausedReason = 'blocked';
        pauseQuestion = parsed.summary?.trim() || parsed.thought.trim() || 'I cannot proceed without input from you.';
        break;
      }
      if (!nonDone.length) {
        idleStreak++;
        if (idleStreak > IDLE_STEP_TOLERANCE) {
          error = `Model returned no actions ${idleStreak} steps in a row - run aborted.`;
          break;
        }
      } else {
        idleStreak = 0;
      }

      const primary = executable[0];
      const primaryTarget =
        primary && 'target' in primary && typeof primary.target === 'number'
          ? primary.target
          : null;
      if (observation.url === lastUrl && primaryTarget != null && primaryTarget === lastPrimaryTarget) {
        repeatCount++;
      } else {
        repeatCount = 0;
      }
      lastUrl = observation.url;
      lastPrimaryTarget = primaryTarget;

      await delay(observations.some((entry) => entry.navigating) ? 800 : 400);
    }
    if (!summary && !error && !pausedReason && state.step >= maxTurns) {
      pausedReason = 'steplimit';
      pauseQuestion = `I used all ${maxTurns} steps without reaching the goal - reply "continue" and I will pick up where I left off.`;
    }
  } catch (loopError) {
    if (run.stop || isAbortError(loopError)) summary = 'Stopped by user.';
    else error = loopError instanceof Error ? loopError.message : String(loopError);
  } finally {
    releaseKeepalive();
    if (pausedReason && !run.stop && !error) {
      state.status = 'paused';
      state.pausedReason = pausedReason;
      state.pauseQuestion = pauseQuestion;
      state.narration.push(`Paused (${pausedReason}): ${pauseQuestion}`);
      trimNarration(state);
      await saveState(tabId, state);
      console.info(`[agent] tab=${tabId} paused (${pausedReason}): ${pauseQuestion}`);
      if (pausedReason === 'blocked') {
        const history = await getHistory(tabId);
        history.push({ role: 'assistant', text: pauseQuestion });
        await saveHistory(tabId, history);
        notify(tabId, { type: 'chat.answer', text: pauseQuestion });
      }
      notify(tabId, { type: 'agent.paused', reason: pausedReason, question: pauseQuestion });
    } else {
      state.status = 'finished';
      if (error) {
        state.narration.push(`Error: ${error}`);
        console.warn(`[agent] tab=${tabId} error: ${error}`);
      } else {
        state.narration.push(`Finished: ${summary ?? 'done'}`);
        console.info(`[agent] tab=${tabId} finished: ${summary ?? 'done'}`);
      }
      trimNarration(state);
      await saveState(tabId, state);
      if (error) notify(tabId, { type: 'agent.error', message: error });
      else notify(tabId, { type: 'agent.done', summary });
      if (!run.stop && state.narration.length > 0) {
        void deliverAnswer(tabId, state, summary);
      }
    }
  }
}

/** Runs after the run slot is released so a new goal can start immediately. */
async function deliverAnswer(
  tabId: number,
  state: AgentState,
  fallbackSummary?: string,
): Promise<void> {
  acquireKeepalive();
  try {
    let answer = '';
    try {
      console.info('[agent] answer synthesis: started');
      answer = await synthesizeAnswer(state);
      console.info(`[agent] answer synthesis: done (${answer.length} chars)`);
    } catch (synthError) {
      console.warn(
        '[agent] answer synthesis failed:',
        synthError instanceof Error ? synthError.message : synthError,
      );
    }
    if (!answer.trim() && fallbackSummary) {
      answer = fallbackSummary;
      console.info('[agent] answer synthesis: using the run summary as fallback');
    }
    if (answer.trim()) {
      const history = await getHistory(tabId);
      history.push({ role: 'assistant', text: answer });
      await saveHistory(tabId, history);
      console.info('[agent] answer saved to chat history');
      try {
        notify(tabId, { type: 'chat.answer', text: answer });
      } catch (notifyError) {
        console.warn(
          '[agent] answer notify failed (panel port closed; it is in chat history):',
          notifyError instanceof Error ? notifyError.message : notifyError,
        );
      }
    }
  } catch (unexpectedError) {
    console.warn('[agent] answer delivery failed:', unexpectedError);
  } finally {
    releaseKeepalive();
  }
}

function trimNarration(state: AgentState): void {
  if (state.narration.length > 40) state.narration = state.narration.slice(-40);
  while (state.narration.join('\n').length > 16_000 && state.narration.length > 4) {
    state.narration.shift();
  }
}

function effortExtraBody(
  settings: Settings,
  nextEffort?: AgentEffort,
): Record<string, unknown> | undefined {
  const memoryEnabled = settings.agentWorkingMemory === true;
  const configuredEffort = settings.actReasoningEffort?.trim();
  if (memoryEnabled && nextEffort && nextEffort !== 'default') {
    return nextEffort === 'off'
      ? { chat_template_kwargs: { enable_thinking: false } }
      : { reasoning_effort: nextEffort };
  }
  return configuredEffort ? { reasoning_effort: configuredEffort } : undefined;
}

async function synthesizeAnswer(state: AgentState): Promise<string> {
  const settings = await getSettings();
  if (!settings.endpointUrl) return '';
  const base = normalizeEndpoint(settings.endpointUrl);
  const transcript = state.narration.join('\n');
  const trimmedTranscript =
    transcript.length > 6000
      ? `${transcript.slice(0, 1200)}\n…(middle of the transcript omitted)…\n${transcript.slice(-4500)}`
      : transcript;
  const memory = state.memory ? `\n\nAgent working notes:\n${state.memory}` : '';
  const messages: ApiMessage[] = [
    {
      role: 'system',
      content:
        'You are Browser Agent. An autonomous agent run just tried to accomplish the user goal on web pages. Write the final response to the user: answer the original question from the transcript if the information was found (mention which page it came from), otherwise summarize what was accomplished and what blocked progress. Be concise.',
    },
    {
      role: 'user',
      content: `Goal: ${state.goal}\n\nAgent transcript:\n${trimmedTranscript}${memory}`,
    },
  ];
  return streamChat({
    base,
    apiKey: settings.apiKey,
    model: settings.model,
    messages,
    firstTokenTimeoutMs: settings.llmFirstTokenTimeoutMs,
    totalTimeoutMs: settings.llmTotalTimeoutMs,
    extraBody: effortExtraBody(settings, state.nextEffort),
  });
}

async function observeWithRetry(
  tabId: number,
  run: RunHandle,
): Promise<ObserveResult | null> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (run.stop) return null;
    try {
      const result = await rpc<ObserveResult>({ kind: 'act:observe' }, tabId);
      if (result.index.trim().length >= 20) return result;
      console.info('[agent] observe returned an empty index - page not ready, retrying');
    } catch {
      await delay(600);
    }
  }
  return null;
}

async function executeOnContent(
  tabId: number,
  actions: ActionOp[],
  mode: ConfirmMode,
  run: RunHandle,
): Promise<ActionObservation[]> {
  if (run.stop) return [];
  try {
    return await rpc<ActionObservation[]>(
      { kind: 'act:execute', actions, confirmMode: mode },
      tabId,
    );
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const navigated = /message channel closed|Receiving end does not exist/i.test(raw);
    const message = navigated
      ? 'the page navigated or reloaded before the actions finished reporting - observe the new page state before retrying'
      : raw;
    return actions.map((action) => ({
      ok: false,
      op: action.op,
      target: 'target' in action ? action.target : undefined,
      message,
      ...(navigated ? { navigating: true } : {}),
    }));
  }
}

function userContentWithImage(
  text: string,
  state: AgentState,
  settings: Settings,
): string | ApiContentPart[] {
  const screenshot =
    settings.actVision === true && state.pendingScreenshot ? state.pendingScreenshot : undefined;
  if (!screenshot) return text;
  return [
    {
      type: 'text',
      text: `${text}\n\n[The screenshot of the page you captured with look is attached to this message - read it for layout and visual detail.]`,
    },
    { type: 'image_url', image_url: { url: screenshot } },
  ];
}

async function completeOnce(
  tabId: number,
  state: AgentState,
  observation: ObserveResult,
  history: ChatMessage[],
  signal: AbortSignal,
  feedback: string | null,
): Promise<string> {
  const settings = await getSettings();
  const endpoint = settings.actEndpointUrl?.trim() || settings.endpointUrl;
  const model = settings.actModel?.trim() || settings.model;
  if (!endpoint) throw new Error('No endpoint configured - set it in the Options page.');
  const memoryEnabled = settings.agentWorkingMemory === true;

  const base = normalizeEndpoint(endpoint);
  const visionEnabled = settings.actVision === true;
  const system = agentSystem(memoryEnabled, settings.actExtraInstructions?.trim() ?? '', visionEnabled);

  const memorySection =
    memoryEnabled && state.memory
      ? [
          `Working notes from your previous steps (rewrite them in your reply, 600 chars max):\n${state.memory}`,
        ]
      : [];

  const transcript = state.narration.slice(-6).join('\n');
  const conversation = history
    .slice(-10)
    .filter((message) => message.text.trim())
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.replace(/\s+/g, ' ').slice(0, 400)}`,
    )
    .join('\n');
  const userContent = [
    `Goal: ${state.goal}`,
    `Step ${state.step} of ${state.maxSteps ?? configuredMaxTurns(settings)}`,
    `Page: ${observation.title} (${observation.url})`,
    ...memorySection,
    conversation
      ? `Conversation with the user in this tab (oldest first - resume context, tone, and any answer to a previous blocked question):\n${conversation.length > 3000 ? conversation.slice(-3000) : conversation}`
      : '',
    '',
    'Element index:',
    observation.index,
    '',
    transcript ? `Progress so far:\n${transcript}` : '',
    feedback ? `\n${feedback}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: ApiMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userContentWithImage(userContent, state, settings) },
  ];

  const extraBody = effortExtraBody(settings, state.nextEffort);

  try {
    return await streamChat({
      base,
      apiKey: settings.apiKey,
      model,
      messages,
      signal,
      firstTokenTimeoutMs: settings.llmFirstTokenTimeoutMs,
      totalTimeoutMs: settings.llmTotalTimeoutMs,
      extraBody,
    });
  } catch (error) {
    if (isLlmTimeout(error) || isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} - endpoint: ${base}`);
  }
}

function parseActionResponse(raw: string): {
  thought: string;
  actions: ActionOp[];
  status: 'continue' | 'done' | 'blocked';
  summary?: string;
  memory?: string;
  effort?: string;
} {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    thought?: unknown;
    actions?: unknown;
    status?: unknown;
    summary?: unknown;
    memory?: unknown;
    effort?: unknown;
  };
  if (!Array.isArray(parsed.actions)) throw new Error('missing actions array');
  const actions = parsed.actions
    .map(coerceAction)
    .filter((action): action is ActionOp => action != null);
  const rawStatus = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : 'continue';
  const status =
    rawStatus === 'done' || rawStatus === 'blocked' ? rawStatus : 'continue';
  return {
    thought: typeof parsed.thought === 'string' ? parsed.thought : '',
    actions,
    status,
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : undefined,
    memory: typeof parsed.memory === 'string' ? parsed.memory : undefined,
    effort: typeof parsed.effort === 'string' ? parsed.effort.toLowerCase() : undefined,
  };
}

const KNOWN_OPS = new Set([
  'click',
  'type',
  'key',
  'select',
  'find',
  'inspect',
  'focus',
  'scroll',
  'extract',
  'navigate',
  'wait',
  'look',
  'done',
]);

function coerceAction(candidate: unknown): ActionOp | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  const op = record.op;
  if (typeof op !== 'string' || !KNOWN_OPS.has(op)) return null;
  const target = typeof record.target === 'number' ? record.target : undefined;
  switch (op) {
    case 'click':
      return target != null ? { op: 'click', target } : null;
    case 'type':
      return target != null && typeof record.text === 'string'
        ? { op: 'type', target, text: record.text, submit: record.submit === true }
        : null;
    case 'key':
      return target != null && typeof record.key === 'string'
        ? { op: 'key', target, key: record.key }
        : null;
    case 'select':
      return target != null && typeof record.value === 'string'
        ? { op: 'select', target, value: record.value }
        : null;
    case 'find':
      return typeof record.text === 'string' ? { op: 'find', text: record.text } : null;
    case 'inspect':
      return target != null ? { op: 'inspect', target } : null;
    case 'focus':
      return target != null ? { op: 'focus', target } : null;
    case 'scroll':
      return 'to' in record &&
        typeof record.to === 'string' &&
        ['top', 'bottom', 'up', 'down'].includes(record.to)
        ? { op: 'scroll', to: record.to as ScrollTarget }
        : target != null
          ? { op: 'scroll', target }
          : null;
    case 'extract':
      return { op: 'extract', target };
    case 'navigate':
      return typeof record.url === 'string' ? { op: 'navigate', url: record.url } : null;
    case 'wait':
      return typeof record.ms === 'number' ? { op: 'wait', ms: record.ms } : null;
    case 'look':
      return { op: 'look' };
    case 'done':
      return { op: 'done', summary: typeof record.summary === 'string' ? record.summary : undefined };
    default:
      return null;
  }
}

function formatObservation(observation: ActionObservation): string {
  const label = `${observation.op}${observation.target != null ? ` [${observation.target}]` : ''}`;
  if (!observation.ok) {
    return `  ${label} → failed — ${observation.message ?? 'unknown error'}`;
  }
  if (observation.op === 'extract' || observation.op === 'find' || observation.op === 'inspect') {
    return `  ${label} → ok (${observation.message?.length ?? 0} chars):\n${observation.message ?? ''}`;
  }
  return `  ${label} → ok${observation.message ? ` — ${observation.message}` : ''}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function loadState(tabId: number): Promise<AgentState | null> {
  return (await storage.getItem<AgentState>(agentKey(tabId))) ?? null;
}

async function saveState(tabId: number, state: AgentState): Promise<void> {
  await storage.setItem(agentKey(tabId), state);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
