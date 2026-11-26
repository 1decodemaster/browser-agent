import type { ActionObservation, ActionOp, ConfirmMode } from './protocol';

export interface Settings {
  endpointUrl: string;
  model: string;
  apiKey: string;
  sites: Record<string, boolean>;
  actEndpointUrl?: string;
  actModel?: string;
  actReasoningEffort?: string;
  actExtraInstructions?: string;
  actVision?: boolean;
  llmFirstTokenTimeoutMs?: number;
  llmTotalTimeoutMs?: number;
  agentWorkingMemory?: boolean;
  sttEndpointUrl?: string;
  sttModel?: string;
  ttsEndpointUrl?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsAutoRead?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  url?: string;
  title?: string;
  pageContext?: string;
  images?: string[];
}

export type RpcRequest =
  | { kind: 'chat:history' }
  | { kind: 'chat:clear' }
  | { kind: 'screenshot:capture' }
  | { kind: 'voice:transcribe'; audioBase64: string; mimeType: string }
  | { kind: 'voice:speak'; text: string }
  | { kind: 'agent:get' }
  | { kind: 'agent:debug' }
  | { kind: 'act:observe' }
  | { kind: 'act:execute'; actions: ActionOp[]; confirmMode: ConfirmMode }
  | { kind: 'panel:toggle' };

export interface SpeakResult {
  audioBase64: string;
  mimeType: string;
}

export interface ScreenshotData {
  dataUrl: string;
}

export type ChatPortMessage =
  | {
      type: 'chat.send';
      requestId: string;
      text: string;
      pageContext?: string;
      screenshots?: string[];
      url: string;
      title: string;
    }
  | { type: 'chat.stop'; requestId: string }
  | { type: 'chat.delta'; requestId: string; text: string; reasoning?: boolean }
  | { type: 'chat.done'; requestId: string; text: string; stopped?: boolean }
  | { type: 'chat.error'; requestId: string; message: string }
  | { type: 'chat.answer'; text: string }
  | { type: 'agent.start'; goal: string; askFirst: boolean }
  | { type: 'agent.stop' }
  | { type: 'agent.resume'; text: string }
  | { type: 'agent.paused'; reason: 'blocked' | 'steplimit'; question: string }
  | { type: 'agent.step'; step: number; thought: string; observations: ActionObservation[]; details?: string[] }
  | { type: 'agent.done'; summary?: string }
  | { type: 'agent.error'; message: string };

export type RpcResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };
