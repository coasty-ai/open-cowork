# @open-cowork/desktop

The Electron shell that gives open-cowork **first-class local screen control**.
It hosts the exact same SPA as `apps/web` and adds one capability the browser
cannot have: running the agent loop against *this* computer's screen, mouse,
and keyboard via `@open-cowork/executor`'s `LocalExecutor`.

## How it works

```
renderer (web SPA, sandboxed)            main process (Node)
┌─────────────────────────────┐          ┌────────────────────────────────────┐
│ window.cowork.startLocalRun ├─ IPC ───▶│ LocalRunManager                    │
│  (token read from the SPA's │          │  ├─ POST /api/local-runs           │
│   localStorage session)     │          │  ├─ POST /api/proxy/sessions       │
│                             │          │  ├─ runAgentLoop(LocalExecutor)    │
│ run timeline via backend SSE◀─ backend─┤  └─ event batches → /…/events      │
└─────────────────────────────┘          └────────────────────────────────────┘
```

- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`;
  the only native surface is the tiny `window.cowork` API from `src/preload.ts`.
- The Coasty key never leaves the backend — the desktop main process talks to
  the backend's inference proxy with the SPA's own session token, which preload
  attaches to each `startLocalRun` IPC call.
- Loop events are mirrored to the backend in small batches (every ~500 ms or
  10 events), so phones and other browsers watch a local run live, exactly
  like a cloud run. Screenshots are **never** uploaded — the timeline gets a
  one-line marker per step.

## Run it

Start the backend (with mock-coasty or a real key) and the web dev server
first, then launch the shell — all from the repo root:

```sh
pnpm dev:mock      # terminal 1 (offline Coasty mock on :4010), optional
pnpm dev:backend   # terminal 2 (REST API on :4000)
pnpm dev:web       # terminal 3 (vite dev server on :5173)
pnpm dev:desktop   # terminal 4 (builds dist/*.cjs, then electron .)
```

Sign in inside the window, then pick **“This computer (local screen)”** as the
target on the home page.

Environment overrides:

| Variable             | Default                  | Meaning                              |
| -------------------- | ------------------------ | ------------------------------------ |
| `COWORK_WEB_URL`     | `http://127.0.0.1:5173`  | URL of the SPA to load               |
| `COWORK_WEB_DIST`    | _(unset)_                | Load a built SPA from disk (E2E)     |
| `COWORK_BACKEND_URL` | `http://127.0.0.1:4000`  | Backend the local loop talks to      |

## Local-control safety note

A local run **moves your real mouse and types on your real keyboard** (on
Windows via a PowerShell `SendInput` bridge — the reference implementation;
macOS `screencapture`/`osascript` and Linux `import`/`xdotool` bridges are
best-effort). Be aware:

- There is **no mouse-to-corner abort** like some RPA tools have. Abort a run
  with the **Cancel** button from **any** device — the loop actually halts and
  every client shows `cancelled`:
  - In the **desktop window**, Cancel stops the local loop instantly via the
    `cancelLocalRun` IPC (and tells the backend).
  - From **another device** (a browser or your phone), Cancel marks the run
    cancelled in the backend; the desktop polls the run status
    (`cancelPollMs`, default 2 s) and aborts the loop within a couple of
    seconds — no IPC needed.

  Closing the desktop app also aborts the run.
- While a run is active, avoid fighting the agent for the pointer; queued
  input events land on whatever is focused.
- `raw` code actions are **refused by policy** in `LocalExecutor` — the model
  cannot execute arbitrary code on your machine.
- Run tasks you'd be comfortable doing yourself while sharing your screen.

## Multi-monitor window placement

The window reopens **where you last closed it, on the monitor it was on** —
not forced onto the primary display. The placement logic lives in two
Electron-free, fully unit-tested modules so the tricky geometry is covered
without spawning a window:

- `src/windowBounds.ts` — pure DIP geometry: which display a box belongs to,
  whether its title bar is still grabbable, and how to pull an off-screen box
  back onto a connected display. All math is in **device-independent pixels**
  (never multiplied by `scaleFactor`), which is what keeps mixed-DPI setups
  (e.g. 100% + 150%) crisp and correctly sized.
- `src/windowState.ts` — best-effort JSON persistence of the last bounds +
  maximized/fullscreen flags in `userData/window-state.json`.

`main.ts` restores on launch, re-maximizes/fullscreens on the right monitor,
debounce-saves on move/resize/close, and re-clamps free-floating windows when
the display arrangement changes at runtime (`screen` `display-removed` /
`display-added` / `display-metrics-changed`).

### Manual multi-monitor checklist

Unit tests cover the geometry; these verify the real Electron wiring on actual
hardware (a laptop + one external monitor is enough for most rows):

1. **Reopen on the same monitor** — move the window to the secondary monitor,
   quit, relaunch → it reopens there at the same size/position.
2. **Mixed DPI** — with monitors at different scaling (e.g. 100% + 150%), move
   the window to each and relaunch → crisp text, correct size, no half-size or
   blurry window on the scaled display.
3. **Negative-coordinate monitor** — arrange a monitor to the left/above the
   primary (negative origin), place the window there, relaunch → it returns
   there (not the primary).
4. **Off-screen restore (the common failure)** — place the window on the
   secondary monitor, quit, **unplug the secondary**, relaunch → the window
   appears fully on the primary, never invisibly off-screen. (Regression-tested
   in `windowBounds.test.ts`.)
5. **Unplug while running** — with the window on the secondary monitor, unplug
   it mid-session → the window jumps back onto a connected display and stays
   grabbable.
6. **Rearrange while running** — swap the monitor arrangement in OS display
   settings → the window stays reachable.
7. **Maximize / fullscreen** — maximize (or fullscreen) on the secondary
   monitor, quit, relaunch → it restores maximized/fullscreen **on that
   monitor**, not the primary.
8. **Second-instance focus** — launch a second copy → the existing window
   focuses/restores on its current monitor (does not spawn a window elsewhere).

## Develop

```sh
pnpm --filter @open-cowork/desktop build      # node build.mjs → dist/main.cjs + dist/preload.cjs
pnpm --filter @open-cowork/desktop test       # vitest (LocalRunManager + build smoke)
pnpm --filter @open-cowork/desktop typecheck
```

`src/localRuns.ts` is plain dependency-injected Node code — all run
orchestration is unit-tested with a fake executor and a scripted fetch; tests
never spawn Electron. `src/windowBounds.ts` and `src/windowState.ts` are the
same way: pure logic + JSON I/O, exhaustively tested without Electron.
