import { rpc } from '@/shared/rpc';
import { getSettings } from '@/shared/settings';
import { normalizeEndpoint } from '@/shared/endpoint';
import { streamChat, isLlmTimeout, type ApiMessage } from './llm';
import { acquireKeepalive, releaseKeepalive } from './keepalive';
import { getHistory, saveHistory } from './chat';
import type {
  ActionObservation,
  ActionOp,
  AgentSummary,
  ConfirmMode,
  ObserveResult,
  ScrollTarget,
} from '@/shared/protocol';
import type { ChatPortMessage } from '@/shared/types';
import { getTabPort } from './chat';

const agentKey = (tabId: number) => `session:agent:${tabId}` as const;
const MAX_STEPS = 12;
const OBSERVE_TIMEOUT_MS = 15_000;

interface AgentState {
  goal: string;
  askFirst: boolean;
  step: number;
  status: 'idle' | 'running' | 'finished';
  narration: string[];
  debug?: boolean;
}

interface RunHandle {
  stop: boolean;
  abort: AbortController;
}

const activeRuns = new Map<number, RunHandle>();

const AGENT_SYSTEM = [
  'You are Browser Agent, an autonomous assistant operating the user\'s web page through a numbered element index.',
  'Respond ONLY with a single JSON object, no prose:',
  '{"v":1,"thought":"short reasoning","actions":[...]}',
  'Ops: {"op":"click","target":N} | {"op":"type","target":N,"text":"...","submit":true?} | {"op":"key","target":N,"key":"Enter"|"ArrowDown"|"Escape"} | {"op":"scroll","to":"top"|"bottom"|"up"|"down"} | {"op":"scroll","target":N} | {"op":"extract","target":N} | {"op":"extract"} (no target: returns the page\'s main readable text) | {"op":"navigate","url":"..."} | {"op":"wait","ms":N} | {"op":"done","summary":"..."}',
  'Before setting a value, check whether the index already shows the desired state (e.g. a button or chip already labeled with the target date, city, or passenger count) - if it does, act on that element instead of re-entering the value.',
  'Rules: 1-3 actions per step. On article pages, use extract with no target to read the main text before answering. For autocomplete fields: type without submit, wait, then click the matching option row (or press key Enter). New dropdown/popover options opened by your last action are listed first under "Recently appeared" - look there for suggestion rows. Submit only to run the final search. Targets must exist in the provided index. Click targets must be interactive (link/button/textbox/combobox); content roles like paragraph/listitem/heading are for extract - clicking them falls back to the nearest clickable inside. Call done with the answer in summary when the goal is achieved.',
].join('\n');

export async function getAgentSummary(tabId: number): Promise<AgentSummary> {
  await resumeAgentIfStale(tabId);
  const state = await loadState(tabId);
  if (!state) {
    return { status: 'idle', step: 0, goal: '', askFirst: false, narration: [] };
  }
  const running = state.status === 'running' && activeRuns.has(tabId);
  return {
    status: running ? 'running' : state.status === 'running' ? 'finished' : state.status,
    step: state.step,
    goal: state.goal,
    askFirst: state.askFirst,
    narration: state.narration,
  };
}

export async function toggleAgentDebug(tabId: number): Promise<boolean> {
  const state =
    (await loadState(tabId)) ??
    { goal: '', askFirst: false, step: 0, status: 'idle' as const, narration: [] };
  state.debug = !(state.debug === true);
  await saveState(tabId, state);
  return state.debug;
}

export async function startAgent(tabId: number, goal: string, askFirst: boolean): Promise<void> {
  if (activeRuns.has(tabId)) {
    notify(tabId, { type: 'agent.error', message: 'Agent is already running.' });
    return;
  }
  console.info(`[agent] start tab=${tabId} goal="${goal}" askFirst=${askFirst}`);
  const state: AgentState = {
    goal,
    askFirst,
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
  getTabPort(tabId)?.postMessage(message);
}

async function runLoop(tabId: number, run: RunHandle): Promise<void> {
  const state = await loadState(tabId);
  if (!state) return;
  acquireKeepalive();
  let summary: string | undefined;
  let error: string | undefined;
  let lastUrl = '';
  let lastPrimaryTarget: number | null = null;
  let repeatCount = 0;
  try {
    while (state.step < MAX_STEPS) {
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

      let parsed: { thought: string; actions: ActionOp[] } | null = null;
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
          : stuckWarning;
        try {
          raw = await completeOnce(state, observation, run.abort.signal, feedback);
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
      if (run.stop) {
        summary = 'Stopped by user.';
        break;
      }

      const doneAction = parsed.actions.find(
        (action): action is { op: 'done'; summary?: string } => action.op === 'done',
      );
      const executable = parsed.actions.filter((action) => action.op !== 'done');
      const observations = executable.length
        ? await executeOnContent(tabId, executable, confirmMode(state.askFirst), run)
        : [];
      console.info(`[agent] tab=${tabId} executed=${observations.length}`);

      const stepLines = [
        `Step ${state.step}: ${parsed.thought || '(no thought)'}`,
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
      if (doneAction) {
        summary = doneAction.summary || 'Goal marked done.';
        break;
      }
      if (!executable.length) {
        error = 'Model returned no executable actions.';
        break;
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
    }
    if (!summary && !error && state.step >= MAX_STEPS) {
      summary = `Reached the step limit (${MAX_STEPS}).`;
    }
  } catch (loopError) {
    if (run.stop || isAbortError(loopError)) summary = 'Stopped by user.';
    else error = loopError instanceof Error ? loopError.message : String(loopError);
  } finally {
    releaseKeepalive();
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
      void deliverAnswer(tabId, state);
    }
  }
}

/** Runs after the run slot is released so a new goal can start immediately. */
async function deliverAnswer(tabId: number, state: AgentState): Promise<void> {
  acquireKeepalive();
  try {
    const answer = await synthesizeAnswer(state);
    if (answer.trim()) {
      const history = await getHistory(tabId);
      history.push({ role: 'assistant', text: answer });
      await saveHistory(tabId, history);
      notify(tabId, { type: 'chat.answer', text: answer });
    }
  } catch (synthError) {
    console.info('[agent] answer synthesis failed:', synthError);
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

async function synthesizeAnswer(state: AgentState): Promise<string> {
  const settings = await getSettings();
  if (!settings.endpointUrl) return '';
  const base = normalizeEndpoint(settings.endpointUrl);
  const transcript = state.narration.join('\n');
  const messages: ApiMessage[] = [
    {
      role: 'system',
      content:
        'You are Browser Agent. An autonomous agent run just tried to accomplish the user goal on web pages. Write the final response to the user: answer the original question from the transcript if the information was found (mention which page it came from), otherwise summarize what was accomplished and what blocked progress. Be concise.',
    },
    { role: 'user', content: `Goal: ${state.goal}\n\nAgent transcript:\n${transcript}` },
  ];
  return streamChat({
    base,
    apiKey: settings.apiKey,
    model: settings.model,
    messages,
    firstTokenTimeoutMs: settings.llmFirstTokenTimeoutMs,
    totalTimeoutMs: settings.llmTotalTimeoutMs,
  });
}

function confirmMode(askFirst: boolean): ConfirmMode {
  return askFirst ? 'always' : 'destructive';
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
    const message = /message channel closed|Receiving end does not exist/i.test(raw)
      ? 'the page navigated or reloaded before the actions finished reporting - observe the new page state before retrying'
      : raw;
    return actions.map((action) => ({
      ok: false,
      op: action.op,
      target: 'target' in action ? action.target : undefined,
      message,
    }));
  }
}

async function completeOnce(
  state: AgentState,
  observation: ObserveResult,
  signal: AbortSignal,
  feedback: string | null,
): Promise<string> {
  const settings = await getSettings();
  const endpoint = settings.actEndpointUrl?.trim() || settings.endpointUrl;
  const model = settings.actModel?.trim() || settings.model;
  if (!endpoint) throw new Error('No endpoint configured - set it in the Options page.');
  const effort = settings.actReasoningEffort?.trim();

  const base = normalizeEndpoint(endpoint);
  const system = settings.actExtraInstructions?.trim()
    ? `${AGENT_SYSTEM}\n\nAdditional instructions from the user:\n${settings.actExtraInstructions.trim()}`
    : AGENT_SYSTEM;

  const transcript = state.narration.slice(-6).join('\n');
  const userContent = [
    `Goal: ${state.goal}`,
    `Step ${state.step} of ${MAX_STEPS}`,
    `Page: ${observation.title} (${observation.url})`,
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
    { role: 'user', content: userContent },
  ];

  return streamChat({
    base,
    apiKey: settings.apiKey,
    model,
    messages,
    signal,
    firstTokenTimeoutMs: settings.llmFirstTokenTimeoutMs,
    totalTimeoutMs: settings.llmTotalTimeoutMs,
    extraBody: effort ? { reasoning_effort: effort } : undefined,
  });
}

function parseActionResponse(raw: string): { thought: string; actions: ActionOp[] } {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    thought?: unknown;
    actions?: unknown;
  };
  if (!Array.isArray(parsed.actions)) throw new Error('missing actions array');
  const actions = parsed.actions
    .map(coerceAction)
    .filter((action): action is ActionOp => action != null);
  if (!actions.length) throw new Error('no valid actions');
  return { thought: typeof parsed.thought === 'string' ? parsed.thought : '', actions };
}

const KNOWN_OPS = new Set(['click', 'type', 'scroll', 'extract', 'navigate', 'wait', 'done']);

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
  if (observation.op === 'extract') {
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
