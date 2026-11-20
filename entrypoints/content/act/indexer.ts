export interface ElementInfo {
  id: number;
  tag: string;
  role: string;
  kind: 'interactive' | 'content';
  name: string;
  href?: string;
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

export class ElementTable {
  readonly info = new Map<number, ElementInfo>();
  readonly elements = new Map<number, Element>();
  private readonly idsByElement = new WeakMap<Element, number>();
  readonly order: number[] = [];
  private nextId = 1;

  add(element: Element, tag: string, kind: 'interactive' | 'content', name: string): number {
    const id = this.nextId++;
    const role = implicitRole(element, tag);
    this.info.set(id, {
      id,
      tag,
      role,
      kind,
      name,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
    });
    this.elements.set(id, element);
    this.idsByElement.set(element, id);
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
    return this.idsByElement.get(element);
  }
}

export function buildElementTable(): ElementTable {
  const table = new ElementTable();
  const body = document.body;
  if (body) visit(table, body);
  return table;
}

function visit(table: ElementTable, element: Element): void {
  const tag = element.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (element.id && HOST_IDS.has(element.id)) return;

  const shadowRoot = (element as HTMLElement).shadowRoot;
  if (shadowRoot) {
    for (const child of Array.from(shadowRoot.children)) visit(table, child);
  }

  const interactive = isInteractive(element, tag);
  const content = CONTENT_TAGS.has(tag);
  if ((interactive || content) && isVisible(element)) {
    const name = accessibleName(element, tag);
    table.add(element, tag, interactive ? 'interactive' : 'content', name);
  }

  for (const child of Array.from(element.children)) visit(table, child);
}

function isInteractive(element: Element, tag: string): boolean {
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (element.hasAttribute('onclick')) return true;
  if (element.getAttribute('role')) {
    const role = element.getAttribute('role')!;
    return ['button', 'link', 'tab', 'checkbox', 'radio', 'menuitem', 'option', 'switch', 'textbox'].includes(
      role,
    );
  }
  if (tag === 'div' || tag === 'span') {
    return element.getAttribute('tabindex') === '0' || (element as HTMLElement).isContentEditable;
  }
  return (element as HTMLElement).isContentEditable;
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

export function serializeTable(table: ElementTable): string {
  const lines: string[] = [];
  for (const id of table.order) {
    const info = table.info.get(id)!;
    const name = info.name ? ` "${info.name}"` : '';
    const href = info.href ? ` -> ${info.href}` : '';
    lines.push(`[${info.id}] ${info.role}${name}${href}`);
  }
  return lines.join('\n');
}
