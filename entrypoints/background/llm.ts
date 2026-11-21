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
  /** Abort when no token (content or reasoning) has arrived within this window. */
  firstTokenTimeoutMs?: number;
  /** Hard cap for the whole streaming response, counted from request start. */
  totalTimeoutMs?: number;
  extraBody?: Record<string, unknown>;
  onDelta?: (text: string, reasoning: boolean) => void;
}

export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

export function isLlmTimeout(error: unknown): boolean {
  return (
    error instanceof LlmTimeoutError ||
    (error instanceof DOMException && error.name === 'TimeoutError')
  );
}

export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;

export async function streamChat(options: StreamChatOptions): Promise<string> {
  const {
    base,
    apiKey,
    model,
    messages,
    signal,
    firstTokenTimeoutMs,
    totalTimeoutMs,
    extraBody,
    onDelta,
  } = options;
  const firstTokenMs = firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
  const totalMs = totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(
      signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
    );
  };
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let timeoutError: LlmTimeoutError | null = null;
  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timeoutError = new LlmTimeoutError(
      `no response from the model within ${Math.round(firstTokenMs / 1000)}s (model too slow or endpoint unreachable)`,
    );
    controller.abort(timeoutError);
  }, firstTokenMs);
  const totalTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    timeoutError = new LlmTimeoutError(
      `stream exceeded ${Math.round(totalMs / 1000)}s in total (model too slow for this request)`,
    );
    controller.abort(timeoutError);
  }, totalMs);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
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
      if (firstTokenTimer !== undefined) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
      }
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
  } catch (error) {
    if (timeoutError) throw timeoutError;
    throw error;
  } finally {
    if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
