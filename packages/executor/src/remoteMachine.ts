/**
 * RemoteMachineExecutor — drives a Coasty cloud machine through the documented
 * machine endpoints (`GET /machines/{id}/screenshot`, `POST /machines/{id}/actions`).
 *
 * The transport is injected as a minimal structural interface that
 * `CoastyClient` satisfies directly; the web/mobile apps satisfy it with a thin
 * backend-proxy client instead (the API key never reaches a client).
 */
import {
  normalizeAction,
  type CuaAction,
  type MachineActionRequest,
  type MachineActionResponse,
  type MachineScreenshotResponse,
} from '@open-cowork/core';
import { UnsupportedActionError, type Executor, type Screenshot } from './executor';

export interface RemoteMachineTransport {
  machineScreenshot(machineId: string): Promise<MachineScreenshotResponse>;
  machineAction(machineId: string, req: MachineActionRequest): Promise<MachineActionResponse>;
}

export interface RemoteMachineExecutorOptions {
  machineId: string;
  transport: RemoteMachineTransport;
  /** Injectable sleep for `wait` actions (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export class RemoteMachineExecutor implements Executor {
  readonly kind = 'remote-machine' as const;
  private readonly machineId: string;
  private readonly transport: RemoteMachineTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastDims: { width: number; height: number } | null = null;

  constructor(opts: RemoteMachineExecutorOptions) {
    this.machineId = opts.machineId;
    this.transport = opts.transport;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async screenshot(): Promise<Screenshot> {
    const res = await this.transport.machineScreenshot(this.machineId);
    this.lastDims = { width: res.width, height: res.height };
    return { base64: res.image_b64, width: res.width, height: res.height };
  }

  async dimensions(): Promise<{ width: number; height: number }> {
    if (this.lastDims) return this.lastDims;
    const shot = await this.screenshot();
    return { width: shot.width, height: shot.height };
  }

  async execute(action: CuaAction): Promise<void> {
    const a = normalizeAction(action);
    switch (a.action_type) {
      case 'click':
        await this.action('click', { x: a.x, y: a.y, button: a.button, clicks: a.clicks });
        return;
      case 'type_text':
        await this.action('type', { text: a.text });
        return;
      case 'key_press':
        for (const key of a.keys) {
          await this.action('key_press', { key });
        }
        return;
      case 'key_combo':
        await this.action('key_combo', { keys: a.keys });
        return;
      case 'scroll':
        await this.action('scroll', { x: a.x, y: a.y, direction: a.direction, amount: a.amount });
        return;
      case 'drag':
        await this.action('drag', {
          from_x: a.from_x,
          from_y: a.from_y,
          to_x: a.to_x,
          to_y: a.to_y,
          button: a.button,
        });
        return;
      case 'move':
        await this.action('move', { x: a.x, y: a.y });
        return;
      case 'wait':
        // Waiting is local: no remote call required.
        await this.sleep(a.ms);
        return;
      case 'done':
      case 'fail':
        // Terminal signals are handled by the agent loop, never executed.
        return;
      case 'raw':
        // Arbitrary code on a remote machine is a security boundary we do not
        // cross implicitly (would also require the browser:execute scope).
        throw new UnsupportedActionError(
          'raw',
          this.kind,
          'raw code execution is disabled by policy',
        );
      default: {
        const unknown = a as { action_type: string };
        throw new UnsupportedActionError(unknown.action_type, this.kind);
      }
    }
  }

  async dispose(): Promise<void> {
    // Stateless: nothing to release. (The machine lifecycle is managed by the
    // machines API, not by the executor.)
  }

  private async action(command: string, parameters: Record<string, unknown>): Promise<void> {
    const res = await this.transport.machineAction(this.machineId, { command, parameters });
    if (!res.success) {
      throw new Error(`Machine action '${command}' failed: ${res.error ?? 'unknown error'}`);
    }
  }
}
