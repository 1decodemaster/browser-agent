import {
  buildElementTable,
  collapse,
  CONTAINER_SELECTOR,
  ElementTable,
  markDiscovered,
  serializeTable,
  truncate,
  type ElementInfo,
} from './indexer';
import { mountSpotlight, type ActionItem, type Spotlight } from './spotlight';
import {
  BEHAVIORAL_SELECTOR,
  clickElement,
  copyText,
  findClickTarget,
  focusElement,
  isSyntheticClick,
  pressKey,
  readFieldValue,
  setContentEditableValue,
  setValue,
} from './executor';
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
let navigationWatched = false;
let crossDocumentNavStarted = false;
let navigationPending = false;
const changeCallbacks: Array<(active: boolean) => void> = [];

export function mountAct(css: string): void {
  if (document.getElementById(ACT_HOST_ID) != null) return;
  spotlight = mountSpotlight(css);
  loadActUi();
  watchNavigation();
  try {
    window.sessionStorage.removeItem('__ba_confirm');
  } catch {
    /* a pending confirm cannot outlive its document */
  }
  window.addEventListener('pagehide', () => {
    crossDocumentNavStarted = true;
    spotlight?.cancelPendingConfirm();
  });
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
  table = buildElementTable(pinnedTable);
  pinnedTable = table;
  tableDirty = false;
  return { index: serializeTable(table), url: location.href, title: document.title };
}

const HIGH_RISK_PATTERN =
  /delete|remove|pay|purchase|checkout|buy|sign ?out|log ?out|place order|trash|empty|submit|send/i;

export async function executeActions(
  actions: ActionOp[],
  confirmMode: ConfirmMode = 'destructive',
): Promise<ActionObservation[]> {
  if (!spotlight) {
    return actions.map((action) => ({ ok: false, op: action.op, message: 'Spotlight not mounted' }));
  }
  const current = pinnedTable ?? ensureFreshTable();
  const observations: ActionObservation[] = [];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index]!;
    crossDocumentNavStarted = false;
    navigationPending = false;
    const observation = await runAction(action, current, confirmMode);
    observations.push(observation);
    let navigating = action.op === 'navigate' || navigationPending;
    if (
      !navigating &&
      (action.op === 'click' ||
        action.op === 'select' ||
        (action.op === 'type' && action.submit === true))
    ) {
      await abortableDelay(40);
      navigating = crossDocumentNavStarted;
    }
    if (navigating) observation.navigating = true;
    if (navigating && index < actions.length - 1) {
      for (const skipped of actions.slice(index + 1)) {
        observations.push({
          ok: false,
          op: skipped.op,
          target: 'target' in skipped ? skipped.target : undefined,
          message: 'skipped - the page is navigating; observe the new page next',
        });
      }
      break;
    }
  }
  return observations;
}

function watchNavigation(): void {
  if (navigationWatched) return;
  navigationWatched = true;
  interface NavigationLike {
    addEventListener(
      type: 'navigate',
      listener: (event: { hashChange?: boolean; destination?: { sameDocument?: boolean } }) => void,
    ): void;
  }
  const nav = (window as { navigation?: NavigationLike }).navigation;
  if (!nav || typeof nav.addEventListener !== 'function') return;
  nav.addEventListener('navigate', (event) => {
    if (event.hashChange) return;
    if (event.destination?.sameDocument) return;
    crossDocumentNavStarted = true;
  });
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
          const ok = await awaitConfirm(
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
        if (found.href) {
          navigationPending = true;
          window.setTimeout(() => clickElement(found.target), 50);
        } else {
          clickElement(found.target);
          flashSuccess(found.target);
        }
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
        const editable = findEditable(resolved.element);
        if (!editable) {
          return { ...base, ok: false, message: `[${action.target}] is not a text field and holds no input` };
        }
        if (editable instanceof HTMLInputElement) {
          if (editable.disabled) return { ...base, ok: false, message: 'field is disabled' };
          if (editable.readOnly) return { ...base, ok: false, message: 'field is read-only' };
        }
        if (needsConfirm(confirmMode, resolved.info, action.submit === true)) {
          const ok = await awaitConfirm(
            editable.getBoundingClientRect(),
            action.submit
              ? `Fill and submit "${resolved.info.name || resolved.info.role}"?`
              : `Fill "${resolved.info.name || resolved.info.role}"?`,
          );
          if (!ok) return { ...base, ok: false, message: 'cancelled' };
        }
        sp.highlight(editable.getBoundingClientRect(), 'focus', true);
        const readback =
          editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
            ? setValue(editable, action.text)
            : setContentEditableValue(editable, action.text);
        const stuck = readback.trim() !== action.text;
        const submitted = action.submit && !stuck;
        const anchors = submitted ? captureAncestors(editable) : [];
        if (submitted) submitForm(editable);
        if (!stuck) flashSuccess(editable);
        const submitNote = submitted
          ? ` + submit${await describePostSubmit(editable, action.text, anchors)}`
          : '';
        return {
          ...base,
          ok: !stuck,
          message: stuck
            ? `typed but field now reads "${readback.trim().slice(0, 60)}" - value did not stick`
            : `${action.text.length} char(s), field now "${readback.trim().slice(0, 60)}"${submitNote}`,
        };
      }
      case 'key': {
        const resolved = resolve(action.target, current);
        if (!resolved) return { ...base, ok: false, message: `no live element [${action.target}]` };
        sp.highlight(resolved.element.getBoundingClientRect(), 'focus', true);
        pressKey(resolved.element, action.key);
        flashSuccess(resolved.element);
        return { ...base, ok: true, message: `pressed ${action.key}` };
      }
      case 'select': {
        const resolved = resolve(action.target, current);
        if (!resolved) return { ...base, ok: false, message: `no live element [${action.target}]` };
        const select = findSelect(resolved.element);
        if (!select) {
          return {
            ...base,
            ok: false,
            message: `[${action.target}] holds no <select> - use click on dropdown rows, or type into combobox fields`,
          };
        }
        if (select.disabled) return { ...base, ok: false, message: 'select is disabled' };
        const matched = matchOption(select, action.value);
        if (!matched) {
          const options = Array.from(select.options)
            .map((option) => option.text.trim() || option.value)
            .filter(Boolean)
            .slice(0, 20)
            .join(', ');
          return {
            ...base,
            ok: false,
            message: `no option matching "${action.value}" in [${action.target}] - options: ${truncate(options, 200)}`,
          };
        }
        sp.highlight(select.getBoundingClientRect(), 'focus', true);
        selectOption(select, matched);
        flashSuccess(select);
        return {
          ...base,
          ok: true,
          message: `selected "${truncate(matched.text.trim() || matched.value, 60)}"`,
        };
      }
      case 'find': {
        const query = action.text.trim();
        if (query.length < 2) {
          return { ...base, ok: false, message: 'find needs at least 2 characters to search for' };
        }
        const message = findElements(current, query);
        return { ...base, ok: !message.startsWith('no element'), message };
      }
      case 'inspect': {
        const resolved = resolve(action.target, current);
        if (!resolved) return { ...base, ok: false, message: `no live element [${action.target}]` };
        sp.highlight(resolved.element.getBoundingClientRect(), 'success');
        window.setTimeout(() => {
          if (active && pinned?.element === resolved.element) {
            sp.highlight(resolved.element.getBoundingClientRect(), 'focus', true);
          } else {
            sp.hideHighlight();
          }
        }, 600);
        return { ...base, ok: true, message: inspectElement(resolved.element, resolved.info, current) };
      }
      case 'focus': {
        const resolved = resolve(action.target, current);
        if (!resolved) return { ...base, ok: false, message: `no live element [${action.target}]` };
        const editable = findEditable(resolved.element);
        if (editable instanceof HTMLInputElement && editable.disabled) {
          return { ...base, ok: false, message: 'field is disabled' };
        }
        const target = editable ?? resolved.element;
        sp.highlight(target.getBoundingClientRect(), 'focus', true);
        focusElement(target);
        flashSuccess(target);
        const name = resolved.info.name ? ` "${resolved.info.name}"` : '';
        return { ...base, ok: true, message: `focused [${action.target}] ${resolved.info.role}${name}` };
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
        const text = fieldReport(resolved.element) ?? elementText(resolved.element);
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
        const requested = Math.min(Math.max(action.ms, 0), 5000);
        const waited = await abortableDelay(requested);
        const cutShort = waited < requested;
        if (cutShort) navigationPending = true;
        return {
          ...base,
          ok: true,
          message: `${waited}ms${cutShort ? ' (cut short - page is navigating)' : ''}`,
        };
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

// The spotlight root is display:none outside Act mode; a confirmation (agent runs survive
// navigations that turn Act off) must make the overlay visible or the bar is unclickable
// and the run hangs forever on the await.
async function awaitConfirm(rect: DOMRect, text: string): Promise<boolean> {
  const sp = spotlight;
  if (!sp) return false;
  sp.setActive(true);
  try {
    return await sp.confirmBar(rect, text);
  } finally {
    sp.setActive(active);
  }
}

function resolve(
  id: number,
  current: ElementTable,
): { element: HTMLElement; info: ElementInfo } | null {
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
  submit: boolean,
): boolean {
  if (confirmMode === 'never') return false;
  if (confirmMode === 'always') return true;
  return submit || isHighRisk(info.name);
}

function submitForm(element: HTMLElement): void {
  // Enter first: autocomplete/combobox fields commit the selected suggestion
  // from their own keydown handler (and preventDefault). If the field did not
  // handle the key, fall back to submitting the surrounding form.
  const init: KeyboardEventInit = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
  const prevented = !element.dispatchEvent(new KeyboardEvent('keydown', init));
  element.dispatchEvent(new KeyboardEvent('keyup', init));
  if (prevented) return;
  const form = element.closest('form');
  if (form) {
    form.requestSubmit();
  }
}

const POST_SUBMIT_READ_MS = 400;
const POST_SUBMIT_ANCHOR_LEVELS = 4;
const CHIP_SCAN_ELEMENT_LIMIT = 800;

function captureAncestors(element: HTMLElement): HTMLElement[] {
  const anchors: HTMLElement[] = [];
  let node: HTMLElement | null = element.parentElement;
  while (node && node !== document.body && anchors.length < POST_SUBMIT_ANCHOR_LEVELS) {
    anchors.push(node);
    node = node.parentElement;
  }
  return anchors;
}

async function describePostSubmit(
  field: HTMLElement,
  typed: string,
  anchors: HTMLElement[],
): Promise<string> {
  await abortableDelay(POST_SUBMIT_READ_MS);
  try {
    const parts: string[] = [];
    if (!field.isConnected) {
      parts.push('the field is gone (selection committed/replaced)');
    } else {
      const value = readFieldValue(field).trim();
      parts.push(value ? `field now reads "${value.slice(0, 60)}"` : 'field is now empty');
    }
    const chip = nearbyChipText(anchors, field, typed);
    if (chip) parts.push(`nearby text now includes "${chip}"`);
    return parts.length ? ` [post-submit: ${parts.join('; ')}]` : ' [post-submit: no change detected]';
  } catch {
    return '';
  }
}

function nearbyChipText(
  anchors: HTMLElement[],
  field: HTMLElement,
  typed: string,
): string | null {
  const needle = typed.trim().toLowerCase();
  if (!needle) return null;
  for (const anchor of anchors) {
    if (!anchor.isConnected) continue;
    const descendants = anchor.querySelectorAll<HTMLElement>('*');
    if (descendants.length > CHIP_SCAN_ELEMENT_LIMIT) continue;
    for (const candidate of descendants) {
      if (candidate === field || candidate.contains(field)) continue;
      const text = (candidate.textContent ?? '').trim();
      if (!text || text.length > 120) continue;
      if (text.toLowerCase().includes(needle)) return text.slice(0, 80);
    }
  }
  return null;
}

// extract on a form field reports its live value / checked state instead of text content.
function fieldReport(element: HTMLElement): string | null {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return `${element.type} is ${element.checked ? 'checked' : 'unchecked'}`;
    }
    return element.value.trim()
      ? `value = "${element.value.trim().slice(0, 200)}"`
      : 'value is empty';
  }
  if (element instanceof HTMLTextAreaElement) {
    return element.value.trim()
      ? `value = "${element.value.trim().slice(0, 200)}"`
      : 'value is empty';
  }
  if (element instanceof HTMLSelectElement) {
    const selected = element.options[element.selectedIndex]?.text.trim() ?? '';
    const options = Array.from(element.options, (option) => option.text.trim())
      .filter((text) => text)
      .slice(0, 12);
    return `selected "${selected}" (options: ${options.join(', ')})`;
  }
  return null;
}

// --- R3 reasoning ops -------------------------------------------------------

function findSelect(element: HTMLElement): HTMLSelectElement | null {
  if (element instanceof HTMLSelectElement) return element;
  const descendant = element.querySelector<HTMLSelectElement>('select');
  return descendant instanceof HTMLSelectElement ? descendant : null;
}

function matchOption(select: HTMLSelectElement, query: string): HTMLOptionElement | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const options = Array.from(select.options);
  for (const option of options) {
    if (
      option.value.trim().toLowerCase() === q ||
      option.text.trim().toLowerCase() === q
    ) {
      return option;
    }
  }
  for (const option of options) {
    const text = option.text.trim().toLowerCase();
    if (text && (text.includes(q) || q.includes(text))) return option;
  }
  return null;
}

// Native value setter + input/change so framework listeners see the pick (synthetic clicks
// only open the OS dropdown, which nothing on the page can resolve).
function selectOption(select: HTMLSelectElement, option: HTMLOptionElement): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(select, option.value);
  else select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

const FIND_MATCH_CAP = 12;
const FIND_CONTROL_CAP = 4;

// find: match indexed elements by name/state/text first; when nothing indexed matches, look
// for any visible element whose own direct text matches and add it to the table on the fly so
// it gets an id (ids persist into later tables via the indexer's discovered set). Each
// non-interactive hit lists the interactive controls in its nearest container so "find the
// row" immediately yields the checkbox/button to act on.
function findElements(table: ElementTable, query: string): string {
  const q = query.toLowerCase();
  interface Hit {
    id: number;
    info: ElementInfo;
    element: Element;
    text: string;
  }
  const hits: Hit[] = [];
  for (const id of table.order) {
    const hit = table.get(id);
    if (!hit) continue;
    const text = collapse((hit.element as HTMLElement).innerText ?? '');
    const state = hit.info.state ?? '';
    if (
      !hit.info.name.toLowerCase().includes(q) &&
      !state.toLowerCase().includes(q) &&
      !text.toLowerCase().includes(q)
    ) {
      continue;
    }
    hits.push({ id, info: hit.info, element: hit.element, text });
  }
  hits.sort((a, b) => a.text.length - b.text.length);
  const lines: string[] = [];
  for (const hit of hits.slice(0, FIND_MATCH_CAP)) {
    lines.push(describeHit(table, hit.id, hit.info, hit.element, hit.info.kind));
  }
  if (hits.length > FIND_MATCH_CAP) {
    lines.push(`…(${hits.length - FIND_MATCH_CAP} more matches)`);
  }
  if (lines.length) {
    return `found ${Math.min(hits.length, FIND_MATCH_CAP)} of ${hits.length} match(es) for "${truncate(query, 60)}":\n${lines.join('\n')}`;
  }
  const discovered2 = discoverByText(q);
  if (!discovered2.length) {
    return `no element matching "${truncate(query, 60)}" - try different or shorter wording, or scroll and observe again`;
  }
  const discoveredLines: string[] = [];
  for (const hit of discovered2.slice(0, FIND_MATCH_CAP)) {
    markDiscovered(hit.element);
    const id = table.add(
      hit.element,
      hit.tag,
      'content',
      truncate(collapse(hit.ownText), 200),
      true,
      hit.inViewport,
    );
    discoveredLines.push(describeHit(table, id, table.info.get(id)!, hit.element, 'content'));
  }
  return `no indexed match; found ${discoveredLines.length} element(s) by their own text for "${truncate(query, 60)}" (added to the index):\n${discoveredLines.join('\n')}`;
}

function describeHit(
  table: ElementTable,
  id: number,
  info: ElementInfo,
  element: Element,
  kind: string,
): string {
  const line =
    `[${id}] ${info.role}${info.name ? ` "${truncate(info.name, 120)}"` : ''}` +
    `${info.state ? ` ${info.state}` : ''}` +
    `${element instanceof HTMLAnchorElement && element.href ? ` -> ${element.href}` : ''}`;
  if (kind === 'interactive') return line;
  const controls = nearbyControls(table, element);
  return controls.length ? `${line} -> controls: ${controls.join(', ')}` : line;
}

function nearbyControls(table: ElementTable, element: Element): string[] {
  let scope: Element | null =
    element.querySelector(BEHAVIORAL_SELECTOR) ? element : element.closest(CONTAINER_SELECTOR);
  if (!scope || scope === document.body) scope = element.parentElement;
  if (!scope) return [];
  const controls: string[] = [];
  for (const control of Array.from(scope.querySelectorAll<HTMLElement>(BEHAVIORAL_SELECTOR))) {
    if (control === element || controls.length >= FIND_CONTROL_CAP) break;
    const rect = control.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const id = table.idFor(control);
    if (id == null) continue;
    const info = table.info.get(id)!;
    controls.push(
      `[${id}] ${info.role}${info.name ? ` "${truncate(info.name, 60)}"` : ''}${info.state ? ` ${info.state}` : ''}`,
    );
  }
  return controls;
}

interface DiscoveredHit {
  element: Element;
  tag: string;
  ownText: string;
  inViewport: boolean;
}

// Pass 2 of find: elements the indexer skips (plain divs/spans with no behavior) that carry
// the query in their own direct text nodes.
function discoverByText(q: string): DiscoveredHit[] {
  const hits: DiscoveredHit[] = [];
  for (const element of document.body.querySelectorAll('*')) {
    if (hits.length >= FIND_MATCH_CAP * 2) break;
    const tag = element.tagName.toLowerCase();
    if (SKIP_DISCOVERY_TAGS.has(tag)) continue;
    if (element.id && isOwnHost(element)) continue;
    let ownText = '';
    for (const node of element.childNodes) {
      if (node.nodeType === 3) ownText += `${node.textContent ?? ''} `;
    }
    ownText = collapse(ownText);
    if (!ownText || !ownText.toLowerCase().includes(q)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    hits.push({
      element,
      tag,
      ownText,
      inViewport:
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0,
    });
  }
  hits.sort((a, b) => a.ownText.length - b.ownText.length);
  return hits;
}

const SKIP_DISCOVERY_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'head',
  'meta',
  'link',
  'title',
  'label',
  'option',
  'select',
  'input',
  'textarea',
  'button',
  'a',
]);

// inspect: everything the index line compresses away - own text, ordinal position, the text
// right before/after, ancestor context, and the controls sharing the container.
function inspectElement(
  element: HTMLElement,
  info: ElementInfo,
  table: ElementTable,
): string {
  const parts: string[] = [
    `[${info.id}] ${info.role}${info.name ? ` "${info.name}"` : ''}${info.state ? ` ${info.state}` : ''}`,
  ];
  const reported = fieldReport(element);
  const own = collapse(reported ?? (element.innerText ?? ''));
  if (own) parts.push(`text: ${truncate(own, 300)}`);
  const parent = element.parentElement;
  if (parent) {
    const sameKind = Array.from(parent.children).filter(
      (child) => child.tagName === element.tagName,
    );
    const position = sameKind.indexOf(element) + 1;
    if (sameKind.length > 1) {
      parts.push(
        `position: ${position} of ${sameKind.length} ${element.tagName.toLowerCase()} inside ${parent.tagName.toLowerCase()}`,
      );
    }
  }
  const before = collapse((element.previousElementSibling as HTMLElement | null)?.innerText ?? '');
  if (before) parts.push(`before: "${truncate(before, 80)}"`);
  const after = collapse((element.nextElementSibling as HTMLElement | null)?.innerText ?? '');
  if (after) parts.push(`after: "${truncate(after, 80)}"`);
  const ancestors: string[] = [];
  let node: HTMLElement | null = element.parentElement;
  while (node && node !== document.body && ancestors.length < 2) {
    const text = collapse(node.innerText ?? '');
    if (text) ancestors.push(`"${truncate(text, 120)}"`);
    node = node.parentElement;
  }
  if (ancestors.length) parts.push(`inside: ${ancestors.join(' > ')}`);
  const container = element.closest(CONTAINER_SELECTOR) ?? parent;
  if (container && container !== element) {
    const controls: string[] = [];
    for (const control of Array.from(container.querySelectorAll<HTMLElement>(BEHAVIORAL_SELECTOR))) {
      if (control === element || controls.length >= FIND_CONTROL_CAP + 2) break;
      const rect = control.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const id = table.idFor(control);
      if (id == null) continue;
      const controlInfo = table.info.get(id)!;
      controls.push(
        `[${id}] ${controlInfo.role}${controlInfo.name ? ` "${truncate(controlInfo.name, 60)}"` : ''}`,
      );
    }
    if (controls.length) parts.push(`controls here: ${controls.join(', ')}`);
  }
  return parts.join('\n');
}

function findEditable(
  element: HTMLElement,
): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable
  ) {
    return element;
  }
  return element.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
    'input, textarea, [contenteditable="true"]',
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

async function abortableDelay(ms: number): Promise<number> {
  const step = 50;
  let waited = 0;
  while (waited < ms) {
    if (crossDocumentNavStarted) break;
    const slice = Math.min(step, ms - waited);
    await delay(slice);
    waited += slice;
  }
  return waited;
}

function refreshTable(): void {
  table = buildElementTable(table);
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
  if (isSyntheticClick()) return;
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

export function extractMainText(): string {
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
