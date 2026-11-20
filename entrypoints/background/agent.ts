import { browser } from 'wxt/browser';
import { rpc } from '@/shared/rpc';
import { getSettings } from '@/shared/settings';
import { normalizeEndpoint } from '@/shared/endpoint';
import type {
  ActionObservation,
  ActionOp,
  AgentSummary,
  Autonomy,
  ConfirmMode,
  ObserveResult,
  ScrollTarget,
} from '@/shared/protocol';

type Port = ReturnType<typeof browser.runtime.connect>;

const agentKey = (tabId: number) => `session:agent:${tabId}` as const;
const MAX_STEPS = 12;
const OBSERVE_TIMEOUT_MS = 15_000;

interface AgentState {
  goal: string;
  autonomy: Autonomy;
  step: number;
  status: 'idle' | 'running';
  narration: string[];
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
  'Ops: {"op":"click","target":N} | {"op":"type","target":N,"text":"...","submit":true?} | {"op":"scroll","to":"top"|"bottom"|"up"|"down"} | {"op":"scroll","target":N} | {"op":"extract","target":N} | {"op":"navigate","url":"..."} | {"op":"wait","ms":N} | {"op":"done","summary":"..."}',
  'Rules: 1-3 actions per step. Use extract to read text. Targets must exist in the provided index. Call done when the goal is achieved.',
].join('\n');

export async function getAgentSummary(tabId: number): Promise<AgentSummary> {
  const state = await loadState(tabId);
  if (!state || !activeRuns.has(tabId)) {
    return { status: 'idle', step: 0, goal: '', autonomy: 'normal', narration: [] };
  }
  return {
    status: 'running',
    step: state.step,
    goal: state.goal,
    autonomy: state.autonomy,
    narration: state.narration,
  };
}

export async function startAgent(
  port: Port,
  tabId: number,
  goal: string,
  autonomy: Autonomy,
): Promise<void> {
  if (activeRuns.has(tabId)) {
    port.postMessage({ type: 'agent.error', message: 'Agent is already running.' });
    return;
  }
  const state: AgentState = { goal, autonomy, step: 0, status: 'running', narration: [] };
  await saveState(tabId, state);
  const run: RunHandle = { stop: false, abort: new AbortController() };
  activeRuns.set(tabId, run);
  port.postMessage({ type: 'agent.started', goal, autonomy });
  void runLoop(port, tabId, run).finally(() => activeRuns.delete(tabId));
}

export function stopAgent(tabId: number): void {
  const run = activeRuns.get(tabId);
  if (!run) return;
  run.stop = true;
  run.abort.abort();
}

export function removeAgentState(tabId: number): void {
  void storage.removeItem(agentKey(tabId));
}

async function runLoop(port: Port, tabId: number, run: RunHandle): Promise<void> {
  const state = (await loadState(tabId))!;
  let summary: string | undefined;
  let error: string | undefined;
  try {
    while (state.step < MAX_STEPS) {
      if (run.stop) {
        summary = 'Stopped by user.';
        break;
      }
      state.step++;
      await saveState(tabId, state);

      const observation = await observeWithRetry(tabId, run);
      if (!observation) {
        error = 'Could not reach the page to observe it.';
        break;
      }

      let parsed: { thought: string; actions: ActionOp[] } | null = null;
      let lastError = '';
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        const raw = await completeOnce(
          state,
          observation,
          run.abort.signal,
          attempt > 0 ? `Your previous reply was invalid: ${lastError}. Reply with ONLY the JSON object.` : null,
        );
        try {
          parsed = parseActionResponse(raw);
        } catch (parseError) {
          lastError = parseError instanceof Error ? parseError.message : String(parseError);
        }
      }
      if (!parsed) {
        error = `Model did not return valid actions: ${lastError}`;
        break;
      }
      if (run.stop) {
        summary = 'Stopped by user.';
        break;
      }

      const doneAction = parsed.actions.find((action): action is { op: 'done'; summary?: string } => action.op === 'done');
      const executable = parsed.actions.filter((action) => action.op !== 'done');
      const observations = executable.length
        ? await executeOnContent(tabId, executable, confirmMode(state.autonomy), run)
        : [];

      const stepLines = [
        `Step ${state.step}: ${parsed.thought || '(no thought)'}`,
        ...observations.map(formatObservation),
      ];
      state.narration.push(...stepLines);
      if (state.narration.length > 40) state.narration = state.narration.slice(-40);
      await saveState(tabId, state);
      port.postMessage({ type: 'agent.step', step: state.step, thought: parsed.thought, observations });

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
    }
    if (!summary && !error && state.step >= MAX_STEPS) {
      summary = `Reached the step limit (${MAX_STEPS}).`;
    }
  } catch (loopError) {
    if (run.stop || isAbortError(loopError)) summary = 'Stopped by user.';
    else error = loopError instanceof Error ? loopError.message : String(loopError);
  } finally {
    state.status = 'idle';
    await saveState(tabId, state);
    if (error) port.postMessage({ type: 'agent.error', message: error });
    else port.postMessage({ type: 'agent.done', summary });
  }
}

function confirmMode(autonomy: Autonomy): ConfirmMode {
  if (autonomy === 'supervise') return 'always';
  if (autonomy === 'auto') return 'never';
  return 'destructive';
}

async function observeWithRetry(
  tabId: number,
  run: RunHandle,
): Promise<ObserveResult | null> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (run.stop) return null;
    try {
      return await rpc<ObserveResult>({ kind: 'act:observe' }, tabId);
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
    return actions.map((action) => ({
      ok: false,
      op: action.op,
      target: 'target' in action ? action.target : undefined,
      message: error instanceof Error ? error.message : String(error),
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
  if (!settings.endpointUrl) throw new Error('No endpoint configured - set it in the Options page.');
  const base = normalizeEndpoint(settings.endpointUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

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

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: userContent },
      ],
      stream: false,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `HTTP ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 300)}` : ''}`,
    );
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content ?? '';
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
  const actions = parsed.actions.map(coerceAction).filter((action): action is ActionOp => action != null);
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
    case 'scroll':
      return 'to' in record &&
        typeof record.to === 'string' &&
        ['top', 'bottom', 'up', 'down'].includes(record.to)
        ? { op: 'scroll', to: record.to as ScrollTarget }
        : target != null
          ? { op: 'scroll', target }
          : null;
    case 'extract':
      return target != null ? { op: 'extract', target } : null;
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
  return observation.ok
    ? `  ${label} → ok${observation.message ? ` — ${observation.message}` : ''}`
    : `  ${label} → failed — ${observation.message ?? 'unknown error'}`;
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
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, ms));
}
