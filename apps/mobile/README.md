# @open-cowork/mobile

Expo / React Native companion app: monitor runs, watch the cloud-machine
screen, approve `awaiting_human` steps, and check the wallet from your phone.
It talks **only** to `apps/backend` with a short-lived session token — the
Coasty API key never reaches the device.

## Screens

| Screen        | What it does |
| ------------- | ------------ |
| Login         | `POST /api/auth/login {email}` → session token (module-level store + auth context) |
| Runs          | list with status chips, pull-to-refresh, 5s polling; awaiting-approval banner |
| Run detail    | status + task, live screen frames (machine screenshot every 2s while a cloud run is running), append-only event timeline via `GET /api/runs/:id/events.json?after=N`, approve (resume + note) / reject (cancel), cancel, final cost |
| Workflow runs | list + detail-lite with approve/reject (`POST /api/workflows/runs/:id/resume {approved, note}`) |
| Machines      | list with status, start/stop |
| Wallet        | Coasty balance + month spend, sign out |

Navigation is a tiny state-based navigator (bottom tab bar + a stack-ish run
detail overlay) — no react-navigation dependency.

## Run it

From the repo root (backend on port 4000; use `tools/mock-coasty` on 4010 for
a fully offline stack):

```sh
pnpm dev:mock      # terminal 1 (optional, offline Coasty)
pnpm dev:backend   # terminal 2
pnpm --filter @open-cowork/mobile dev   # terminal 3 → Expo
```

- **Expo Go (device/emulator):** scan the QR code. The phone must reach your
  backend — set `EXPO_PUBLIC_BACKEND_URL` first, e.g.
  - Android emulator: `EXPO_PUBLIC_BACKEND_URL=http://10.0.2.2:4000`
  - real device: `EXPO_PUBLIC_BACKEND_URL=http://<your-LAN-IP>:4000`
- **Web (react-native-web):** `pnpm --filter @open-cowork/mobile web` — the
  same components render in the browser (default backend
  `http://127.0.0.1:4000`).

`EXPO_PUBLIC_BACKEND_URL` is inlined by Expo at bundle time (see
`src/config.ts`); restart `expo start` after changing it.

## How this app is verified (DECISIONS.md D7)

No Android emulator / iOS simulator exists on the dev machine or in CI, so:

1. **Component tests (CI):** `pnpm --filter @open-cowork/mobile test` runs
   vitest + jsdom + @testing-library/react with `react-native` aliased to
   `react-native-web` (`vitest.config.ts`). The exact screens that ship to
   phones — Login, Runs, RunDetail (cursor polling with fake timers, approval
   flow, cancel, cost line), WorkflowRuns, Machines, Wallet, and the App shell
   navigator — are exercised as DOM, including loading/error/empty states.
2. **Maestro flows (on-device, manual):** `.maestro/login.yaml` and
   `.maestro/approve-run.yaml` script the same journeys for an emulator with
   Expo Go (`appId: host.exp.exponent`; change it for a dev build):
   `maestro test .maestro/approve-run.yaml`.

## Notifications: in-app banner, OS push stubbed (DECISIONS.md D8)

While the Runs screen polls `GET /api/runs` (every 5s), any run in
`awaiting_human` raises a top banner — “A run needs your approval” — that
links straight to the run's approval bar. Real APNs/FCM push is **stubbed by
design**: it requires store credentials, signed builds, and live devices,
none of which exist in this offline-testable repo. The documented production
wiring is an `ExpoPushAdapter` behind the same notification port (subscribe
to the backend's `GET /api/events` feed server-side and fan out via
`expo-notifications`); the cross-device loop (start on laptop → approve on
phone) already works through backend polling without it.

## Notes

- Event timeline uses the REST polling fallback
  (`/api/runs/:id/events.json?after=N`) instead of SSE: React Native's fetch
  has no streaming response bodies; the `after` cursor makes the timeline
  append-only and reconnect-safe.
- Screens never import `expo` — only `index.ts` does
  (`registerRootComponent`) — so the whole tree stays importable in vitest.
- Styling uses plain RN primitives + `StyleSheet` with the dark palette from
  `packages/ui` tokens (`src/theme.ts`); `@open-cowork/ui` itself is
  DOM-based and intentionally not imported here.
