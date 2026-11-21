const BEHAVIORAL_SELECTOR =
  'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="searchbox"], [role="combobox"], [onclick]';

function isBehavioral(element: HTMLElement): boolean {
  return element.matches(BEHAVIORAL_SELECTOR);
}

export function hasPointerCursor(element: HTMLElement): boolean {
  return getComputedStyle(element).cursor === 'pointer';
}

function anchorHref(element: HTMLElement): string | undefined {
  return element instanceof HTMLAnchorElement && element.href ? element.href : undefined;
}

export interface ClickTarget {
  target: HTMLElement;
  behavioral: boolean;
  href?: string;
}

export function findClickTarget(element: HTMLElement): ClickTarget {
  if (isBehavioral(element)) {
    return { target: element, behavioral: true, href: anchorHref(element) };
  }
  const descendants = element.querySelectorAll<HTMLElement>(BEHAVIORAL_SELECTOR);
  for (const candidate of descendants) {
    const rect = candidate.getBoundingClientRect();
    if (rect.width >= 2 && rect.height >= 2) {
      return { target: candidate, behavioral: true, href: anchorHref(candidate) };
    }
  }
  let ancestor: HTMLElement | null = element.parentElement;
  while (ancestor && ancestor !== document.body) {
    if (isBehavioral(ancestor)) {
      return { target: ancestor, behavioral: true, href: anchorHref(ancestor) };
    }
    ancestor = ancestor.parentElement;
  }
  if (hasPointerCursor(element)) {
    return { target: element, behavioral: true, href: anchorHref(element) };
  }
  return { target: element, behavioral: false };
}

export function readFieldValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  if (element.isContentEditable) {
    return (element.textContent ?? '').trim();
  }
  return '';
}

export function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): string {
  const proto =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return element.value;
}

export function setContentEditableValue(element: HTMLElement, value: string): string {
  element.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand('insertText', false, value);
  return (element.textContent ?? '').trim();
}

export function pressKey(element: HTMLElement, key: string): void {
  element.focus();
  const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true };
  element.dispatchEvent(new KeyboardEvent('keydown', init));
  element.dispatchEvent(new KeyboardEvent('keyup', init));
}

let syntheticClickDepth = 0;

export function isSyntheticClick(): boolean {
  return syntheticClickDepth > 0;
}

export function clickElement(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  syntheticClickDepth++;
  try {
    element.click();
  } finally {
    syntheticClickDepth--;
  }
}

export function focusElement(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  element.focus();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return execCommandCopy(text);
  }
}

function execCommandCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}
