import type { ActionOp, ScrollTarget } from '@/shared/protocol';

export function parseCommand(raw: string): ActionOp[] | null {
  const text = raw.trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  let match: RegExpMatchArray | null;

  if ((match = lower.match(/^click (\d+)$/))) {
    return [{ op: 'click', target: Number(match[1]) }];
  }

  const typeMatch = text.match(
    /^type\s+("([^"]*)"|'([^']*)'|(\S+))\s+in(to)?\s+(\d+)(\s+and\s+submit)?$/i,
  );
  if (typeMatch) {
    const value = typeMatch[2] ?? typeMatch[3] ?? typeMatch[4] ?? '';
    return [
      { op: 'type', target: Number(typeMatch[6]), text: value, submit: Boolean(typeMatch[7]) },
    ];
  }

  if ((match = lower.match(/^clear (\d+)$/))) {
    return [{ op: 'type', target: Number(match[1]), text: '' }];
  }

  if ((match = lower.match(/^key (\S+) in(to)? (\d+)$/))) {
    return [{ op: 'key', target: Number(match[3]!), key: normalizeKeyName(match[1]!) }];
  }

  if ((match = lower.match(/^extract (\d+)$/))) {
    return [{ op: 'extract', target: Number(match[1]) }];
  }

  if (lower === 'extract all' || lower === 'extract') {
    return [{ op: 'extract' }];
  }

  if ((match = lower.match(/^scroll (top|bottom|up|down)$/))) {
    return [{ op: 'scroll', to: match[1] as ScrollTarget }];
  }

  const navigate = text.match(/^navigate\s+(\S+)$/i);
  if (navigate && navigate[1] && isPlausibleUrl(navigate[1])) {
    return [{ op: 'navigate', url: navigate[1] }];
  }

  return null;
}

function isPlausibleUrl(value: string): boolean {
  return /^(https?:\/\/|[\w-]+(\.[\w-]+)+)/.test(value);
}

function normalizeKeyName(value: string): string {
  const named: Record<string, string> = {
    enter: 'Enter',
    tab: 'Tab',
    esc: 'Escape',
    escape: 'Escape',
    down: 'ArrowDown',
    up: 'ArrowUp',
    left: 'ArrowLeft',
    right: 'ArrowRight',
  };
  return named[value.toLowerCase()] ?? value;
}

export const COMMAND_HELP = [
  'Local commands (anything else goes to the LLM, or starts an agent run when Act is on):',
  '  click <n> — click indexed element',
  '  type "text" into <n> [and submit] — fill a field',
  '  key <Enter|ArrowDown|Escape|…> in <n> — press a key on a field',
  '  clear <n> — empty a field',
  '  extract <n> — read element text into the chat',
  '  extract all — read the page\'s main text into the chat',
  '  scroll top|bottom|up|down',
  '  navigate <url>',
  '  agent log — replay the last agent run for this tab',
  '  debug — toggle per-step timings (also in the service worker console)',
  'Turn on Act mode to see element indexes, pin elements, and run goals.',
].join('\n');
