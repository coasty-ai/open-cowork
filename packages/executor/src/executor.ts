/**
 * The Executor abstraction: one shared agent loop in @open-cowork/core drives
 * any screen through this interface. Implementations:
 *  - LocalExecutor          — the user's own desktop (native OS bridges)
 *  - RemoteMachineExecutor  — a Coasty cloud machine (via API/backend proxy)
 *  - BrowserExecutor        — a Playwright page
 *
 * It extends core's structural `AgentScreen`, so any Executor plugs straight
 * into `runAgentLoop`.
 */
import type { AgentScreen, CuaAction } from '@open-cowork/core';

export type ExecutorKind = 'local' | 'remote-machine' | 'browser';

export interface Screenshot {
  /** Raw base64 PNG/JPEG — no data: prefix. */
  base64: string;
  width: number;
  height: number;
}

export interface Executor extends AgentScreen {
  readonly kind: ExecutorKind;
  screenshot(): Promise<Screenshot>;
  execute(action: CuaAction): Promise<void>;
  /** Current screen dimensions (the coordinate space of `execute`). */
  dimensions(): Promise<{ width: number; height: number }>;
  /** Release resources (processes, sessions, pages). Idempotent. */
  dispose(): Promise<void>;
}

/** Thrown when an executor receives an action it must not perform. */
export class UnsupportedActionError extends Error {
  override readonly name = 'UnsupportedActionError';
  constructor(actionType: string, kind: ExecutorKind, reason?: string) {
    super(`Executor '${kind}' cannot execute action '${actionType}'${reason ? `: ${reason}` : ''}`);
  }
}
