import { browser } from 'wxt/browser';
import type { ChatMessage, ChatPortMessage } from '@/shared/types';
import { getSettings } from '@/shared/settings';
import { normalizeEndpoint } from '@/shared/endpoint';

type Port = ReturnType<typeof browser.runtime.connect>;
type SendRequest = Extract<ChatPortMessage, { type: 'chat.send' }>;

const SYSTEM_PROMPT =
  'You are Browser Agent, an assistant embedded in the user\'s browser. The user shares page HTML, screenshots, or questions about the page they are viewing. Answer helpfully and concisely, grounding answers in the provided page context. If the needed context is missing, say so briefly.';

type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ApiContentPart[];
}

const chatKey = (tabId: number) => `session:chat:${tabId}` as const;

export async function getHistory(tabId: number): Promise<ChatMessage[]> {
  return (await storage.getItem<ChatMessage[]>(chatKey(tabId))) ?? [];
}

export async function clearHistory(tabId: number): Promise<void> {
  await storage.removeItem(chatKey(tabId));
}

async function saveHistory(tabId: number, messages: ChatMessage[]): Promise<void> {
  await storage.setItem(chatKey(tabId), messages);
}

export function watchChatPorts(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'chat') return;
    const tabId = port.sender?.tab?.id;
    if (tabId == null) {
      port.disconnect();
      return;
    }
    const controllers = new Map<string, AbortController>();
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as ChatPortMessage;
      if (message.type === 'chat.send') {
        void handleSend(port, tabId, message, controllers);
      } else if (message.type === 'chat.stop') {
        controllers.get(message.requestId)?.abort();
      }
    });
    port.onDisconnect.addListener(() => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void storage.removeItem(chatKey(tabId));
  });
}

async function handleSend(
  port: Port,
  tabId: number,
  message: SendRequest,
  controllers: Map<string, AbortController>,
): Promise<void> {
  const { requestId } = message;
  const settings = await getSettings();
  if (!settings.endpointUrl) {
    port.postMessage({
      type: 'chat.error',
      requestId,
      message: 'No endpoint configured - set it in the Options page.',
    });
    return;
  }

  const history = await getHistory(tabId);
  history.push({
    role: 'user',
    text: message.text,
    url: message.url,
    title: message.title,
    html: message.html,
    images: message.screenshotDataUrl ? [message.screenshotDataUrl] : undefined,
  });
  await saveHistory(tabId, history);

  const controller = new AbortController();
  controllers.set(requestId, controller);

  const base = normalizeEndpoint(settings.endpointUrl);
  let acc = '';
  try {
    await streamCompletion(
      base,
      settings.apiKey,
      settings.model,
      buildApiMessages(history),
      controller.signal,
      (deltaText, isReasoning) => {
        if (!isReasoning) acc += deltaText;
        port.postMessage({
          type: 'chat.delta',
          requestId,
          text: deltaText,
          reasoning: isReasoning,
        });
      },
    );
    if (acc) {
      history.push({ role: 'assistant', text: acc });
      await saveHistory(tabId, history);
    }
    port.postMessage({ type: 'chat.done', requestId, text: acc });
  } catch (error) {
    if (controller.signal.aborted) {
      if (acc) {
        history.push({ role: 'assistant', text: acc });
        await saveHistory(tabId, history);
      }
      port.postMessage({ type: 'chat.done', requestId, text: acc, stopped: true });
    } else {
      port.postMessage({ type: 'chat.error', requestId, message: describeError(error) });
    }
  } finally {
    controllers.delete(requestId);
  }
}

async function streamCompletion(
  base: string,
  apiKey: string,
  model: string,
  messages: ApiMessage[],
  signal: AbortSignal,
  onDelta: (text: string, reasoning: boolean) => void,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url = `${base}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from ${url}${body ? ` - ${body.slice(0, 300)}` : ''}`,
    );
  }
  if (!response.body) throw new Error('Response has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
        if (delta?.content) onDelta(delta.content, false);
        else if (reasoning) onDelta(reasoning, true);
      } catch {
        buffer = '';
      }
    }
  }
}

function buildApiMessages(history: ChatMessage[]): ApiMessage[] {
  const messages: ApiMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  history.forEach((message, index) => {
    const isFirst = index === 0;
    const hasAttachments = message.html != null || (message.images?.length ?? 0) > 0;
    const includeHeader = isFirst || hasAttachments;
    const header =
      includeHeader && message.url ? `Page: ${message.title || ''} (${message.url})\n\n` : '';
    const htmlBlock = message.html
      ? `\n\nPage HTML (may be truncated):\n\`\`\`html\n${message.html}\n\`\`\``
      : '';
    const text = `${header}${message.text}${htmlBlock}`;
    const images = message.images ?? [];
    if (images.length > 0) {
      messages.push({
        role: message.role,
        content: [
          { type: 'text', text: text || 'Describe the attached screenshot.' },
          ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      });
    } else {
      messages.push({ role: message.role, content: text });
    }
  });
  return messages;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) {
    return `${message} - could not reach the endpoint. For Ollama set OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*"; in LM Studio enable CORS.`;
  }
  if (message.includes('403')) {
    return `${message} - the server rejected this extension's origin. For Ollama set OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*".`;
  }
  return message;
}
