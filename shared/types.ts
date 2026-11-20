export interface Settings {
  endpointUrl: string;
  model: string;
  apiKey: string;
  sites: Record<string, boolean>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  url?: string;
  title?: string;
  html?: string;
  images?: string[];
}

export type RpcRequest =
  | { kind: 'chat:history' }
  | { kind: 'screenshot:capture' }
  | { kind: 'panel:toggle' };

export interface ScreenshotData {
  dataUrl: string;
}

export type ChatPortMessage =
  | {
      type: 'chat.send';
      requestId: string;
      text: string;
      html?: string;
      screenshotDataUrl?: string;
      url: string;
      title: string;
    }
  | { type: 'chat.stop'; requestId: string }
  | { type: 'chat.delta'; requestId: string; text: string; reasoning?: boolean }
  | { type: 'chat.done'; requestId: string; text: string; stopped?: boolean }
  | { type: 'chat.error'; requestId: string; message: string };

export type RpcResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };
