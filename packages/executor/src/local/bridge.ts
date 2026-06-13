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

/**
 * A physical-pixel rectangle of one display on the virtual desktop. When a
 * bridge is created with a region it captures ONLY that rectangle and offsets
 * every input coordinate by `x`/`y`, so a local run drives the monitor the user
 * picked rather than always the primary one. `x`/`y` may be negative (a monitor
 * to the left of / above the primary).
 */
export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MouseButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface NativeBridge {
  /** Capture the target screen (the configured {@link ScreenRegion}, else primary). */
  capture(): Promise<CaptureResult>;
  /** Target screen size — the coordinate space the model's coordinates live in. */
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
