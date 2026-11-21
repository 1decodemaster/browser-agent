import { browser } from 'wxt/browser';
import type { ChatMessage, ChatPortMessage } from '@/shared/types';
import { getSettings } from '@/shared/settings';
import { streamChat, type ApiContentPart, type ApiMessage } from './llm';
import { acquireKeepalive, releaseKeepalive } from './keepalive';
import { removeAgentState, resumeAgentIfStale, startAgent, stopAgent } from './agent';
import { normalizeEndpoint } from '@/shared/endpoint';

type Port = ReturnType<typeof browser.runtime.connect>;
type SendRequest = Extract<ChatPortMessage, { type: 'chat.send' }>;

const SYSTEM_PROMPT =
  'You are Browser Agent, an assistant embedded in the user\'s browser. A DOM outline of the page the user is viewing (interactive elements + main text) is attached to their messages automatically; screenshots may also be attached. Answer helpfully and concisely, grounding answers in the provided page context. You can only read and answer - you cannot browse, click, or take any action. If the user asks you to act on the page, tell them to turn on Act mode and send their goal as an agent run instead. If the needed context is missing, say so briefly.';

const chatKey = (tabId: number) => `session:chat:${tabId}` as const;

export async function getHistory(tabId: number): Promise<ChatMessage[]> {
  return (await storage.getItem<ChatMessage[]>(chatKey(tabId))) ?? [];
}

export async function clearHistory(tabId: number): Promise<void> {
  await storage.removeItem(chatKey(tabId));
}

export async function saveHistory(tabId: number, messages: ChatMessage[]): Promise<void> {
  await storage.setItem(chatKey(tabId), messages);
}

const tabPorts = new Map<number, Port>();

export function getTabPort(tabId: number): Port | undefined {
  return tabPorts.get(tabId);
}

export function watchChatPorts(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'chat') return;
    const tabId = port.sender?.tab?.id;
    if (tabId == null) {
      port.disconnect();
      return;
    }
    tabPorts.set(tabId, port);
    void resumeAgentIfStale(tabId);
    const controllers = new Map<string, AbortController>();
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as ChatPortMessage;
      if (message.type === 'chat.send') {
        void handleSend(port, tabId, message, controllers);
      } else if (message.type === 'chat.stop') {
        controllers.get(message.requestId)?.abort();
      } else if (message.type === 'agent.start') {
        void startAgent(tabId, message.goal, message.askFirst);
      } else if (message.type === 'agent.stop') {
        void stopAgent(tabId);
      }
    });
    port.onDisconnect.addListener(() => {
      if (tabPorts.get(tabId) === port) tabPorts.delete(tabId);
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void storage.removeItem(chatKey(tabId));
    removeAgentState(tabId);
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
    pageContext: message.pageContext,
    images: message.screenshots?.length ? message.screenshots : undefined,
  });
  trimStoredContexts(history);
  await saveHistory(tabId, history);

  const controller = new AbortController();
  controllers.set(requestId, controller);

  const base = normalizeEndpoint(settings.endpointUrl);
  acquireKeepalive();
  try {
    const acc = await streamChat({
      base,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: buildApiMessages(history),
      signal: controller.signal,
      onDelta: (deltaText, isReasoning) => {
        port.postMessage({
          type: 'chat.delta',
          requestId,
          text: deltaText,
          reasoning: isReasoning,
        });
      },
    });
    if (acc) {
      history.push({ role: 'assistant', text: acc });
      await saveHistory(tabId, history);
    }
    port.postMessage({ type: 'chat.done', requestId, text: acc });
  } catch (error) {
    if (controller.signal.aborted) {
      port.postMessage({ type: 'chat.done', requestId, text: '', stopped: true });
    } else {
      port.postMessage({ type: 'chat.error', requestId, message: describeError(error) });
    }
  } finally {
    releaseKeepalive();
    controllers.delete(requestId);
  }
}

const KEEP_STORED_CONTEXTS = 2;

function trimStoredContexts(history: ChatMessage[]): void {
  const indices = history
    .map((message, index) => (message.pageContext != null ? index : -1))
    .filter((index) => index >= 0);
  for (const index of indices.slice(0, -KEEP_STORED_CONTEXTS)) {
    delete history[index]!.pageContext;
  }
}

function buildApiMessages(history: ChatMessage[]): ApiMessage[] {
  const messages: ApiMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const lastContextIndex = findLastIndex(history, (message) => message.pageContext != null);
  history.forEach((message, index) => {
    const isFirst = index === 0;
    const hasAttachments = message.pageContext != null || (message.images?.length ?? 0) > 0;
    const includeHeader = isFirst || hasAttachments;
    const header =
      includeHeader && message.url ? `Page: ${message.title || ''} (${message.url})\n\n` : '';
    const contextBlock =
      index === lastContextIndex && message.pageContext
        ? `\n\nPage context (accessibility outline of interactive elements + main text, may be truncated):\n${message.pageContext}`
        : '';
    const text = `${header}${message.text}${contextBlock}`;
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

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'LLM request timed out - the model took too long to respond.';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) {
    return `${message} - could not reach the endpoint. For Ollama set OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*"; in LM Studio enable CORS.`;
  }
  if (message.includes('403')) {
    return `${message} - the server rejected this extension's origin. For Ollama set OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*".`;
  }
  return message;
}
