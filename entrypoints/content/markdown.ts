import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function renderMarkdown(text: string): string {
  if (!text) return '';
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
  });
}
