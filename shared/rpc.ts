import { browser } from 'wxt/browser';
import type { RpcRequest, RpcResponse } from './types';

export interface RpcSender {
  tab?: { id?: number };
}

interface RpcMessage {
  __rpc: true;
  request: RpcRequest;
}

type SendResponse = (response: RpcResponse) => void;

export async function rpc<T>(request: RpcRequest, tabId?: number): Promise<T> {
  const message: RpcMessage = { __rpc: true, request };
  const raw =
    tabId != null
      ? await browser.tabs.sendMessage(tabId, message)
      : await browser.runtime.sendMessage(message);
  const response = raw as RpcResponse<T> | undefined;
  if (response == null) throw new Error('No RPC response');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

export function onRpc(
  handler: (request: RpcRequest, sender: RpcSender) => Promise<unknown>,
): void {
  browser.runtime.onMessage.addListener(
    (raw: unknown, sender: unknown, sendResponse: SendResponse): boolean => {
      if (!isRpcMessage(raw)) return false;
      void handler(raw.request, sender as RpcSender)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    },
  );
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return (
    typeof value === 'object' && value !== null && (value as { __rpc?: unknown }).__rpc === true
  );
}
