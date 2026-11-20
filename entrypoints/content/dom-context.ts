import { MAX_HTML_CHARS } from '@/shared/constants';

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
