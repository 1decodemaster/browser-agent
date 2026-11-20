import { rpc } from '@/shared/rpc';
import type { ChatMessage, ChatPortMessage, ScreenshotData } from '@/shared/types';
import { chatPost, onChatMessage } from './chat-client';
import { collectPageHtml } from './dom-context';
import { renderMarkdown } from './markdown';
import { isActMode, onActModeChange, setActMode } from './act/act';

const HOST_ID = 'browser-agent-root';
const UI_KEY = '__ba_ui';
const MIN_SNAP_WIDTH = 280;

interface Embed {
  kind: 'html' | 'screenshot';
  label: string;
  html?: string;
  screenshotDataUrl?: string;
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

  const embedRow = document.createElement('div');
  embedRow.className = 'ba-embed-row';
  const embedHtmlButton = embedButton('html', 'Embed HTML', embedHtml);
  const embedShotButton = embedButton('screenshot', 'Embed Screenshot', embedScreenshot);
  embedRow.append(embedHtmlButton, embedShotButton);

  const inputRow = document.createElement('div');
  inputRow.className = 'ba-input-row';
  const input = document.createElement('textarea');
  input.className = 'ba-input';
  input.placeholder = 'Ask about this page…';
  input.rows = 1;
  const send = document.createElement('button');
  send.className = 'ba-send';
  send.type = 'button';
  send.textContent = 'Send';
  inputRow.append(input, send);

  const resizer = document.createElement('div');
  resizer.className = 'ba-resizer';

  panel.append(header, log, chips, embedRow, inputRow, resizer);
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
    embedButtons: [embedHtmlButton, embedShotButton],
    dock,
  };

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
  log.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) window.open(href, '_blank', 'noopener');
  });
  void loadHistory();

  const saved = loadUi();
  if (saved?.snapped) {
    if (Number.isFinite(saved.snapWidth)) {
      snapWidth = clamp(saved.snapWidth, MIN_SNAP_WIDTH, 2000);
    }
    setSnapped(true);
  } else {
    scheduleHide(2000);
  }

  function embedButton(
    kind: 'html' | 'screenshot',
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'ba-embed';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  function autosize(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  }

  function onSendClick(): void {
    if (activeRequestId != null) {
      chatPost({ type: 'chat.stop', requestId: activeRequestId });
      return;
    }
    sendMessage();
  }

  function sendMessage(): void {
    if (!handles) return;
    const text = handles.input.value.trim();
    const htmlEmbed = embeds.find((embed) => embed.kind === 'html');
    const shotEmbed = embeds.find((embed) => embed.kind === 'screenshot');
    if (!text && !htmlEmbed && !shotEmbed) return;

    const requestId = newRequestId();
    activeRequestId = requestId;
    pendingAssistant = null;
    pendingReasoning = null;

    addUserMessage(text || '(page content attached)');
    if (htmlEmbed) addNote(`HTML attached (${(htmlEmbed.html!.length / 1024).toFixed(1)} kB)`);
    if (shotEmbed) addNote('Screenshot attached');

    embeds = [];
    renderChips();
    handles.input.value = '';
    autosize();
    setStreaming(true);

    chatPost({
      type: 'chat.send',
      requestId,
      text: text || 'Here is the page content. Summarize it briefly.',
      html: htmlEmbed?.html,
      screenshotDataUrl: shotEmbed?.screenshotDataUrl,
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
    }
  }

  function finalizeAssistant(text: string, stopped: boolean): void {
    if (text) {
      if (pendingAssistant) pendingAssistant.bubble.innerHTML = renderMarkdown(text);
      else addAssistantMessage(text);
      if (stopped) addNote('(stopped)');
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
    if (!handles) return;
    handles.send.textContent = streaming ? 'Stop' : 'Send';
    for (const button of handles.embedButtons) button.disabled = streaming;
  }

  function embedHtml(): void {
    if (!handles || activeRequestId != null) return;
    embeds = embeds.filter((embed) => embed.kind !== 'html');
    const html = collectPageHtml();
    embeds.push({
      kind: 'html',
      label: `HTML · ${(html.length / 1024).toFixed(1)} kB`,
      html,
    });
    renderChips();
  }

  async function embedScreenshot(): Promise<void> {
    if (!handles || activeRequestId != null) return;
    try {
      const { dataUrl } = await rpc<ScreenshotData>({ kind: 'screenshot:capture' });
      embeds = embeds.filter((embed) => embed.kind !== 'screenshot');
      embeds.push({ kind: 'screenshot', label: 'Screenshot', screenshotDataUrl: dataUrl });
      renderChips();
    } catch (error) {
      addNote(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      for (const message of messages) {
        if (message.role === 'user') {
          addUserMessage(message.text || '(page content attached)');
          if (message.html) addNote('HTML attached');
          if (message.images?.length) addNote('Screenshot attached');
        } else {
          addAssistantMessage(message.text);
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
    'Ask about this page. Embed buttons attach HTML/screenshot to your next message. Act mode pins elements; commands like "click 12" or "type "x" into 17" run locally.';
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
    if (message.html) {
      lines.push('', `_(HTML context attached: ${(message.html.length / 1024).toFixed(1)} kB)_`);
    }
    if (message.images?.length) {
      lines.push('', '_(Screenshot attached)_');
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
