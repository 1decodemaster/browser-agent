import { buildElementTable, ElementTable, serializeTable } from './indexer';
import { mountSpotlight, type ActionItem, type Spotlight } from './spotlight';
import { clickElement, copyText, findClickTarget, focusElement, setValue } from './executor';
import type { ActionObservation, ActionOp, ConfirmMode, ScrollTarget } from '@/shared/protocol';

const ACT_HOST_ID = 'browser-agent-act-root';
const PANEL_HOST_ID = 'browser-agent-root';
const ACT_UI_KEY = '__ba_act';

let spotlight: Spotlight | null = null;
let active = false;
let askFirst = false;
let pinnedTable: ElementTable | null = null;
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
  loadActUi();
}

export function isAskFirst(): boolean {
  return askFirst;
}

export function setAskFirst(value: boolean): void {
  askFirst = value;
  persistActUi();
  updateBanner();
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
    updateBanner();
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

export function observePage(): { index: string; url: string; title: string } {
  table = buildElementTable();
  pinnedTable = table;
  tableDirty = false;
  return { index: serializeTable(table), url: location.href, title: document.title };
}

const HIGH_RISK_PATTERN =
  /delete|remove|pay|purchase|checkout|buy|sign ?out|log ?out|place order|trash|empty/i;

export async function executeActions(
  actions: ActionOp[],
  confirmMode: ConfirmMode = 'destructive',
): Promise<ActionObservation[]> {
  const observations: ActionObservation[] = [];
  if (!spotlight) {
    return actions.map((action) => ({ ok: false, op: action.op, message: 'Spotlight not mounted' }));
  }
  const current = pinnedTable ?? ensureFreshTable();
  for (const action of actions) {
    observations.push(await runAction(action, current, confirmMode));
  }
  return observations;
}

async function runAction(
  action: ActionOp,
  current: ElementTable,
  confirmMode: ConfirmMode,
): Promise<ActionObservation> {
  const sp = spotlight;
  if (!sp) return { ok: false, op: action.op, message: 'Spotlight not mounted' };
  const base: Omit<ActionObservation, 'ok'> = {
    op: action.op,
    target: 'target' in action ? action.target : undefined,
  };
  try {
    switch (action.op) {
      case 'click': {
        const resolved = resolve(action.target, current);
        if (!resolved) return { ...base, ok: false, message: `no live element [${action.target}]` };
        if (needsConfirm(confirmMode, resolved.info, false)) {
          const ok = await sp.confirmBar(
            resolved.element.getBoundingClientRect(),
            `Click "${resolved.info.name || resolved.info.role}"?`,
          );
          if (!ok) return { ...base, ok: false, message: 'cancelled' };
        }
        const found = findClickTarget(resolved.element);
        if (!found.behavioral) {
          return {
            ...base,
            ok: false,
            message: `[${action.target}] is a ${resolved.info.role}, not clickable - click a link/button inside it, or extract it instead`,
          };
        }
        sp.highlight(resolved.element.getBoundingClientRect(), 'focus', true);
        clickElement(found.target);
        flashSuccess(found.target);
        let message: string;
        if (found.href) {
          message = `link -> ${found.href}`;
        } else {
          const name = (found.target.innerText ?? '').trim().slice(0, 60);
          message = `${found.target.tagName.toLowerCase()}${name ? ` "${name}"` : ''}`;
        }
        if (found.target !== resolved.element) {
          message += ` (drilled from [${action.target}] ${resolved.info.role})`;
        }
        return { ...base, ok: true, message };
      }
      case 'type': {
        const resolved = resolve(action.target, current);
        if (!resolved) return { ...base, ok: false, message: `no live element [${action.target}]` };
        let field: HTMLInputElement | HTMLTextAreaElement;
        if (
          resolved.element instanceof HTMLInputElement ||
          resolved.element instanceof HTMLTextAreaElement
        ) {
          field = resolved.element;
        } else {
          const nested = resolved.element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            'input, textarea',
          );
          if (!nested) {
            return { ...base, ok: false, message: `[${action.target}] is not a text field and holds no input` };
          }
          field = nested;
        }
        if (needsConfirm(confirmMode, resolved.info, action.submit === true)) {
          const ok = await sp.confirmBar(
            field.getBoundingClientRect(),
            action.submit
              ? `Fill and submit "${resolved.info.name || resolved.info.role}"?`
              : `Fill "${resolved.info.name || resolved.info.role}"?`,
          );
          if (!ok) return { ...base, ok: false, message: 'cancelled' };
        }
        sp.highlight(field.getBoundingClientRect(), 'focus', true);
        setValue(field, action.text);
        if (action.submit) submitForm(field);
        flashSuccess(field);
        return {
          ...base,
          ok: true,
          message: `${action.text.length} char(s)${action.submit ? ' + submit' : ''}`,
        };
      }
      case 'scroll': {
        if ('to' in action) {
          scrollToTarget(action.to);
        } else {
          const resolved = resolve(action.target, current);
          if (!resolved) return { ...base, ok: false, message: `no live element [${action.target}]` };
          resolved.element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        }
        return { ...base, ok: true };
      }
      case 'extract': {
        if (action.target == null) {
          const text = extractMainText();
          return { ...base, ok: true, message: text };
        }
        const resolved = resolve(action.target, current);
        if (!resolved) return { ...base, ok: false, message: `no live element [${action.target}]` };
        const text = elementText(resolved.element);
        sp.highlight(resolved.element.getBoundingClientRect(), 'success');
        window.setTimeout(() => {
          if (active && pinned?.element === resolved.element) {
            sp.highlight(resolved.element.getBoundingClientRect(), 'focus', true);
          } else {
            sp.hideHighlight();
          }
        }, 600);
        return { ...base, ok: true, message: text || '(empty)' };
      }
      case 'navigate': {
        window.setTimeout(() => {
          window.location.href = action.url;
        }, 50);
        return { ...base, ok: true, message: action.url };
      }
      case 'wait': {
        await delay(Math.min(Math.max(action.ms, 0), 5000));
        return { ...base, ok: true, message: `${Math.min(action.ms, 5000)}ms` };
      }
      case 'done': {
        return { ...base, ok: true, message: action.summary };
      }
      default: {
        const unreachable: never = action;
        void unreachable;
        return { ok: false, op: 'unknown', message: 'unknown op' };
      }
    }
  } catch (error) {
    return { ...base, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function resolve(
  id: number,
  current: ElementTable,
): { element: HTMLElement; info: { tag: string; role: string; kind: string; name: string } } | null {
  const hit = current.get(id);
  if (!hit) return null;
  if (!(hit.element instanceof HTMLElement) || !hit.element.isConnected) return null;
  return { element: hit.element, info: hit.info };
}

function isHighRisk(name: string): boolean {
  return HIGH_RISK_PATTERN.test(name);
}

function needsConfirm(
  confirmMode: ConfirmMode,
  info: { name: string; role: string },
  _submit: boolean,
): boolean {
  if (confirmMode === 'never') return false;
  if (confirmMode === 'always') return true;
  return isHighRisk(info.name);
}

function submitForm(field: HTMLInputElement | HTMLTextAreaElement): void {
  if (field.form) {
    field.form.requestSubmit();
    return;
  }
  field.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
  );
}

function scrollToTarget(to: ScrollTarget): void {
  if (to === 'top') {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  } else if (to === 'bottom') {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' as ScrollBehavior });
  } else if (to === 'up') {
    window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'instant' as ScrollBehavior });
  } else {
    window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'instant' as ScrollBehavior });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, ms));
}

function refreshTable(): void {
  table = buildElementTable();
  tableDirty = false;
}

function updateBanner(): void {
  if (!spotlight || !active) return;
  spotlight.setBanner(
    `Act — click to pin · Esc to exit · Ask first: ${askFirst ? 'ON' : 'OFF'}`,
    () => setAskFirst(!askFirst),
  );
}

function persistActUi(): void {
  try {
    window.sessionStorage.setItem(ACT_UI_KEY, JSON.stringify({ askFirst }));
  } catch {
    return;
  }
}

function loadActUi(): void {
  try {
    const raw = window.sessionStorage.getItem(ACT_UI_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { askFirst?: unknown };
    askFirst = parsed.askFirst === true;
  } catch {
    return;
  }
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

function extractMainText(): string {
  const selectors = ['main', 'article', '[role="main"]', '#content', '#mw-content-text'];
  let best: HTMLElement | null = null;
  let bestLength = 0;
  for (const selector of selectors) {
    for (const candidate of document.querySelectorAll<HTMLElement>(selector)) {
      const length = candidate.innerText?.length ?? 0;
      if (length > bestLength) {
        best = candidate;
        bestLength = length;
      }
    }
  }
  const source = best ?? document.body;
  let text = (source?.innerText ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > 8000) text = `${text.slice(0, 8000)}\n…(truncated)`;
  return text;
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
