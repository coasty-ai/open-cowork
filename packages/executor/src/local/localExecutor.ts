/**
 * LocalExecutor — first-class local screen control for the desktop app.
 * Wraps a NativeBridge and handles the #1 documented pitfall: coordinate
 * scaling. The model returns coordinates in the coordinate space of the
 * screenshot it saw; if the capture size differs from the input coordinate
 * space (DPI scaling), we map model-space → input-space before acting.
 */
import { normalizeAction, type CuaAction } from '@open-cowork/core';
import { UnsupportedActionError, type Executor, type Screenshot } from '../executor';
import type { NativeBridge } from './bridge';

export interface LocalExecutorOptions {
  bridge: NativeBridge;
  /** Injectable sleep for `wait` actions (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export class LocalExecutor implements Executor {
  readonly kind = 'local' as const;
  private readonly bridge: NativeBridge;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Size of the last screenshot sent to the model (model coordinate space). */
  private captureDims: { width: number; height: number } | null = null;

  constructor(opts: LocalExecutorOptions) {
    this.bridge = opts.bridge;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async screenshot(): Promise<Screenshot> {
    const shot = await this.bridge.capture();
    this.captureDims = { width: shot.width, height: shot.height };
    return shot;
  }

  async dimensions(): Promise<{ width: number; height: number }> {
    return this.bridge.screenSize();
  }

  /** Map model-space coordinates (screenshot pixels) to input-space pixels. */
  private async scalePoint(x: number, y: number): Promise<{ x: number; y: number }> {
    const capture = this.captureDims ?? (await this.bridge.capture());
    if (!this.captureDims) this.captureDims = { width: capture.width, height: capture.height };
    const screen = await this.bridge.screenSize();
    const sx = screen.width / this.captureDims.width;
    const sy = screen.height / this.captureDims.height;
    return { x: Math.round(x * sx), y: Math.round(y * sy) };
  }

  async execute(action: CuaAction): Promise<void> {
    const a = normalizeAction(action);
    switch (a.action_type) {
      case 'click': {
        const p = await this.scalePoint(a.x, a.y);
        await this.bridge.click(p.x, p.y, a.button, a.clicks);
        return;
      }
      case 'move': {
        const p = await this.scalePoint(a.x, a.y);
        await this.bridge.moveMouse(p.x, p.y);
        return;
      }
      case 'drag': {
        const from = await this.scalePoint(a.from_x, a.from_y);
        const to = await this.scalePoint(a.to_x, a.to_y);
        await this.bridge.drag(from.x, from.y, to.x, to.y, a.button);
        return;
      }
      case 'type_text':
        await this.bridge.typeText(a.text);
        return;
      case 'key_press':
        await this.bridge.keyPress(a.keys);
        return;
      case 'key_combo':
        await this.bridge.keyCombo(a.keys);
        return;
      case 'scroll': {
        if (a.x !== undefined && a.y !== undefined) {
          const p = await this.scalePoint(a.x, a.y);
          await this.bridge.scroll(a.direction, a.amount, p.x, p.y);
        } else {
          await this.bridge.scroll(a.direction, a.amount);
        }
        return;
      }
      case 'wait':
        await this.sleep(a.ms);
        return;
      case 'done':
      case 'fail':
        return;
      case 'raw':
        // Executing model-generated code on the user's own machine is out of
        // the question without an explicit, audited opt-in. Fail loudly.
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
    await this.bridge.dispose();
  }
}
