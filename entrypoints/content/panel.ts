import { browser } from 'wxt/browser';
import { rpc } from '@/shared/rpc';
import type { ChatMessage, ChatPortMessage, SpeakResult, ScreenshotData, Settings } from '@/shared/types';
import { getSettings } from '@/shared/settings';
import type { AgentSummary } from '@/shared/protocol';
import { chatPost, ensureChatPort, onChatMessage } from './chat-client';
import { collectPageContext } from './dom-context';
import { renderMarkdown } from './markdown';
import { isActMode, autonomyMode, onActModeChange, setActMode, setAutonomy, executeActions } from './act/act';
import { COMMAND_HELP, parseCommand } from './act/commands';

const HOST_ID = 'browser-agent-root';
const UI_KEY = '__ba_ui';
const MIN_SNAP_WIDTH = 280;
const TTS_FIRST_CHUNK_MAX = 160;
const TTS_CHUNK_MAX = 320;
const TTS_PREFETCH = 2;

class FetchError extends Error {
  constructor(readonly index: number, override readonly cause: unknown) {
    super(`chunk ${index} failed`);
  }
}

function splitSpeechChunks(text: string): string[] {
  if (text.length <= TTS_CHUNK_MAX) return [text];
  const sentences = text.split(/(?<=[.!?…])\s+/).filter((part) => part.trim());
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const pieces = sentence.length > TTS_CHUNK_MAX
      ? hardSplit(sentence, TTS_CHUNK_MAX)
      : [sentence];
    for (const piece of pieces) {
      const cap = chunks.length === 0 ? TTS_FIRST_CHUNK_MAX : TTS_CHUNK_MAX;
      if (!current) {
        current = piece;
      } else if (current.length + piece.length + 1 <= cap) {
        current = `${current} ${piece}`;
      } else {
        chunks.push(current.trim());
        current = piece;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

function hardSplit(sentence: string, cap: number): string[] {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > cap) {
    let cut = rest.lastIndexOf(' ', cap);
    if (cut < cap * 0.5) cut = cap;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

interface Embed {
  label: string;
  screenshotDataUrl: string;
}

interface Handles {
  root: HTMLElement;
  pill: HTMLButtonElement;
  panel: HTMLElement;
  log: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  chips: HTMLElement;
  hint: HTMLElement;
  embedButtons: HTMLButtonElement[];
  mic: HTMLButtonElement;
  dock: HTMLButtonElement;
}

interface PersistedUi {
  snapped: boolean;
  snapWidth: number;
}

let handles: Handles | null = null;
let embeds: Embed[] = [];
let activeRequestId: string | null = null;
let pendingAssistant: { bubble: HTMLElement; text: string } | null = null;
let pendingReasoning: { bubble: HTMLElement; text: string } | null = null;
let agentRunning = false;
let agentPaused = false;
let renderedMessageCount = 0;
let snapped = false;
let snapWidth = 380;
let savedHtmlMargin: string | null = null;
let savedHtmlWidth: string | null = null;
let pillHideTimer: number | undefined;

const SPARKLE_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>';

const DOCK_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="2.5" width="5.5" height="11" rx="1.5" fill="currentColor"/></svg>';

const TRASH_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4.5 4l.7 9.5h5.6L11.5 4M6.7 6.5v4.5M9.3 6.5v4.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

const DOWNLOAD_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 2v8m0 0L5 7m3 3l3-3M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

const CAMERA_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 5h2.3l1.2-1.8h5L11.7 5H14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="9" r="2.1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

const MIC_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="6" y="1.5" width="4" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

type VoiceState = 'idle' | 'recording' | 'transcribing';

interface VoiceRecognitionResult extends Array<VoiceRecognitionAlternative> {
  isFinal: boolean;
}
interface VoiceRecognitionAlternative {
  transcript: string;
}
interface VoiceRecognitionResultList extends Array<VoiceRecognitionResult> {}
interface VoiceRecognitionEvent {
  resultIndex: number;
  results: VoiceRecognitionResultList;
}
interface VoiceRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: VoiceRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}
type VoiceRecognitionCtor = new () => VoiceRecognitionLike;

export function mountUi(css: string): void {
  if (document.getElementById(HOST_ID) != null) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = css;

  const root = document.createElement('div');
  root.className = 'ba-root';

  const pill = document.createElement('button');
  pill.className = 'ba-pill';
  pill.type = 'button';
  pill.title = 'Toggle Browser Agent';
  pill.innerHTML = SPARKLE_SVG;

  const panel = document.createElement('section');
  panel.className = 'ba-panel ba-hidden';
  panel.setAttribute('aria-label', 'Browser Agent panel');

  const header = document.createElement('header');
  header.className = 'ba-panel-header';
  const title = document.createElement('span');
  title.className = 'ba-title';
  title.textContent = 'Browser Agent';
  const actBtn = document.createElement('button');
  actBtn.className = 'ba-icon-btn ba-act-btn';
  actBtn.type = 'button';
  actBtn.title = 'Act mode: highlight and interact with page elements';
  actBtn.textContent = 'Act';
  const dock = document.createElement('button');
  dock.className = 'ba-icon-btn ba-dock';
  dock.type = 'button';
  dock.title = 'Snap to right side';
  dock.innerHTML = DOCK_SVG;
  const close = document.createElement('button');
  close.className = 'ba-icon-btn';
  close.type = 'button';
  close.title = 'Close';
  close.textContent = '×';
  const actions = document.createElement('div');
  actions.className = 'ba-header-actions';
  const clearBtn = iconButton(TRASH_SVG, 'Clear chat history', () => void clearChat());
  const exportBtn = iconButton(DOWNLOAD_SVG, 'Export chat as Markdown', () => void exportChat());
  actions.append(actBtn, clearBtn, exportBtn, dock, close);
  header.append(title, actions);

  const log = document.createElement('div');
  log.className = 'ba-log';
  const hint = makeHint();
  log.append(hint);

  const chips = document.createElement('div');
  chips.className = 'ba-chips ba-hidden';

  const inputRow = document.createElement('div');
  inputRow.className = 'ba-input-row';
  const cameraBtn = iconButton(CAMERA_SVG, 'Attach screenshot', () => void embedScreenshot());
  cameraBtn.classList.add('ba-camera');
  const micBtn = iconButton(MIC_SVG, 'Voice input', onMicClick);
  micBtn.classList.add('ba-mic');
  const input = document.createElement('textarea');
  input.className = 'ba-input';
  input.placeholder = 'Ask about this page…';
  input.rows = 1;
  const send = document.createElement('button');
  send.className = 'ba-send';
  send.type = 'button';
  send.textContent = 'Send';
  inputRow.append(cameraBtn, micBtn, input, send);

  const resizer = document.createElement('div');
  resizer.className = 'ba-resizer';

  panel.append(header, log, chips, inputRow, resizer);
  root.append(pill, panel);
  shadow.append(style, root);
  (document.body ?? document.documentElement).append(host);

  handles = {
    root,
    pill,
    panel,
    log,
    input,
    send,
    chips,
    hint,
    embedButtons: [cameraBtn],
    mic: micBtn,
    dock,
  };

  let voiceState: VoiceState = 'idle';
  let recognition: VoiceRecognitionLike | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let mediaStream: MediaStream | null = null;
  let audioChunks: Blob[] = [];
  let voiceBaseText = '';
  let discardTranscript = false;
  let currentTtsButton: HTMLButtonElement | null = null;
  let currentAudio: HTMLAudioElement | null = null;
  let currentAudioUrl: string | null = null;
  let ttsToken = 0;
  let autoRead = false;

  void getSettings().then((settings) => {
    autoRead = settings.ttsAutoRead === true;
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes.settings;
    if (!change) return;
    autoRead = (change.newValue as Settings | undefined)?.ttsAutoRead === true;
  });

  pill.addEventListener('click', togglePanel);
  pill.addEventListener('mouseenter', revealPill);
  pill.addEventListener('mouseleave', () => scheduleHide());
  actBtn.addEventListener('click', () => setActMode(!isActMode()));
  onActModeChange((modeActive) => actBtn.classList.toggle('ba-active', modeActive));
  dock.addEventListener('click', () => setSnapped(!snapped));
  close.addEventListener('click', closePanel);
  send.addEventListener('click', onSendClick);
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSendClick();
    }
  });
  resizer.addEventListener('pointerdown', startResize);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || isActMode()) return;
    if (snapped) setSnapped(false);
    else if (!panel.classList.contains('ba-hidden')) togglePanel();
  });

  onChatMessage(route);
  ensureChatPort();
  log.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) window.open(href, '_blank', 'noopener');
  });
  void loadHistory();
  void restoreAgentState();

  const saved = loadUi();
  if (saved?.snapped) {
    if (Number.isFinite(saved.snapWidth)) {
      snapWidth = clamp(saved.snapWidth, MIN_SNAP_WIDTH, 2000);
    }
    setSnapped(true);
  } else {
    scheduleHide(2000);
  }

  function autosize(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  }

  function onSendClick(): void {
    if (agentRunning) {
      chatPost({ type: 'agent.stop' });
      stopSpeech();
      window.setTimeout(() => {
        if (agentRunning) {
          agentRunning = false;
          updateComposerState();
          addNote('Agent stopped.');
        }
      }, 2000);
      return;
    }
    if (activeRequestId != null) {
      chatPost({ type: 'chat.stop', requestId: activeRequestId });
      stopSpeech();
      return;
    }
    void sendMessage();
  }

  async function sendMessage(): Promise<void> {
    if (!handles || agentRunning || activeRequestId != null) return;
    cancelVoice();
    stopSpeech();
    const text = handles.input.value.trim();

    if (text.toLowerCase() === 'help') {
      addUserMessage(text);
      addNote(COMMAND_HELP);
      return;
    }

    const lower = text.toLowerCase();
    if (lower === 'agent log') {
      addUserMessage(text);
      const state = await rpc<AgentSummary>({ kind: 'agent:get' });
      if (!state.narration.length) {
        addNote('No agent log for this tab yet.');
      } else {
        addNote(
          `Agent "${state.goal}" (${state.status}, step ${state.step}) — replaying ${state.narration.length} line(s):`,
        );
        for (const line of state.narration) addNote(line);
      }
      return;
    }

    if (lower === 'debug') {
      addUserMessage(text);
      const enabled = await rpc<boolean>({ kind: 'agent:debug' });
      addNote(
        enabled
          ? 'Agent debug details ON — timings also in the service worker console (chrome://extensions → Browser Agent → Inspect views: service worker).'
          : 'Agent debug details OFF.',
      );
      return;
    }

    const commandOps = parseCommand(text);
    if (commandOps) {
      addUserMessage(text);
      const observations = await executeActions(commandOps, autonomyMode());
      for (const observation of observations) {
        const label = `${observation.op}${observation.target != null ? ` [${observation.target}]` : ''}`;
        addNote(
          observation.ok
            ? `${label} → ok${observation.message ? ` — ${observation.message}` : ''}`
            : `${label} → failed — ${observation.message ?? 'unknown error'}`,
        );
      }
      return;
    }

    if (agentPaused) {
      agentPaused = false;
      agentRunning = true;
      updateComposerState();
      handles.input.value = '';
      autosize();
      if (text) addUserMessage(text);
      addNote('Resuming agent...');
      chatPost({ type: 'agent.resume', text: text || 'continue' });
      return;
    }

    if (isActMode()) {
      agentRunning = true;
      updateComposerState();
      addNote(`Agent goal: ${text}`);
      handles.input.value = '';
      autosize();
      chatPost({ type: 'agent.start', goal: text, confirmMode: autonomyMode() });
      return;
    }

    const shots = embeds;
    if (!text && shots.length === 0) return;

    const requestId = newRequestId();
    activeRequestId = requestId;
    pendingAssistant = null;
    pendingReasoning = null;

    const pageContext = collectPageContext();
    addUserMessage(text || '(page content attached)');
    addNote(`Page context attached (${(pageContext.length / 1024).toFixed(1)} kB)`);
    if (shots.length) addNote(`${shots.length} screenshot(s) attached`);

    embeds = [];
    renderChips();
    handles.input.value = '';
    autosize();
    setStreaming(true);

    chatPost({
      type: 'chat.send',
      requestId,
      text: text || 'Here is the page content. Summarize it briefly.',
      pageContext,
      screenshots: shots.length ? shots.map((embed) => embed.screenshotDataUrl) : undefined,
      url: location.href,
      title: document.title,
    });
  }

  function route(message: ChatPortMessage): void {
    if (!handles) return;
    switch (message.type) {
      case 'chat.delta': {
        if (message.requestId !== activeRequestId) return;
        if (message.reasoning) {
          appendReasoning(message.text);
        } else {
          if (!pendingAssistant) {
            collapseReasoning();
            pendingAssistant = { bubble: addAssistantMessage(''), text: '' };
          }
          pendingAssistant.text += message.text;
          pendingAssistant.bubble.innerHTML = renderMarkdown(pendingAssistant.text);
        }
        scrollLog();
        break;
      }
      case 'chat.done': {
        if (message.requestId !== activeRequestId) return;
        collapseReasoning();
        finalizeAssistant(message.text, message.stopped === true);
        setStreaming(false);
        activeRequestId = null;
        break;
      }
      case 'chat.error': {
        if (message.requestId !== activeRequestId) return;
        if (pendingAssistant && !pendingAssistant.text) pendingAssistant.bubble.remove();
        pendingAssistant = null;
        addNote(`Error: ${message.message}`);
        setStreaming(false);
        activeRequestId = null;
        break;
      }
      case 'chat.answer': {
        const ttsButton = attachTts(addAssistantMessage(message.text), message.text);
        if (autoRead) speakText(message.text, ttsButton);
        break;
      }
      case 'agent.step': {
        addNote(`Step ${message.step}: ${message.thought || '(no thought)'}`);
        for (const detail of message.details ?? []) addNote(`  · ${detail}`);
        for (const observation of message.observations) {
          const label = `${observation.op}${observation.target != null ? ` [${observation.target}]` : ''}`;
          const rawMessage = observation.message ?? '';
          const display =
            observation.op === 'extract' && observation.ok
              ? `${rawMessage.slice(0, 400)}${rawMessage.length > 400 ? '…' : ''}`
              : rawMessage;
          addNote(
            observation.ok
              ? `  ${label} → ok${display ? ` — ${display}` : ''}`
              : `  ${label} → failed — ${display || 'unknown error'}`,
          );
        }
        break;
      }
      case 'agent.done': {
        agentRunning = false;
        agentPaused = false;
        updateComposerState();
        addNote(`Agent finished${message.summary ? `: ${message.summary}` : ''}.`);
        break;
      }
      case 'agent.paused': {
        agentRunning = false;
        agentPaused = true;
        updateComposerState();
        if (message.reason === 'blocked') {
          addNote('Agent paused - send a message to answer and continue.');
        } else {
          addNote(`${message.question} (reply "continue" to keep going.)`);
        }
        break;
      }
      case 'agent.error': {
        agentRunning = false;
        agentPaused = false;
        updateComposerState();
        addNote(`Agent error: ${message.message}`);
        break;
      }
    }
  }

  function finalizeAssistant(text: string, stopped: boolean): void {
    if (text) {
      let ttsButton: HTMLButtonElement;
      if (pendingAssistant) {
        pendingAssistant.bubble.innerHTML = renderMarkdown(text);
        ttsButton = attachTts(pendingAssistant.bubble, text);
      } else {
        ttsButton = attachTts(addAssistantMessage(text), text);
      }
      if (stopped) addNote('(stopped)');
      else if (autoRead) speakText(text, ttsButton);
    } else {
      pendingAssistant?.bubble.remove();
      addNote(stopped ? 'Stopped.' : 'Empty response.');
    }
    pendingAssistant = null;
    scrollLog();
  }

  function appendReasoning(text: string): void {
    if (!pendingReasoning) {
      pendingReasoning = { bubble: addReasoningBubble(''), text: '' };
    }
    pendingReasoning.text += text;
    pendingReasoning.bubble.innerHTML = renderMarkdown(capReasoning(pendingReasoning.text));
  }

  function collapseReasoning(): void {
    if (!pendingReasoning) return;
    pendingReasoning.bubble.textContent = capReasoning(pendingReasoning.text, 300);
    pendingReasoning = null;
  }

  function capReasoning(text: string, cap = 1500): string {
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
  }

  function setStreaming(streaming: boolean): void {
    void streaming;
    updateComposerState();
  }

  function updateComposerState(): void {
    if (!handles) return;
    const chatBusy = activeRequestId != null;
    const busy = chatBusy || agentRunning;
    handles.send.textContent = busy ? 'Stop' : 'Send';
    handles.send.classList.toggle('ba-stop', agentRunning);
    for (const button of handles.embedButtons) button.disabled = busy;
    handles.mic.classList.toggle('ba-recording', voiceState === 'recording');
    handles.mic.classList.toggle('ba-busy', voiceState === 'transcribing');
    handles.mic.disabled = busy || voiceState === 'transcribing';
    handles.mic.title = voiceState === 'recording' ? 'Stop recording' : 'Voice input';
  }

  async function restoreAgentState(): Promise<void> {
    try {
      const state = await rpc<AgentSummary>({ kind: 'agent:get' });
      if (!handles) return;
      if (state.status === 'running') {
        agentRunning = true;
        setAutonomy(state.confirmMode);
        updateComposerState();
        addNote(`Agent running: "${state.goal}" (step ${state.step})`);
        for (const line of state.narration.slice(-10)) addNote(line);
        // If the run finishes while notifications were lost across a
        // navigation (no port yet), catch up once: render the finish and any
        // answer that was saved after this panel loaded its history.
        window.setTimeout(() => void catchUpAfterRestore(), 2500);
      } else if (state.status === 'paused') {
        agentPaused = true;
        setAutonomy(state.confirmMode);
        addNote(
          state.pauseQuestion
            ? `Agent paused: ${state.pauseQuestion} - send a message to continue.`
            : `Agent paused on "${state.goal}" - send a message to continue.`,
        );
      } else if (state.status === 'finished' && state.goal) {
        addNote(
          `Last agent run: "${state.goal}" (step ${state.step}) — type "agent log" to replay.`,
        );
      }
    } catch {
      return;
    }
  }

  async function catchUpAfterRestore(): Promise<void> {
    if (!handles || !agentRunning) return;
    try {
      const state = await rpc<AgentSummary>({ kind: 'agent:get' });
      if (!handles || !agentRunning) return;
      if (state.status !== 'finished') return;
      agentRunning = false;
      updateComposerState();
      const last = state.narration[state.narration.length - 1];
      if (last) addNote(last);
      const messages = await rpc<ChatMessage[]>({ kind: 'chat:history' });
      for (const message of messages.slice(renderedMessageCount)) {
        if (message.role === 'assistant' && message.text) {
          attachTts(addAssistantMessage(message.text), message.text);
        }
      }
      renderedMessageCount = messages.length;
    } catch {
      return;
    }
  }

  async function embedScreenshot(): Promise<void> {
    if (!handles || activeRequestId != null) return;
    try {
      const { dataUrl } = await rpc<ScreenshotData>({ kind: 'screenshot:capture' });
      const count = embeds.length + 1;
      embeds.push({ label: `Screenshot ${count}`, screenshotDataUrl: dataUrl });
      renderChips();
    } catch (error) {
      addNote(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function setVoiceState(state: VoiceState): void {
    voiceState = state;
    updateComposerState();
  }

  function onMicClick(): void {
    if (voiceState === 'recording') {
      discardTranscript = false;
      stopVoiceCapture();
      return;
    }
    if (voiceState !== 'idle' || activeRequestId != null || agentRunning) return;
    void startVoice();
  }

  async function startVoice(): Promise<void> {
    if (!handles) return;
    const native = createNativeRecognition();
    if (native) {
      startNativeRecognition(native);
      return;
    }
    const settings = await getSettings();
    if (settings.sttEndpointUrl) {
      await startEndpointRecording();
      return;
    }
    addNote(
      'Voice input needs Chrome or Edge (built-in speech), or an STT endpoint in Options → Voice.',
    );
  }

  function createNativeRecognition(): VoiceRecognitionLike | null {
    const w = window as unknown as {
      SpeechRecognition?: VoiceRecognitionCtor;
      webkitSpeechRecognition?: VoiceRecognitionCtor;
    };
    const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!ctor) return null;
    const instance = new ctor();
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = navigator.language || 'en-US';
    return instance;
  }

  function startNativeRecognition(instance: VoiceRecognitionLike): void {
    if (!handles) return;
    recognition = instance;
    voiceBaseText = handles.input.value;
    discardTranscript = false;
    let finalText = '';
    setVoiceState('recording');
    instance.onresult = (event) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        if (result.isFinal) finalText = `${finalText} ${result[0]!.transcript} `;
        else interim += result[0]!.transcript;
      }
      if (!discardTranscript) applyVoiceText(finalText + interim);
    };
    instance.onerror = (event) => {
      const code = event.error ?? 'unknown';
      if (code === 'no-speech' || code === 'aborted') return;
      addNote(
        `Speech recognition error: ${code}${
          code === 'not-allowed' ? ' - allow microphone access for this site.' : ''
        }`,
      );
    };
    instance.onend = () => {
      recognition = null;
      setVoiceState('idle');
    };
    try {
      instance.start();
    } catch (error) {
      recognition = null;
      setVoiceState('idle');
      addNote(
        `Could not start speech recognition: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function stopVoiceCapture(): void {
    if (recognition) {
      recognition.stop();
      return;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      setVoiceState('transcribing');
      mediaRecorder.stop();
    }
  }

  async function startEndpointRecording(): Promise<void> {
    if (!handles) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      addNote('Audio capture is not available in this browser.');
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      addNote(
        `Microphone unavailable: ${
          error instanceof Error ? error.message : String(error)
        } - allow mic access for this site.`,
      );
      return;
    }
    audioChunks = [];
    discardTranscript = false;
    const recorder = new MediaRecorder(mediaStream);
    mediaRecorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };
    recorder.onstop = () => void finishEndpointRecording(recorder.mimeType);
    recorder.start();
    setVoiceState('recording');
  }

  async function finishEndpointRecording(mimeType: string): Promise<void> {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    const blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
    audioChunks = [];
    mediaRecorder = null;
    if (discardTranscript) {
      discardTranscript = false;
      setVoiceState('idle');
      return;
    }
    try {
      const base64 = await blobToBase64(blob);
      const text = await rpc<string>({
        kind: 'voice:transcribe',
        audioBase64: base64,
        mimeType: blob.type,
      });
      if (!discardTranscript) applyVoiceText(text);
    } catch (error) {
      addNote(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVoiceState('idle');
    }
  }

  function applyVoiceText(transcript: string): void {
    if (!handles) return;
    const trimmed = transcript.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const base = voiceBaseText.trimEnd();
    handles.input.value = base ? `${base} ${trimmed}` : trimmed;
    autosize();
  }

  function cancelVoice(): void {
    if (voiceState === 'recording') {
      discardTranscript = true;
      if (recognition) recognition.abort();
      else stopVoiceCapture();
    } else if (voiceState === 'transcribing') {
      discardTranscript = true;
    }
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Could not read recorded audio'));
          return;
        }
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(new Error('Could not read recorded audio'));
      reader.readAsDataURL(blob);
    });
  }

  function makeTtsButton(text: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'ba-tts';
    button.type = 'button';
    button.title = 'Read aloud';
    button.textContent = '▶';
    button.addEventListener('click', () => toggleSpeech(text, button));
    return button;
  }

  function attachTts(bubble: HTMLElement, text: string): HTMLButtonElement {
    const existing = bubble.querySelector('.ba-tts');
    if (existing instanceof HTMLButtonElement) return existing;
    const button = makeTtsButton(text);
    bubble.append(button);
    return button;
  }

  function toggleSpeech(text: string, button: HTMLButtonElement): void {
    if (currentTtsButton === button) {
      stopSpeech();
      return;
    }
    stopSpeech();
    const spoken = stripMarkdownForSpeech(text);
    if (!spoken) return;
    currentTtsButton = button;
    button.textContent = '…';
    button.title = 'Loading audio…';
    const token = ttsToken;
    void speakWithEndpoint(spoken, button, token).then((played) => {
      if (token !== ttsToken || played) return;
      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.onend = () => resetTtsButton(button);
      utterance.onerror = () => resetTtsButton(button);
      speechSynthesis.speak(utterance);
      button.textContent = '⏹';
      button.title = 'Stop reading';
    });
  }

  function speakText(text: string, button?: HTMLButtonElement): void {
    stopSpeech();
    const spoken = stripMarkdownForSpeech(text);
    if (!spoken) return;
    if (button) {
      currentTtsButton = button;
      button.textContent = '…';
      button.title = 'Loading audio…';
    }
    const token = ttsToken;
    void speakWithEndpoint(spoken, button ?? null, token).then((played) => {
      if (token !== ttsToken || played) return;
      if (button) {
        button.textContent = '⏹';
        button.title = 'Stop reading';
      }
      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.onend = () => {
        if (button) resetTtsButton(button);
      };
      utterance.onerror = () => {
        if (button) resetTtsButton(button);
      };
      speechSynthesis.speak(utterance);
    });
  }

  async function speakWithEndpoint(
    spoken: string,
    button: HTMLButtonElement | null,
    token: number,
  ): Promise<boolean> {
    let settings: Settings;
    try {
      settings = await getSettings();
    } catch {
      return false;
    }
    if (!settings.ttsEndpointUrl?.trim()) return false;
    const chunks = splitSpeechChunks(spoken);
    const pending: Promise<SpeakResult>[] = [];
    const fetchStart = performance.now();
    let nextToFetch = 0;
    let startedPlaying = false;
    const startFetches = (): void => {
      // The first chunk fires ALONE: servers that queue or batch concurrent
      // requests would otherwise delay its response (and the first spoken
      // word) behind the rest of the burst. Once playback has started, keep
      // TTS_PREFETCH chunks in flight so playback rarely waits.
      const maxInFlight = startedPlaying ? TTS_PREFETCH + 1 : 1;
      while (nextToFetch < chunks.length && pending.length < maxInFlight) {
        const index = nextToFetch++;
        const text = chunks[index]!;
        pending.push(
          rpc<SpeakResult>({ kind: 'voice:speak', text }).then(
            (result) => {
              console.info(
                `[panel] tts: chunk ${index + 1}/${chunks.length} fetched in ${Math.round(performance.now() - fetchStart)}ms`,
              );
              return result;
            },
            (error) => {
              throw new FetchError(index, error);
            },
          ),
        );
      }
    };
    let playedAny = false;
    try {
      startFetches();
      for (let index = 0; index < chunks.length; index++) {
        const { audioBase64, mimeType } = await pending.shift()!;
        if (token !== ttsToken) return true;
        if (index === 0) startedPlaying = true;
        startFetches();
        const blob = new Blob([base64ToBytes(audioBase64)], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const cleanup = () => {
          if (currentAudio === audio) currentAudio = null;
          if (currentAudioUrl === url) {
            URL.revokeObjectURL(url);
            currentAudioUrl = null;
          }
        };
        audio.addEventListener('ended', cleanup);
        audio.addEventListener('error', cleanup);
        currentAudio = audio;
        currentAudioUrl = url;
        if (index === 0 && button) {
          button.textContent = '⏹';
          button.title = 'Stop reading';
        }
        console.info(
          `[panel] tts: playing chunk ${index + 1}/${chunks.length} at ${Math.round(performance.now() - fetchStart)}ms`,
        );
        await playAudio(audio);
        playedAny = true;
      }
      if (token === ttsToken && button) resetTtsButton(button);
      return true;
    } catch (error) {
      if (token !== ttsToken) return true;
      if (error instanceof FetchError && error.index === 0 && !playedAny) {
        console.warn(
          '[panel] TTS endpoint failed; falling back to built-in speech:',
          error.cause instanceof Error ? error.cause.message : error.cause,
        );
        return false;
      }
      console.warn(
        '[panel] TTS read stopped early (chunk failed):',
        error instanceof Error ? error.message : error,
      );
      if (button) resetTtsButton(button);
      return true;
    }
  }

  function playAudio(audio: HTMLAudioElement): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      audio.addEventListener('ended', () => resolvePromise(), { once: true });
      audio.addEventListener('error', () => rejectPromise(new Error('audio playback failed')), {
        once: true,
      });
      audio.play().catch(rejectPromise);
    });
  }

  function stopSpeech(): void {
    ttsToken++;
    speechSynthesis.cancel();
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = null;
    }
    if (currentTtsButton) resetTtsButton(currentTtsButton);
  }

  function resetTtsButton(button: HTMLButtonElement): void {
    button.textContent = '▶';
    button.title = 'Read aloud';
    if (currentTtsButton === button) currentTtsButton = null;
  }

  function stripMarkdownForSpeech(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, ' (code omitted) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function renderChips(): void {
    if (!handles) return;
    handles.chips.replaceChildren();
    embeds.forEach((embed, index) => {
      const chip = document.createElement('div');
      chip.className = 'ba-chip';
      const label = document.createElement('span');
      label.textContent = embed.label;
      const remove = document.createElement('button');
      remove.className = 'ba-chip-x';
      remove.type = 'button';
      remove.title = 'Remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        embeds.splice(index, 1);
        renderChips();
      });
      chip.append(label, remove);
      handles!.chips.append(chip);
    });
    handles.chips.classList.toggle('ba-hidden', embeds.length === 0);
  }

  async function loadHistory(): Promise<void> {
    try {
      const messages = await rpc<ChatMessage[]>({ kind: 'chat:history' });
      renderedMessageCount = messages.length;
      for (const message of messages) {
        if (message.role === 'user') {
          addUserMessage(message.text || '(page content attached)');
          if (message.pageContext) addNote('Page context attached');
          if (message.images?.length) addNote(`${message.images.length} screenshot(s) attached`);
        } else {
          attachTts(addAssistantMessage(message.text), message.text);
        }
      }
    } catch {
      addNote('Could not load chat history.');
    }
  }

  function addUserMessage(text: string): void {
    removeHint();
    const bubble = document.createElement('div');
    bubble.className = 'ba-msg-user';
    bubble.textContent = text;
    handles!.log.append(bubble);
    scrollLog();
  }

  function addAssistantMessage(text: string): HTMLElement {
    removeHint();
    const bubble = document.createElement('div');
    bubble.className = 'ba-msg-assistant';
    bubble.innerHTML = renderMarkdown(text);
    handles!.log.append(bubble);
    scrollLog();
    return bubble;
  }

  function addReasoningBubble(text: string): HTMLElement {
    removeHint();
    const bubble = document.createElement('div');
    bubble.className = 'ba-msg-reasoning';
    bubble.innerHTML = renderMarkdown(text);
    handles!.log.append(bubble);
    scrollLog();
    return bubble;
  }

  function addNote(text: string): void {
    removeHint();
    const note = document.createElement('div');
    note.className = 'ba-note';
    note.textContent = text;
    handles!.log.append(note);
    scrollLog();
  }

  function removeHint(): void {
    const hint = handles?.hint;
    if (hint && hint.isConnected) hint.remove();
  }

  function scrollLog(): void {
    if (!handles) return;
    handles.log.scrollTop = handles.log.scrollHeight;
  }
}

export function togglePanel(): void {
  if (!handles) return;
  if (snapped) {
    setSnapped(false);
    return;
  }
  const hidden = handles.panel.classList.toggle('ba-hidden');
  if (!hidden) {
    revealPill();
    handles.input.focus();
  } else {
    scheduleHide();
  }
}

export function prefillInput(text: string): void {
  if (!handles) return;
  handles.input.value = text;
  handles.input.style.height = 'auto';
  handles.input.style.height = `${Math.min(handles.input.scrollHeight, 96)}px`;
  if (handles.panel.classList.contains('ba-hidden')) togglePanel();
  handles.input.focus();
}

function makeHint(): HTMLElement {
  const hint = document.createElement('div');
  hint.className = 'ba-hint';
  hint.textContent =
    'Send chats about this page (page context is attached automatically; camera attaches screenshots). Agent runs your message as an autonomous goal. Local commands: "click 12", "type "x" into 17", "help".';
  return hint;
}

function iconButton(svg: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'ba-icon-btn';
  button.type = 'button';
  button.title = title;
  button.innerHTML = svg;
  button.addEventListener('click', onClick);
  return button;
}

async function clearChat(): Promise<void> {
  try {
    await rpc<boolean>({ kind: 'chat:clear' });
  } catch {
    return;
  }
  if (!handles) return;
  handles.log.replaceChildren();
  const hint = makeHint();
  handles.log.append(hint);
  handles.hint = hint;
}

async function exportChat(): Promise<void> {
  if (!handles) return;
  let messages: ChatMessage[];
  try {
    messages = await rpc<ChatMessage[]>({ kind: 'chat:history' });
  } catch (error) {
    addNotePublic(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (messages.length === 0) {
    addNotePublic('Nothing to export yet.');
    return;
  }
  const markdown = buildTranscript(messages);
  downloadText(`browser-agent-chat-${timestamp()}.md`, markdown);
  addNotePublic(`Exported ${messages.length} message(s) as Markdown.`);
}

function addNotePublic(text: string): void {
  if (!handles) return;
  const note = document.createElement('div');
  note.className = 'ba-note';
  note.textContent = text;
  handles.log.append(note);
  handles.log.scrollTop = handles.log.scrollHeight;
}

function buildTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [
    '# Browser Agent chat',
    '',
    `- Page: ${document.title} (${location.href})`,
    `- Exported: ${new Date().toISOString()}`,
    '',
  ];
  for (const message of messages) {
    lines.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}`, '');
    lines.push(message.text || '_(no text)_');
    if (message.pageContext) {
      lines.push(
        '',
        `_(Page context attached: ${(message.pageContext.length / 1024).toFixed(1)} kB)_`,
      );
    }
    if (message.images?.length) {
      lines.push('', `_(Screenshots attached: ${message.images.length})_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function scheduleHide(delay = 1200): void {
  if (pillHideTimer !== undefined) window.clearTimeout(pillHideTimer);
  pillHideTimer = window.setTimeout(() => {
    handles?.pill.classList.add('ba-autohide');
  }, delay);
}

function revealPill(): void {
  if (pillHideTimer !== undefined) {
    window.clearTimeout(pillHideTimer);
    pillHideTimer = undefined;
  }
  handles?.pill.classList.remove('ba-autohide');
}

function setSnapped(value: boolean): void {
  snapped = value;
  if (!handles) return;
  handles.root.classList.toggle('ba-snapped', snapped);
  handles.dock.title = snapped ? 'Unsnap from side' : 'Snap to right side';
  if (snapped) {
    handles.panel.classList.remove('ba-hidden');
    applyPageOffset();
    revealPill();
  } else {
    removePageOffset();
    scheduleHide();
  }
  persistUi();
}

function applyPageOffset(): void {
  if (!handles) return;
  handles.panel.style.setProperty('--ba-snap-width', `${snapWidth}px`);
  const html = document.documentElement;
  if (savedHtmlMargin == null) {
    savedHtmlMargin = html.style.marginRight;
    savedHtmlWidth = html.style.width;
  }
  html.style.marginRight = `${snapWidth}px`;
  html.style.width = `calc(100% - ${snapWidth}px)`;
}

function removePageOffset(): void {
  if (savedHtmlMargin == null || savedHtmlWidth == null) return;
  const html = document.documentElement;
  html.style.marginRight = savedHtmlMargin;
  html.style.width = savedHtmlWidth;
  savedHtmlMargin = null;
  savedHtmlWidth = null;
}

function startResize(event: PointerEvent): void {
  if (!handles) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = snapWidth;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = 'none';
  const onMove = (moveEvent: PointerEvent): void => {
    snapWidth = clamp(
      startWidth + (startX - moveEvent.clientX),
      MIN_SNAP_WIDTH,
      Math.max(MIN_SNAP_WIDTH, window.innerWidth - 320),
    );
    applyPageOffset();
  };
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.style.userSelect = previousUserSelect;
    persistUi();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function closePanel(): void {
  if (!handles) return;
  if (snapped) setSnapped(false);
  handles.panel.classList.add('ba-hidden');
  scheduleHide();
}

function persistUi(): void {
  try {
    window.sessionStorage.setItem(UI_KEY, JSON.stringify({ snapped, snapWidth }));
  } catch {
    return;
  }
}

function loadUi(): PersistedUi | null {
  try {
    const raw = window.sessionStorage.getItem(UI_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedUi;
  } catch {
    return null;
  }
}

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
