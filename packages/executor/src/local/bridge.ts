/**
 * NativeBridge — the narrow waist between LocalExecutor and the operating
 * system. Implementations shell out to built-in OS tooling (no native npm
 * modules; see DECISIONS.md D2). Tests inject a fake.
 */

export interface CaptureResult {
  /** Raw base64 PNG, no data: prefix. */
  base64: string;
  width: number;
  height: number;
}

export type MouseButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface NativeBridge {
  /** Capture the primary screen. */
  capture(): Promise<CaptureResult>;
  /** Primary screen size in the same coordinate space `click` etc. use. */
  screenSize(): Promise<{ width: number; height: number }>;
  click(x: number, y: number, button: MouseButton, clicks: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton): Promise<void>;
  typeText(text: string): Promise<void>;
  /** Press keys one after another. */
  keyPress(keys: string[]): Promise<void>;
  /** Press keys together as a chord. */
  keyCombo(keys: string[]): Promise<void>;
  scroll(direction: ScrollDirection, amount: number, x?: number, y?: number): Promise<void>;
  /** Release any OS resources (child processes). Idempotent. */
  dispose(): Promise<void>;
}
