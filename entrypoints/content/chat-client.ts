import { browser } from 'wxt/browser';
import type { ChatPortMessage } from '@/shared/types';

type Port = ReturnType<typeof browser.runtime.connect>;

let port: Port | null = null;
let handler: ((message: ChatPortMessage) => void) | null = null;

export function onChatMessage(callback: (message: ChatPortMessage) => void): void {
  handler = callback;
}

/** Connect (or re-connect) the port eagerly so the background can push
 * notifications (agent steps, done, answers) to this panel. */
export function ensureChatPort(): void {
  getPort();
}

export function chatPost(message: ChatPortMessage): void {
  getPort().postMessage(message);
}

function getPort(): Port {
  if (port == null) {
    port = browser.runtime.connect({ name: 'chat' });
    port.onMessage.addListener((raw: unknown) => handler?.(raw as ChatPortMessage));
    port.onDisconnect.addListener(() => {
      port = null;
    });
  }
  return port;
}
