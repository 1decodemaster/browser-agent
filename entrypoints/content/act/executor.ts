const BEHAVIORAL_SELECTOR =
  'a[href], button, input[type="submit"], input[type="button"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]';

function isBehavioral(element: HTMLElement): boolean {
  return element.matches(BEHAVIORAL_SELECTOR);
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
  return { target: element, behavioral: false };
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

export function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
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
