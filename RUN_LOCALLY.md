# Running open-cowork on your own PC (local automation)

This guide is for the thing you actually want: **let the agent see and control
_your_ computer** — open apps, click around, type, rename files, fill forms —
while you watch and can stop it anytime.

Only the **desktop app** can do this. Web and mobile drive a cloud machine
instead (they have no access to your local screen). On the desktop, local
screen control runs entirely on your machine: it screenshots your screen, asks
Coasty what to do, and moves your real mouse/keyboard. **Your Coasty key never
leaves the backend** — the desktop gets each step through the local backend
proxy.

> ⚠️ **Read this first.** The agent moves your **real** mouse and keyboard.
> There is no "mouse to a corner" panic button — **stop a run with the Cancel
> button in the window (or just close the window)**. Start with narrow,
> low-stakes tasks on a screen that can't reach anything destructive.

---

## 1. Prerequisites

- **Node ≥ 22.5** (we use 24) and **pnpm 10** (`corepack enable`).
- **Windows** is the reference platform — local control works out of the box
  (PowerShell + built-in APIs, no extra installs).
- **macOS**: grant the terminal/app **Screen Recording** and **Accessibility**
  permissions (System Settings → Privacy & Security). Install `cliclick`
  (`brew install cliclick`).
- **Linux (X11)**: install `xdotool` and ImageMagick (`import`).

```bash
git clone https://github.com/coasty-ai/open-cowork.git && cd open-cowork
pnpm install
```

## 2. Get a key (free, real automation)

Real automation needs a real model. Use a **sandbox key** — it runs the full
real Coasty model but **never bills**:

1. Create a key at <https://coasty.ai/developers/keys>.
2. Put it in `.env` at the repo root:

```bash
COASTY_API_KEY=sk-coasty-test-xxxxxxxx   # sandbox: real predictions, $0
```

> Demo mode (no key) also runs, but the bundled mock returns canned clicks — it
> proves the pipeline, it won't intelligently do your task. For real local
> automation, set a key. A **live** key (`sk-coasty-live-…`) also works and
> bills per step ($0.05); the app shows a cost estimate and enforces caps first.

## 3. Run it (two terminals)

```bash
# Terminal A — backend + web (the desktop loads the web UI from :5173,
# and talks to the backend on :4000; the Coasty key lives only here)
pnpm dev

# Terminal B — the desktop app (builds the Electron bundles, then launches)
pnpm dev:desktop
```

`pnpm dev` skips the mock automatically when a real key is set and points the
backend at the real Coasty API.

## 4. Delegate a task to your own screen

In the desktop window:

1. **Sign in** with any email (demo gate — see `SECURITY.md`).
2. In the delegate box, the machine selector now has **“This computer (local
   screen)”** as the first option. Pick it.
3. Type a task, e.g. *“Open the calculator and compute 42 × 17”* or *“In the
   open folder, rename every screenshot to start with 2026-”*.
4. **Confirm** the dialog — it warns you it will control your real mouse and
   keyboard — then watch the live timeline as it works. Hit **Cancel** anytime.

That's it. You can also watch/cancel the same local run from the web app or your
phone (see *Cross-device* below) — local runs are mirrored to the backend.

## 5. What happens under the hood

```text
Desktop (Electron main process)
  └─ LocalRunManager runs the shared agent loop:
       screenshot your screen  ──► backend /api/proxy/sessions/:id/predict ──► Coasty
       ◄── ordered actions (click/type/scroll/…)
       execute on your real mouse/keyboard (PowerShell SendInput / cliclick / xdotool)
       repeat until done / fail / 25-step cap / you cancel
  └─ mirrors every step to the backend (/api/local-runs) so any device can supervise
```

The renderer is sandboxed (`contextIsolation` on, no Node); the key stays in the
backend; raw model-generated code is refused on every target.

## 6. Safety & good habits

- **Stop button is your friend.** Cancel in the UI (or close the window). The
  loop also self-aborts after 3 consecutive failed actions and at the 25-step
  cap.
- **Scope tightly.** Prefer specific tasks over open-ended ones. Don't point it
  at banking, email-send, or anything irreversible on the first try.
- **Approvals.** For sensitive steps, phrase the task to pause (the agent emits
  an awaiting-human step you approve), or use a workflow with a
  `human_approval` step.
- **Coordinates/DPI.** The bridge handles display scaling automatically
  (model-space → screen-space). If clicks land slightly off, it's almost always
  a multi-monitor/scaling edge case — run on the primary display.

## 7. Cross-device: start on your PC, approve from your phone

1. Make the backend reachable on your LAN: run it on `0.0.0.0` (set
   `COWORK_HOST=0.0.0.0` in `.env`) behind your machine's IP.
2. On the phone, set `EXPO_PUBLIC_BACKEND_URL=http://<your-pc-ip>:4000` and run
   `pnpm dev:mobile` (or `pnpm --filter @open-cowork/mobile web`).
3. A local run started on your PC shows up on the phone; when it pauses for
   approval, approve it there. (OS push is stubbed; the in-app banner works via
   polling — see `DECISIONS.md` D8.)

## 8. Repeating / scheduled automation

For "run this every morning" style automation, two paths:

- **Now (manual/cron):** trigger a run via the backend API on a schedule. With
  the desktop app open, you can re-run a saved task; for headless scheduling,
  POST to `/api/runs` (cloud machine) or script the local path (below).
- **Coasty Schedules API** (cron/preset cadence, webhook/email triggers) is
  documented in the Coasty docs; it targets a cloud machine, not your local
  screen. open-cowork focuses runs/workflows/machines — see `SUMMARY.md`.

### Scripting local automation without the UI (advanced)

The desktop UI is the supported path, but the pieces are reusable. `core`'s
`runAgentLoop` + `executor`'s `LocalExecutor` drive your screen directly:

```ts
import { runAgentLoop, CoastyClient } from '@open-cowork/core';
import { LocalExecutor, createNativeBridge } from '@open-cowork/executor';

const coasty = new CoastyClient({
  baseUrl: 'https://coasty.ai/v1',
  apiKey: process.env.COASTY_API_KEY!, // sandbox key recommended
});
const session = await coasty.createSession({ screen_width: 1280, screen_height: 720 });
const screen = new LocalExecutor({ bridge: createNativeBridge() }); // PowerShell on Windows

const outcome = await runAgentLoop({
  screen,
  task: 'Open Notepad and type a haiku',
  maxSteps: 15,
  predictStep: (i) =>
    coasty.sessionPredict(session.session_id, { screenshot: i.screenshotB64, instruction: i.instruction }),
});
console.log(outcome.status, outcome.stepsUsed);
await coasty.deleteSession(session.session_id);
```

> In a standalone script the Coasty key is in *your* process — fine for personal
> use on your own machine. The desktop app keeps it server-side instead.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| It clicks but doesn't "understand" the task | You're in demo mode (mock). Set a real/sandbox `COASTY_API_KEY` in `.env` and restart. |
| "This computer (local screen)" isn't offered | You're in the web app, not the desktop shell. Use `pnpm dev:desktop`. |
| Desktop window is blank | Make sure `pnpm dev` (web on :5173, backend on :4000) is running first. |
| macOS: nothing happens / black screenshot | Grant Screen Recording + Accessibility to your terminal/app; install `cliclick`. |
| Linux: capture/click fails | Install `xdotool` + ImageMagick; X11 session (not Wayland). |
| Want to confirm capture works | `COWORK_NATIVE_SMOKE=1 pnpm --filter @open-cowork/executor exec vitest run windowsBridge` (capture only, never moves the mouse). |
| "Could not create run" / validation errors | The UI now shows the exact code + request id. Sandbox/live keys need a reachable Coasty API; see `SECURITY.md` / `DEPLOYMENT.md`. |

See also: [README](README.md) · [ARCHITECTURE](ARCHITECTURE.md) ·
[apps/desktop/README](apps/desktop/README.md) · [COOKBOOK](COOKBOOK.md) ·
[SECURITY](SECURITY.md).
