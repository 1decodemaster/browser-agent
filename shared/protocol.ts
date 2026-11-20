export type ScrollTarget = 'top' | 'bottom' | 'up' | 'down';

export type ActionOp =
  | { op: 'click'; target: number }
  | { op: 'type'; target: number; text: string; submit?: boolean }
  | { op: 'scroll'; to: ScrollTarget }
  | { op: 'scroll'; target: number }
  | { op: 'extract'; target: number }
  | { op: 'navigate'; url: string }
  | { op: 'wait'; ms: number }
  | { op: 'done'; summary?: string };

export interface ActionObservation {
  ok: boolean;
  op: string;
  target?: number;
  message?: string;
}

export type Autonomy = 'supervise' | 'normal' | 'auto';

export type ConfirmMode = 'always' | 'destructive' | 'never';

export interface ObserveResult {
  index: string;
  url: string;
  title: string;
}

export interface AgentSummary {
  status: 'idle' | 'running';
  step: number;
  goal: string;
  autonomy: Autonomy;
  narration: string[];
}
