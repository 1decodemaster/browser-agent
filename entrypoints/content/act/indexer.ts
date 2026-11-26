export interface ElementInfo {
  id: number;
  tag: string;
  role: string;
  kind: 'interactive' | 'content';
  name: string;
  state?: string;
  href?: string;
  fresh?: boolean;
  inViewport?: boolean;
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'textarea', 'select', 'summary', 'label']);
const CONTENT_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'blockquote',
  'figcaption',
  'dt',
  'dd',
  'img',
  'pre',
  'code',
]);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe']);
const HOST_IDS = new Set(['browser-agent-root', 'browser-agent-act-root']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// Ids are persistent across observations while an element lives: the same node keeps the same
// id in every table, so ids in the narration and in find results stay meaningful to the model.
const persistentIds = new WeakMap<Element, number>();
let idCounter = 1;

export class ElementTable {
  readonly info = new Map<number, ElementInfo>();
  readonly elements = new Map<number, Element>();
  private readonly members = new WeakMap<Element, number>();
  readonly order: number[] = [];

  add(
    element: Element,
    tag: string,
    kind: 'interactive' | 'content',
    name: string,
    fresh = false,
    inViewport = false,
  ): number {
    let id = persistentIds.get(element);
    if (id === undefined) {
      id = idCounter++;
      persistentIds.set(element, id);
    }
    const role = implicitRole(element, tag);
    const state = elementState(element);
    this.info.set(id, {
      id,
      tag,
      role,
      kind,
      name,
      ...(state ? { state } : {}),
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      ...(fresh ? { fresh: true } : {}),
      ...(inViewport ? { inViewport: true } : {}),
    });
    this.elements.set(id, element);
    this.members.set(element, id);
    this.order.push(id);
    return id;
  }

  get(id: number): { info: ElementInfo; element: Element } | undefined {
    const element = this.elements.get(id);
    const meta = this.info.get(id);
    if (!element || !meta) return undefined;
    return { info: meta, element };
  }

  idFor(element: Element): number | undefined {
    return this.members.get(element);
  }
}

export function buildElementTable(previous?: ElementTable | null): ElementTable {
  const table = new ElementTable();
  const body = document.body;
  if (body) visit(table, body, previous, new Map());
  return table;
}

function visit(
  table: ElementTable,
  element: Element,
  previous: ElementTable | null | undefined,
  cursorCache: Map<Element, string>,
): void {
  const tag = element.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (element.id && HOST_IDS.has(element.id)) return;

  const shadowRoot = (element as HTMLElement).shadowRoot;
  if (shadowRoot) {
    for (const child of Array.from(shadowRoot.children)) visit(table, child, previous, cursorCache);
  }

  const interactive = isInteractive(element, tag, cursorCache);
  const content = CONTENT_TAGS.has(tag);
  if (interactive || content) {
    const rect = element.getBoundingClientRect();
    if (rect.width >= 2 && rect.height >= 2) {
      const name = accessibleName(element, tag) || (interactive ? contextualName(element) : '');
      const prevId = previous?.idFor(element);
      const isFresh =
        previous != null && (prevId === undefined || previous.info.get(prevId)?.fresh === true);
      const inViewport =
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0;
      table.add(element, tag, interactive ? 'interactive' : 'content', name, isFresh, inViewport);
    }
  }

  for (const child of Array.from(element.children)) visit(table, child, previous, cursorCache);
}

const INTERACTIVE_ROLES = [
  'button',
  'link',
  'tab',
  'checkbox',
  'radio',
  'menuitem',
  'option',
  'switch',
  'textbox',
  'searchbox',
  'combobox',
];
const WIDGET_HOST_TAGS = new Set(['div', 'span', 'li', 'td', 'th']);

function isInteractive(
  element: Element,
  tag: string,
  cursorCache: Map<Element, string>,
): boolean {
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (element.hasAttribute('onclick')) return true;
  const role = element.getAttribute('role');
  if (role && INTERACTIVE_ROLES.includes(role)) return true;
  if (WIDGET_HOST_TAGS.has(tag)) {
    const htmlElement = element as HTMLElement;
    if (htmlElement.isContentEditable || element.getAttribute('tabindex') === '0') return true;
    // cursor:pointer counts only where the pointer *starts*: a pointer inherited from an
    // ancestor that already shows it belongs to that ancestor's clickability, so children of
    // a clickable row no longer eat the interactive budget one element each.
    if (
      (element.textContent ?? '').length <= 400 &&
      pointerStartsHere(htmlElement, cursorCache)
    ) {
      return true;
    }
  }
  return false;
}

function cursorOf(element: Element, cache: Map<Element, string>): string {
  let cursor = cache.get(element);
  if (cursor === undefined) {
    cursor = getComputedStyle(element).cursor;
    cache.set(element, cursor);
  }
  return cursor;
}

function hostOf(element: Element): HTMLElement | null {
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
}

function pointerStartsHere(element: Element, cache: Map<Element, string>): boolean {
  if (cursorOf(element, cache) !== 'pointer') return false;
  let node: HTMLElement | null = element.parentElement ?? hostOf(element);
  while (node && node !== document.body && node !== document.documentElement) {
    if (cursorOf(node, cache) === 'pointer') return false;
    node = node.parentElement ?? hostOf(node);
  }
  return true;
}

function implicitRole(element: Element, tag: string): string {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;
  if (HEADING_TAGS.has(tag)) return 'heading';
  switch (tag) {
    case 'a':
      return element.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'input': {
      const type = (element as HTMLInputElement).type;
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    case 'textarea':
      return 'textbox';
    case 'select':
      return 'combobox';
    case 'summary':
      return 'button';
    case 'img':
      return 'image';
    case 'p':
      return 'paragraph';
    case 'li':
      return 'listitem';
    default:
      return tag;
  }
}

// Live widget state rendered after the name on the index line (ADR 0.3.0: the model cannot act
// on a dependent field it cannot see): value, checked, disabled, expanded, select options.
function elementState(element: Element): string {
  const parts: string[] = [];
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      if (element.checked) parts.push('[checked]');
    } else if (element.value.trim()) {
      parts.push(`= "${truncate(collapse(element.value), 60)}"`);
    }
  } else if (element instanceof HTMLTextAreaElement) {
    if (element.value.trim()) parts.push(`= "${truncate(collapse(element.value), 60)}"`);
  } else if (element instanceof HTMLSelectElement) {
    const selected = element.options[element.selectedIndex]?.text?.trim();
    if (selected) parts.push(`= "${truncate(collapse(selected), 60)}"`);
    const labels = Array.from(element.options)
      .map((option) => collapse(option.text))
      .filter((text) => text.length > 0);
    if (labels.length > 1) {
      const extra = labels.length - Math.min(labels.length, 12);
      parts.push(`opts: ${truncate(labels.slice(0, 12).join(', '), 120)}${extra > 0 ? ` (+${extra} more)` : ''}`);
    }
  }
  if (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement) &&
    element.disabled
  ) {
    parts.push('[disabled]');
  }
  if (element.getAttribute('aria-expanded') === 'true') parts.push('[expanded]');
  return parts.join(' ');
}

// Screen-reader name order (R2): aria-label -> alt -> placeholder -> label[for] ->
// wrapping label (minus the control's own text) -> title -> aria-labelledby -> innerText.
// Value is deliberately NOT a name source: identity != state, the value rides on the line
// as `= "..."` instead.
function accessibleName(element: Element, tag: string): string {
  const ariaLabel = element.getAttribute('aria-label')?.trim();
  if (ariaLabel) return truncate(ariaLabel, 120);

  const alt = element.getAttribute('alt')?.trim();
  if (alt) return truncate(alt, 120);

  if ((tag === 'input' || tag === 'textarea') && 'placeholder' in element) {
    const placeholder = element.getAttribute('placeholder')?.trim();
    if (placeholder) return truncate(placeholder, 120);
  }

  const forLabel = labelForText(element);
  if (forLabel) return truncate(forLabel, 120);

  const wrapping = wrappingLabelText(element);
  if (wrapping) return truncate(wrapping, 120);

  const title = element.getAttribute('title')?.trim();
  if (title) return truncate(title, 120);

  const labelledBy = labelledByText(element);
  if (labelledBy) return truncate(labelledBy, 160);

  const text = (element as HTMLElement).innerText?.trim().replace(/\s+/g, ' ');
  if (text) return truncate(text, 160);

  return '';
}

function labelForText(element: Element): string {
  if (!element.id) return '';
  const root = element.getRootNode() as Document | ShadowRoot;
  const labels = root.querySelectorAll(`label[for="${CSS.escape(element.id)}"]`);
  for (const label of Array.from(labels)) {
    const text = minusOwnText(element, (label as HTMLElement).innerText ?? label.textContent ?? '');
    if (text) return text;
  }
  return '';
}

function wrappingLabelText(element: Element): string {
  const label = element.closest('label');
  if (!label || label === element) return '';
  return minusOwnText(element, (label as HTMLElement).innerText ?? label.textContent ?? '');
}

function labelledByText(element: Element): string {
  const ids = element.getAttribute('aria-labelledby')?.trim();
  if (!ids) return '';
  const root = element.getRootNode() as Document | ShadowRoot;
  const parts: string[] = [];
  for (const id of ids.split(/\s+/)) {
    const reference = root.getElementById(id);
    const text = reference
      ? collapse((reference as HTMLElement).innerText ?? reference.textContent ?? '')
      : '';
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

function minusOwnText(control: Element, text: string): string {
  let out = collapse(text);
  const own = collapse((control as HTMLElement).innerText ?? '');
  if (own && out.includes(own)) out = collapse(out.replace(own, ' '));
  return out;
}

// Still-unnamed controls borrow their surroundings: the nearest row/cell-ish container's
// text (<=200 chars), prefixed by the short text neighbour directly before the control when
// that neighbour adds position ("$150 (Economy window seat ...)").
const CONTEXT_CONTAINER_SELECTOR =
  'tr, li, td, th, dt, dd, p, fieldset, figure, [role="row"], [role="listitem"], ' +
  '[role="cell"], [role="gridcell"], [role="option"], [role="menuitem"], [role="group"]';

function contextualName(element: Element): string {
  const container = element.closest(CONTEXT_CONTAINER_SELECTOR);
  let base = '';
  if (container && container !== element && container !== document.body) {
    base = minusOwnText(element, container.textContent ?? '');
  }
  const neighbor = precedingShortText(element);
  if (!base) return truncate(neighbor, 200);
  if (neighbor && neighbor !== base && base.toLowerCase().includes(neighbor.toLowerCase())) {
    const rest = collapse(base.replace(new RegExp(escapeRegExp(neighbor), 'i'), ' '));
    return truncate(rest ? `${neighbor} (${rest})` : neighbor, 200);
  }
  return truncate(base, 200);
}

function precedingShortText(element: Element): string {
  let node = element.previousSibling;
  while (node) {
    const text =
      node.nodeType === 3
        ? collapse(node.textContent ?? '')
        : node.nodeType === 1
          ? collapse((node as HTMLElement).innerText ?? node.textContent ?? '')
          : '';
    if (text) return text.length <= 60 ? text : '';
    node = node.previousSibling;
  }
  return '';
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function serializeTable(table: ElementTable, maxEntries = 320): string {
  const interactiveBudget = 150;
  const freshBudget = 60;
  const fresh: string[] = [];
  const interactive: string[] = [];
  const interactiveOffscreen: string[] = [];
  const content: string[] = [];
  const contentOffscreen: string[] = [];
  for (const id of table.order) {
    const info = table.info.get(id)!;
    if (!info.name.trim() || info.tag === 'label') continue;
    const line =
      `[${info.id}] ${info.role} "${info.name}"` +
      `${info.state ? ` ${info.state}` : ''}` +
      `${info.href ? ` -> ${info.href}` : ''}`;
    if (info.kind === 'interactive') {
      if (info.fresh) fresh.push(line);
      else if (info.inViewport) interactive.push(line);
      else interactiveOffscreen.push(line);
    } else if (info.inViewport) {
      content.push(line);
    } else {
      contentOffscreen.push(line);
    }
  }
  const freshShown = fresh.slice(0, freshBudget);
  const interactiveShown = [...interactive, ...interactiveOffscreen].slice(0, interactiveBudget);
  const picked: string[] = [...interactiveShown];
  const cap = maxEntries + freshShown.length;
  if (freshShown.length) {
    picked.unshift(
      'Recently appeared (dropdown/popover options you just opened are listed here - click a matching row):',
      ...freshShown,
    );
  }
  for (const line of [...content, ...contentOffscreen]) {
    if (picked.length >= cap) break;
    picked.push(line);
  }
  const total =
    fresh.length +
    interactive.length +
    interactiveOffscreen.length +
    content.length +
    contentOffscreen.length;
  if (total > picked.length) {
    picked.push(
      `…(${total - picked.length} more elements not shown - scroll the page to reveal them, or extract with no target to read the whole page text)`,
    );
  }
  return picked.join('\n');
}
