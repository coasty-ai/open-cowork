/**
 * Pure multi-monitor window-placement geometry — no Electron, no I/O, so it is
 * exhaustively unit-testable. The Electron main process feeds it plain display
 * descriptors (mirroring `screen.getAllDisplays()`) and the window's last saved
 * box, and gets back a box that is guaranteed to be reachable on some currently
 * connected display.
 *
 * All coordinates are device-independent pixels (DIP), exactly like Electron's
 * `screen`/`BrowserWindow` bounds. Working purely in DIP is what makes mixed-DPI
 * setups (e.g. a 100% primary next to a 150% secondary) behave correctly: a box
 * sized/placed in DIP renders crisply on whichever display it lands on because
 * Electron handles the DIP→physical conversion per display. We never multiply by
 * scaleFactor ourselves — doing so is the classic source of wrong-size/blurry
 * windows on the second monitor.
 */

/** A window/display box in DIP. `x`/`y` may be negative (left/top monitors). */
export interface WindowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Minimal shape of an Electron `Display` (the fields placement needs). */
export interface DisplayLike {
  id: number;
  /** Full display area in DIP (can have negative origin). */
  bounds: WindowBox;
  /** Usable area (excludes taskbar/dock), in DIP. */
  workArea: WindowBox;
  /** DPI scale (1 = 100%, 1.5 = 150%). Informational; placement stays in DIP. */
  scaleFactor?: number;
}

export interface ResolveOptions {
  /** The window's last saved box, or null on first launch. */
  saved: WindowBox | null;
  /** Currently connected displays. */
  displays: DisplayLike[];
  /** Electron's primary display id (used for first-launch centring + fallback). */
  primaryDisplayId?: number;
  /** Size to open at when there is no saved box. */
  defaultSize: { width: number; height: number };
  /** The window's minimum size — placement never shrinks below this. */
  minSize: { width: number; height: number };
}

export interface ResolvedBounds {
  bounds: WindowBox;
  /** True when the saved box was off-screen and had to be pulled back on. */
  recentred: boolean;
}

/**
 * How much of the window's title bar must remain on a display's work area for
 * the window to count as "reachable" (the user can grab and drag it). The
 * off-screen-restore failure mode is precisely a title bar the user can't reach.
 */
const TITLE_BAR_HEIGHT = 32;
const MIN_GRAB_WIDTH = 96;

function intersectRect(a: WindowBox, b: WindowBox): WindowBox | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function overlapArea(a: WindowBox, b: WindowBox): number {
  const i = intersectRect(a, b);
  return i ? i.width * i.height : 0;
}

function centerOf(r: WindowBox): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function centerDistanceSq(a: WindowBox, b: WindowBox): number {
  const ca = centerOf(a);
  const cb = centerOf(b);
  return (ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Clamp a desired length into [min(min, area), area] — never larger than the area. */
function clampLength(want: number, min: number, area: number): number {
  return Math.max(Math.min(want, area), Math.min(min, area));
}

/**
 * The display a box belongs to: the one it overlaps most (by area). With no
 * overlap at all (box fully off every display) it's the nearest by centre
 * distance; with no displays, undefined.
 */
export function displayForRect(rect: WindowBox, displays: DisplayLike[]): DisplayLike | undefined {
  if (displays.length === 0) return undefined;
  let best: DisplayLike | undefined;
  let bestArea = 0;
  for (const d of displays) {
    const a = overlapArea(rect, d.bounds);
    if (a > bestArea) {
      bestArea = a;
      best = d;
    }
  }
  if (best) return best;
  // No overlap anywhere — pick the nearest display by centre distance.
  let nearest = displays[0]!;
  let nearestDist = centerDistanceSq(rect, nearest.bounds);
  for (const d of displays.slice(1)) {
    const dist = centerDistanceSq(rect, d.bounds);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = d;
    }
  }
  return nearest;
}

/**
 * True when the window's title bar is grabbable: a `MIN_GRAB_WIDTH`-wide slice
 * of the top `TITLE_BAR_HEIGHT` strip lies within some display's work area.
 * Catches the real failures — fully off-screen, dragged above the top edge, or
 * sitting on a now-disconnected monitor — while tolerating a window that merely
 * hangs off an edge but is still draggable.
 */
export function isReachable(rect: WindowBox, displays: DisplayLike[]): boolean {
  const titleBar: WindowBox = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: TITLE_BAR_HEIGHT,
  };
  return displays.some((d) => {
    const i = intersectRect(titleBar, d.workArea);
    return i !== null && i.width >= MIN_GRAB_WIDTH && i.height >= 1;
  });
}

/** Centre a size within an area (never larger than the area). */
export function centerWithin(size: { width: number; height: number }, area: WindowBox): WindowBox {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** Shrink a box to fit an area and slide it fully inside that area. */
export function fitWithin(
  rect: WindowBox,
  area: WindowBox,
  minSize: { width: number; height: number },
): WindowBox {
  const width = clampLength(rect.width, minSize.width, area.width);
  const height = clampLength(rect.height, minSize.height, area.height);
  return {
    x: Math.round(clamp(rect.x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(rect.y, area.y, area.y + area.height - height)),
    width,
    height,
  };
}

/**
 * Decide where to open the window. Restores the saved box when it is still
 * reachable on a connected display (sized down if the target display shrank);
 * otherwise pulls it fully onto the display it best belongs to. With no saved
 * box, centres the default size on the primary display.
 */
export function resolveWindowBounds(opts: ResolveOptions): ResolvedBounds {
  const { saved, displays, primaryDisplayId, defaultSize, minSize } = opts;
  const primary = displays.find((d) => d.id === primaryDisplayId) ?? displays[0] ?? null;

  // Defensive: no display info at all — open at the origin with the default size.
  if (!primary) {
    return { bounds: { x: 0, y: 0, ...defaultSize }, recentred: !saved };
  }

  if (!saved || !isValidBox(saved)) {
    return { bounds: centerWithin(defaultSize, primary.workArea), recentred: false };
  }

  const target = displayForRect(saved, displays) ?? primary;
  // Never restore a window larger than its target display's usable area.
  const sized: WindowBox = {
    x: saved.x,
    y: saved.y,
    width: clampLength(saved.width, minSize.width, target.workArea.width),
    height: clampLength(saved.height, minSize.height, target.workArea.height),
  };

  if (isReachable(sized, displays)) {
    return { bounds: sized, recentred: false };
  }
  // Off-screen (monitor unplugged / arrangement changed) — bring it home.
  return { bounds: fitWithin(sized, target.workArea, minSize), recentred: true };
}

/**
 * For a live window after a display change: returns clamped bounds if the
 * window is no longer reachable, or null if it is already fine (no move needed).
 */
export function ensureOnScreen(
  bounds: WindowBox,
  displays: DisplayLike[],
  minSize: { width: number; height: number },
): WindowBox | null {
  if (displays.length === 0 || isReachable(bounds, displays)) return null;
  const target = displayForRect(bounds, displays);
  if (!target) return null;
  return fitWithin(bounds, target.workArea, minSize);
}

function isValidBox(box: WindowBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}
