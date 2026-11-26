import { hasPointerCursor } from './executor';

export interface ElementInfo {
  id: number;
  tag: string;
  role: string;
  kind: 'interactive' | 'content';
  name: string;
  href?: string;
  fresh?: boolean;
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
  ): number {
    let id = persistentIds.get(element);
    if (id === undefined) {
      id = idCounter++;
      persistentIds.set(element, id);
    }
    const role = implicitRole(element, tag);
    this.info.set(id, {
      id,
      tag,
      role,
      kind,
      name,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      ...(fresh ? { fresh: true } : {}),
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
  if (body) visit(table, body, previous);
  return table;
}

function visit(
  table: ElementTable,
  element: Element,
  previous: ElementTable | null | undefined,
): void {
  const tag = element.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (element.id && HOST_IDS.has(element.id)) return;

  const shadowRoot = (element as HTMLElement).shadowRoot;
  if (shadowRoot) {
    for (const child of Array.from(shadowRoot.children)) visit(table, child, previous);
  }

  const interactive = isInteractive(element, tag);
  const content = CONTENT_TAGS.has(tag);
  if ((interactive || content) && isVisible(element)) {
    const name = accessibleName(element, tag);
    const prevId = previous?.idFor(element);
    const isFresh =
      previous != null && (prevId === undefined || previous.info.get(prevId)?.fresh === true);
    table.add(element, tag, interactive ? 'interactive' : 'content', name, isFresh);
  }

  for (const child of Array.from(element.children)) visit(table, child, previous);
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

function isInteractive(element: Element, tag: string): boolean {
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (element.hasAttribute('onclick')) return true;
  const role = element.getAttribute('role');
  if (role && INTERACTIVE_ROLES.includes(role)) return true;
  if (WIDGET_HOST_TAGS.has(tag) || tag === 'a') {
    const htmlElement = element as HTMLElement;
    if (htmlElement.isContentEditable || element.getAttribute('tabindex') === '0') return true;
    if ((element.textContent ?? '').length <= 400 && hasPointerCursor(htmlElement)) return true;
  }
  return false;
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width >= 2 && rect.height >= 2;
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

function accessibleName(element: Element, tag: string): string {
  const ariaLabel = element.getAttribute('aria-label')?.trim();
  if (ariaLabel) return truncate(ariaLabel, 120);

  if (tag === 'img') {
    const alt = element.getAttribute('alt')?.trim();
    if (alt) return truncate(alt, 120);
  }

  if (tag === 'input' || tag === 'textarea') {
    const input = element as HTMLInputElement;
    const placeholder = input.getAttribute('placeholder')?.trim();
    if (placeholder) return truncate(placeholder, 120);
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return truncate((label as HTMLElement).innerText, 120);
    }
    if (input.value) return truncate(input.value, 120);
  }

  const text = (element as HTMLElement).innerText?.trim().replace(/\s+/g, ' ');
  if (text) return truncate(text, 160);

  const title = element.getAttribute('title')?.trim();
  if (title) return truncate(title, 120);

  return '';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function serializeTable(table: ElementTable, maxEntries = 280): string {
  const interactiveBudget = 120;
  const freshBudget = 60;
  const freshInteractive: string[] = [];
  const interactive: string[] = [];
  const content: string[] = [];
  for (const id of table.order) {
    const info = table.info.get(id)!;
    if (!info.name.trim() || info.tag === 'label') continue;
    const name = ` "${info.name}"`;
    const href = info.href ? ` -> ${info.href}` : '';
    const line = `[${info.id}] ${info.role}${name}${href}`;
    if (info.kind === 'interactive') {
      (info.fresh ? freshInteractive : interactive).push(line);
    } else {
      content.push(line);
    }
  }
  const freshShown = freshInteractive.slice(0, freshBudget);
  const picked: string[] = [...interactive.slice(0, interactiveBudget)];
  const cap = maxEntries + freshShown.length;
  if (freshShown.length) {
    picked.unshift(
      'Recently appeared (dropdown/popover options you just opened are listed here - click a matching row):',
      ...freshShown,
    );
  }
  for (const line of content) {
    if (picked.length >= cap) break;
    picked.push(line);
  }
  const total = freshInteractive.length + interactive.length + content.length;
  if (total > picked.length) {
    picked.push(
      `…(${total - picked.length} more elements not shown - scroll or refine the page to reveal them)`,
    );
  }
  return picked.join('\n');
}
