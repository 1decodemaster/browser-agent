import { MAX_HTML_CHARS } from '@/shared/constants';
import { buildElementTable, serializeTable } from './act/indexer';
import { extractMainText } from './act/act';

const SKIP_SELECTORS =
  'script,style,noscript,svg,iframe,canvas,template,link,#browser-agent-root';

export function collectPageHtml(): string {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll(SKIP_SELECTORS).forEach((element) => element.remove());
  body.querySelectorAll('[style]').forEach((element) => element.removeAttribute('style'));
  const html = body.innerHTML
    .replace(/>\s+</g, '><')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (html.length <= MAX_HTML_CHARS) return html;
  return `${html.slice(0, MAX_HTML_CHARS)}<!-- truncated -->`;
}

const MIN_CONTEXT_CHARS = 600;

export function collectPageContext(): string {
  const outline = serializeTable(buildElementTable());
  const mainText = extractMainText();
  const parts: string[] = [];
  if (outline.trim()) parts.push(`[elements]\n${outline}`);
  if (mainText.trim()) parts.push(`[main text]\n${mainText}`);
  const context = parts.join('\n\n');
  if (context.trim().length >= MIN_CONTEXT_CHARS) return context;
  return collectPageHtml();
}
