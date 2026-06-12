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
  with the **Cancel** button in the run view (any device: the desktop window,
  a browser, or your phone — local runs honor backend cancel via the desktop
  shell's Cancel control, which aborts the loop and mirrors a `cancelled`
  status). Closing the desktop app also aborts the run.
- While a run is active, avoid fighting the agent for the pointer; queued
  input events land on whatever is focused.
- `raw` code actions are **refused by policy** in `LocalExecutor` — the model
  cannot execute arbitrary code on your machine.
- Run tasks you'd be comfortable doing yourself while sharing your screen.

## Develop

```sh
pnpm --filter @open-cowork/desktop build      # node build.mjs → dist/main.cjs + dist/preload.cjs
pnpm --filter @open-cowork/desktop test       # vitest (LocalRunManager + build smoke)
pnpm --filter @open-cowork/desktop typecheck
```

`src/localRuns.ts` is plain dependency-injected Node code — all run
orchestration is unit-tested with a fake executor and a scripted fetch; tests
never spawn Electron.
