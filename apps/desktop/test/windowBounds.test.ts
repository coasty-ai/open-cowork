import { describe, expect, it } from 'vitest';
import {
  displayForRect,
  ensureOnScreen,
  fitWithin,
  centerWithin,
  isReachable,
  resolveWindowBounds,
  type DisplayLike,
  type WindowBox,
} from '../src/windowBounds';

// ── display arrangements ────────────────────────────────────────────────────
// Primary 1920×1080 @100%, a 40px taskbar at the bottom.
const PRIMARY: DisplayLike = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
};
// A higher-res, higher-DPI monitor to the RIGHT (different resolution + 150%).
const RIGHT_HIDPI: DisplayLike = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
  scaleFactor: 1.5,
};
// A smaller monitor to the LEFT — negative origin.
const LEFT: DisplayLike = {
  id: 3,
  bounds: { x: -1280, y: 0, width: 1280, height: 800 },
  workArea: { x: -1280, y: 0, width: 1280, height: 760 },
  scaleFactor: 1,
};
// A monitor stacked ABOVE the primary — negative y.
const TOP: DisplayLike = {
  id: 4,
  bounds: { x: 0, y: -1080, width: 1920, height: 1080 },
  workArea: { x: 0, y: -1080, width: 1920, height: 1040 },
  scaleFactor: 1,
};

const MIN = { width: 940, height: 640 };
const DEFAULT = { width: 1280, height: 840 };

const onAnyDisplay = (b: WindowBox, displays: DisplayLike[]) => isReachable(b, displays);

describe('displayForRect', () => {
  it('returns the display the box overlaps most', () => {
    const box = { x: 2000, y: 100, width: 1000, height: 700 }; // mostly on RIGHT
    expect(displayForRect(box, [PRIMARY, RIGHT_HIDPI])?.id).toBe(RIGHT_HIDPI.id);
  });

  it('falls back to the nearest display when the box overlaps none', () => {
    const box = { x: 5000, y: 100, width: 400, height: 300 }; // far right of everything
    expect(displayForRect(box, [PRIMARY, RIGHT_HIDPI])?.id).toBe(RIGHT_HIDPI.id);
  });

  it('handles negative-coordinate (left) displays', () => {
    const box = { x: -900, y: 100, width: 600, height: 500 };
    expect(displayForRect(box, [PRIMARY, LEFT])?.id).toBe(LEFT.id);
  });

  it('returns undefined with no displays', () => {
    expect(displayForRect({ x: 0, y: 0, width: 10, height: 10 }, [])).toBeUndefined();
  });
});

describe('isReachable', () => {
  it('accepts a window fully on a display', () => {
    expect(isReachable({ x: 100, y: 100, width: 800, height: 600 }, [PRIMARY])).toBe(true);
  });

  it('accepts a window that hangs off an edge but keeps a grabbable title bar', () => {
    // 120px of the title bar remains within the 1920-wide work area.
    expect(isReachable({ x: 1800, y: 100, width: 1000, height: 700 }, [PRIMARY])).toBe(true);
  });

  it('rejects a window dragged above the top edge (title bar unreachable)', () => {
    expect(isReachable({ x: 100, y: -200, width: 1000, height: 800 }, [PRIMARY])).toBe(false);
  });

  it('rejects a window with too little title bar showing', () => {
    // Only 70px of title bar visible (< MIN_GRAB_WIDTH).
    expect(isReachable({ x: 1850, y: 100, width: 1000, height: 700 }, [PRIMARY])).toBe(false);
  });

  it('rejects a window sitting entirely on a disconnected monitor', () => {
    const onlyPrimary = [PRIMARY];
    expect(isReachable({ x: 2200, y: 300, width: 1000, height: 700 }, onlyPrimary)).toBe(false);
  });
});

describe('resolveWindowBounds — first launch', () => {
  it('centres the default size on the primary work area', () => {
    const { bounds, recentred } = resolveWindowBounds({
      saved: null,
      displays: [PRIMARY, RIGHT_HIDPI],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(recentred).toBe(false);
    expect(bounds).toEqual({ x: 320, y: 100, width: 1280, height: 840 });
    expect(onAnyDisplay(bounds, [PRIMARY])).toBe(true);
  });

  it('treats an invalid saved box as first launch', () => {
    const { bounds } = resolveWindowBounds({
      saved: { x: NaN, y: 0, width: 0, height: 840 },
      displays: [PRIMARY],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(bounds.width).toBe(1280);
    expect(onAnyDisplay(bounds, [PRIMARY])).toBe(true);
  });

  it('shrinks the default size to fit a small-only display', () => {
    const small: DisplayLike = {
      id: 9,
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
      workArea: { x: 0, y: 0, width: 1024, height: 728 },
    };
    const { bounds } = resolveWindowBounds({
      saved: null,
      displays: [small],
      primaryDisplayId: small.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(bounds.width).toBeLessThanOrEqual(1024);
    expect(bounds.height).toBeLessThanOrEqual(728);
  });
});

describe('resolveWindowBounds — restoring a saved box', () => {
  it('restores a box on the secondary monitor unchanged when it is still connected', () => {
    const saved = { x: 2200, y: 300, width: 1400, height: 900 };
    const { bounds, recentred } = resolveWindowBounds({
      saved,
      displays: [PRIMARY, RIGHT_HIDPI],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(recentred).toBe(false);
    expect(bounds).toEqual(saved);
    expect(displayForRect(bounds, [PRIMARY, RIGHT_HIDPI])?.id).toBe(RIGHT_HIDPI.id);
  });

  it('preserves a window on a negative-coordinate LEFT monitor', () => {
    const saved = { x: -1000, y: 120, width: 1000, height: 700 };
    const { bounds, recentred } = resolveWindowBounds({
      saved,
      displays: [PRIMARY, LEFT],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(recentred).toBe(false);
    expect(bounds).toEqual(saved);
    expect(displayForRect(bounds, [PRIMARY, LEFT])?.id).toBe(LEFT.id);
  });

  it('preserves a window on a stacked-ABOVE monitor (negative y)', () => {
    const saved = { x: 200, y: -900, width: 1200, height: 800 };
    const { bounds, recentred } = resolveWindowBounds({
      saved,
      displays: [PRIMARY, TOP],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(recentred).toBe(false);
    expect(bounds).toEqual(saved);
    expect(displayForRect(bounds, [PRIMARY, TOP])?.id).toBe(TOP.id);
  });

  it('ignores DPI scale factor — placement stays in DIP (no blurriness/wrong size math)', () => {
    // A box that fits entirely on the 150% monitor must come back byte-identical;
    // multiplying by scaleFactor here would mis-size/mis-place it.
    const saved = { x: 2100, y: 200, width: 1600, height: 1000 };
    const { bounds } = resolveWindowBounds({
      saved,
      displays: [PRIMARY, RIGHT_HIDPI],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(bounds).toEqual(saved);
  });

  it('shrinks a restored box that is larger than its (now smaller) display', () => {
    const saved = { x: 10, y: 10, width: 3000, height: 2000 }; // huge, from a gone 4K monitor
    const { bounds } = resolveWindowBounds({
      saved,
      displays: [PRIMARY],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(bounds.width).toBeLessThanOrEqual(PRIMARY.workArea.width);
    expect(bounds.height).toBeLessThanOrEqual(PRIMARY.workArea.height);
    expect(onAnyDisplay(bounds, [PRIMARY])).toBe(true);
  });
});

describe('resolveWindowBounds — off-screen restore (regression)', () => {
  it('pulls a window saved on a now-disconnected monitor back onto a visible display', () => {
    // Saved on a right-hand 2560-wide monitor that is no longer connected.
    const saved = { x: 2400, y: 250, width: 1300, height: 850 };
    const { bounds, recentred } = resolveWindowBounds({
      saved,
      displays: [PRIMARY], // second monitor unplugged
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(recentred).toBe(true);
    // The window must be fully reachable — never opening invisibly.
    expect(onAnyDisplay(bounds, [PRIMARY])).toBe(true);
    expect(bounds.x).toBeGreaterThanOrEqual(PRIMARY.workArea.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      PRIMARY.workArea.x + PRIMARY.workArea.width,
    );
    expect(bounds.y).toBeGreaterThanOrEqual(PRIMARY.workArea.y);
  });

  it('recovers a window whose saved position is far off every display', () => {
    const saved = { x: 9000, y: 9000, width: 1200, height: 800 };
    const { bounds, recentred } = resolveWindowBounds({
      saved,
      displays: [PRIMARY, RIGHT_HIDPI],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(recentred).toBe(true);
    expect(onAnyDisplay(bounds, [PRIMARY, RIGHT_HIDPI])).toBe(true);
  });

  it('recovers a window dragged above the top edge', () => {
    const saved = { x: 300, y: -1000, width: 1100, height: 760 }; // top monitor unplugged
    const { bounds, recentred } = resolveWindowBounds({
      saved,
      displays: [PRIMARY],
      primaryDisplayId: PRIMARY.id,
      defaultSize: DEFAULT,
      minSize: MIN,
    });
    expect(recentred).toBe(true);
    expect(onAnyDisplay(bounds, [PRIMARY])).toBe(true);
  });
});

describe('ensureOnScreen (live display changes)', () => {
  it('returns null when the window is still reachable', () => {
    const bounds = { x: 100, y: 100, width: 1000, height: 700 };
    expect(ensureOnScreen(bounds, [PRIMARY, RIGHT_HIDPI], MIN)).toBeNull();
  });

  it('clamps a window back when its monitor is removed mid-session', () => {
    const onRight = { x: 2200, y: 300, width: 1200, height: 800 };
    const clamped = ensureOnScreen(onRight, [PRIMARY], MIN); // RIGHT unplugged
    expect(clamped).not.toBeNull();
    expect(onAnyDisplay(clamped!, [PRIMARY])).toBe(true);
  });

  it('returns null when there are no displays (nothing to clamp to)', () => {
    expect(ensureOnScreen({ x: 0, y: 0, width: 100, height: 100 }, [], MIN)).toBeNull();
  });
});

describe('fitWithin / centerWithin', () => {
  it('fitWithin slides a box fully inside the area', () => {
    const r = fitWithin({ x: 1800, y: 1000, width: 1000, height: 700 }, PRIMARY.workArea, MIN);
    expect(r.x + r.width).toBeLessThanOrEqual(PRIMARY.workArea.width);
    expect(r.y + r.height).toBeLessThanOrEqual(PRIMARY.workArea.height);
  });

  it('centerWithin clamps a too-large size to the area', () => {
    const r = centerWithin({ width: 5000, height: 5000 }, PRIMARY.workArea);
    expect(r.width).toBe(PRIMARY.workArea.width);
    expect(r.height).toBe(PRIMARY.workArea.height);
  });
});
