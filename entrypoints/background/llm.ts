export type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ApiContentPart[];
}

export interface StreamChatOptions {
  base: string;
  apiKey: string;
  model: string;
  messages: ApiMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
  extraBody?: Record<string, unknown>;
  onDelta?: (text: string, reasoning: boolean) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function streamChat(options: StreamChatOptions): Promise<string> {
  const {
    base,
    apiKey,
    model,
    messages,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    extraBody,
    onDelta,
  } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    signal: combined,
    body: JSON.stringify({ model, messages, stream: true, ...extraBody }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `HTTP ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 300)}` : ''}`,
    );
  }
  if (!response.body) throw new Error('Response has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let acc = '';
  let done = false;
  while (!done) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        break;
      }
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string; reasoning?: string; reasoning_content?: string };
          }>;
        };
        const delta = chunk.choices?.[0]?.delta;
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (delta?.content) {
          acc += delta.content;
          onDelta?.(delta.content, false);
        } else if (reasoning) {
          onDelta?.(reasoning, true);
        }
      } catch {
        buffer = '';
      }
    }
  }
  return acc;
}
