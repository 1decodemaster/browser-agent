import { buildElementTable, ElementTable, serializeTable } from './indexer';
import { mountSpotlight, type ActionItem, type Spotlight } from './spotlight';
import { clickElement, copyText, focusElement, setValue } from './executor';

const ACT_HOST_ID = 'browser-agent-act-root';
const PANEL_HOST_ID = 'browser-agent-root';

let spotlight: Spotlight | null = null;
let active = false;
let table: ElementTable | null = null;
let tableDirty = false;
let pinned: { element: HTMLElement; id: number } | null = null;
let onAsk: ((text: string) => void) | null = null;
let observer: MutationObserver | null = null;
let rebuildTimer: number | undefined;
let hoverRaf = 0;
let lastPointer = { x: 0, y: 0 };
let savedBodyCursor: string | null = null;
const changeCallbacks: Array<(active: boolean) => void> = [];

export function mountAct(css: string): void {
  if (document.getElementById(ACT_HOST_ID) != null) return;
  spotlight = mountSpotlight(css);
}

export function configureAct(options: { onAsk: (text: string) => void }): void {
  onAsk = options.onAsk;
}

export function onActModeChange(callback: (active: boolean) => void): void {
  changeCallbacks.push(callback);
}

export function isActMode(): boolean {
  return active;
}

export function setActMode(on: boolean): void {
  if (on === active) return;
  active = on;
  if (!spotlight) return;

  if (on) {
    table = buildElementTable();
    tableDirty = false;
    pinned = null;
    spotlight.setActive(true);
    spotlight.hideHighlight();
    spotlight.hideBar();
    spotlight.setBanner('Act mode — click an element to pin it · Esc to exit');
    savedBodyCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    startListeners();
  } else {
    stopListeners();
    pinned = null;
    spotlight.setActive(false);
    if (savedBodyCursor != null) {
      document.body.style.cursor = savedBodyCursor;
      savedBodyCursor = null;
    }
  }
  for (const callback of changeCallbacks) callback(active);
}

export function getElementTable(): ElementTable | null {
  if (tableDirty) refreshTable();
  return table;
}

export function serializeIndex(): string | null {
  const current = getElementTable();
  return current ? serializeTable(current) : null;
}

function refreshTable(): void {
  table = buildElementTable();
  tableDirty = false;
}

function ensureFreshTable(): ElementTable {
  if (!table || tableDirty) refreshTable();
  return table!;
}

function startListeners(): void {
  document.addEventListener('mousemove', onHover, true);
  document.addEventListener('click', onCaptureClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  observer = new MutationObserver(() => {
    tableDirty = true;
    if (rebuildTimer !== undefined) window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => {
      rebuildTimer = undefined;
      if (!active || pinned) return;
      refreshTable();
    }, 500);
  });
  observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
  });
}

function stopListeners(): void {
  document.removeEventListener('mousemove', onHover, true);
  document.removeEventListener('click', onCaptureClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', onScroll, true);
  observer?.disconnect();
  observer = null;
  if (hoverRaf) {
    cancelAnimationFrame(hoverRaf);
    hoverRaf = 0;
  }
}

function interestingAt(element: Element | null): HTMLElement | null {
  let current: Element | null = element;
  while (current) {
    if (current instanceof HTMLElement && !isOwnHost(current) && isInteresting(current)) {
      return current;
    }
    current = current.parentElement ?? (current.getRootNode() as ShadowRoot | null)?.host ?? null;
  }
  return null;
}

function isOwnHost(element: Element): boolean {
  return element.id === ACT_HOST_ID || element.id === PANEL_HOST_ID;
}

function isInteresting(element: HTMLElement): boolean {
  const current = ensureFreshTable();
  return current.idFor(element) !== undefined;
}

function onHover(event: MouseEvent): void {
  lastPointer = { x: event.clientX, y: event.clientY };
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    if (!active || !spotlight || pinned) return;
    const target = interestingAt(document.elementFromPoint(lastPointer.x, lastPointer.y));
    if (!target) {
      spotlight.hideHighlight();
      spotlight.setLabel(null);
      return;
    }
    const current = ensureFreshTable();
    const id = current.idFor(target);
    if (id == null) return;
    const rect = target.getBoundingClientRect();
    spotlight.highlight(rect, 'scan');
    spotlight.setLabel(labelText(current, id), rect);
  });
}

function onCaptureClick(event: MouseEvent): void {
  if (!active || !spotlight) return;
  const target = event.target as Element | null;
  if (target && isOwnHost(target)) return;
  event.preventDefault();
  event.stopPropagation();
  pinAt(event.clientX, event.clientY);
}

function pinAt(x: number, y: number): void {
  const target = interestingAt(document.elementFromPoint(x, y));
  if (!target) return;
  pin(target);
}

function pin(element: HTMLElement): void {
  const current = ensureFreshTable();
  let id = current.idFor(element);
  if (id == null) {
    refreshTable();
    id = table!.idFor(element);
    if (id == null) return;
  }
  pinned = { element, id };
  const info = current.info.get(id)!;
  const rect = element.getBoundingClientRect();
  spotlight!.highlight(rect, 'focus', true);
  spotlight!.setLabel(labelText(current, id), rect);
  spotlight!.showActionBar(rect, actionsFor(element, info));
}

function unpin(): void {
  pinned = null;
  if (!spotlight) return;
  spotlight.hideBar();
  spotlight.setLabel(null);
  spotlight.hideHighlight();
}

function labelText(tableRef: ElementTable, id: number): string {
  const info = tableRef.info.get(id)!;
  const name = info.name ? ` · "${info.name}"` : '';
  return `[${id}] ${info.role}${name}`;
}

function actionsFor(element: HTMLElement, info: { tag: string; role: string; kind: string }): ActionItem[] {
  const ask: ActionItem = {
    label: 'Ask',
    onClick: () => {
      const text = describeForChat(element, info);
      unpin();
      onAsk?.(text);
    },
  };
  const flash = (fn: () => void): void => {
    fn();
    flashSuccess(element);
  };

  if (info.kind === 'content') {
    const actions: ActionItem[] = [
      {
        label: 'Copy',
        onClick: () => flash(() => void copyText(elementText(element))),
      },
    ];
    if (info.tag === 'img') {
      actions.push({
        label: 'Copy alt',
        onClick: () => flash(() => void copyText(element.getAttribute('alt') ?? '')),
      });
    }
    actions.push(ask);
    return actions;
  }

  if (info.tag === 'a') {
    return [
      { label: 'Open', onClick: () => flash(() => clickElement(element)) },
      {
        label: 'Copy link',
        onClick: () => flash(() => void copyText((element as HTMLAnchorElement).href)),
      },
      ask,
    ];
  }

  if (info.tag === 'input' || info.tag === 'textarea' || info.tag === 'select') {
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    return [
      {
        label: 'Fill…',
        onClick: () => spotlight!.showFillBar(element.getBoundingClientRect(), (value) => {
          setValue(field, value);
          flashSuccess(field);
          reShowBar();
        }, () => reShowBar()),
      },
      {
        label: 'Clear',
        onClick: () => flash(() => setValue(field, '')),
      },
      { label: 'Focus', onClick: () => flash(() => focusElement(field)) },
      ask,
    ];
  }

  return [{ label: 'Click', onClick: () => flash(() => clickElement(element)) }, ask];
}

function reShowBar(): void {
  if (!pinned || !spotlight) return;
  const current = table!;
  const info = current.info.get(pinned.id)!;
  spotlight.showActionBar(pinned.element.getBoundingClientRect(), actionsFor(pinned.element, info));
}

function flashSuccess(element: HTMLElement): void {
  const sp = spotlight;
  if (!sp) return;
  const rect = element.getBoundingClientRect();
  sp.highlight(rect, 'success');
  window.setTimeout(() => {
    if (!active) return;
    if (pinned?.element === element) {
      sp.highlight(element.getBoundingClientRect(), 'focus', true);
    } else {
      sp.hideHighlight();
    }
  }, 600);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!active || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  if (pinned) unpin();
  else setActMode(false);
}

function onScroll(): void {
  if (!active || !spotlight || !pinned) return;
  const rect = pinned.element.getBoundingClientRect();
  spotlight.highlight(rect, 'focus', true);
  const current = table!;
  spotlight.setLabel(labelText(current, pinned.id), rect);
  spotlight.showActionBar(rect, actionsFor(pinned.element, current.info.get(pinned.id)!));
}

function elementText(element: HTMLElement): string {
  return (element.innerText ?? element.textContent ?? '').trim();
}

function describeForChat(
  element: HTMLElement,
  info: { id?: number; tag: string; role: string; name?: string },
): string {
  const tableRef = table!;
  const id = info.id ?? tableRef.idFor(element) ?? '?';
  const name = info.name ? ` "${info.name}"` : '';
  const text = elementText(element);
  const quoted = text ? `\n\n"""${text.slice(0, 300)}${text.length > 300 ? '…' : ''}"""` : '';
  return `About [${id}] ${info.role}${name} on this page:${quoted}`;
}
