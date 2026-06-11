# DECISIONS — stack choices, assumptions, and deviations from the brief

Each entry: what we chose, what the brief suggested, and why. The live docs at
`https://coasty.ai/docs/llms.txt` (fetched 2026-06-11) are the source of truth for
API behavior; doc-vs-brief drift is listed at the bottom and in `SUMMARY.md`.

## D1. Desktop shell: Electron (brief preferred Tauri)
Tauri needs a Rust toolchain; the development machine has none (`cargo` absent), so a
Tauri build could never be compiled, run, or E2E-tested here — and "nothing merges
until its tests pass" outranks footprint. Electron gives us: 100% TypeScript reuse of
`packages/core` + `packages/executor` in the main process (the LocalExecutor is
plain Node), first-class Playwright `_electron` E2E, and one SPA shared with web.
The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and a
minimal preload API. A Tauri port stays straightforward because all native access is
behind the `NativeBridge` interface.

## D2. Local screen control: command-line native bridges, no native npm modules
robotjs is unmaintained and node-gyp builds are flaky on Windows; nut.js is no longer
freely licensed. Instead `LocalExecutor` talks to a `NativeBridge` interface with
per-OS implementations that shell out to built-in OS tooling:
- **Windows**: PowerShell — `System.Drawing`/`Graphics.CopyFromScreen` for capture,
  `user32!SendInput` (via `Add-Type` P/Invoke) for mouse/keyboard.
- **macOS**: `screencapture` + `osascript`/`cliclick` (best-effort, documented).
- **Linux**: `import`/`grim` + `xdotool` (best-effort, documented).
Zero native dependencies → installs never break, tests inject a fake bridge.
Trade-off: per-action latency is slightly higher than an in-process binding; fine at
agent-step cadence (seconds).

## D3. Web app: Vite + React SPA (brief suggested Next.js / React)
The product is an authenticated realtime dashboard — no SEO/SSR requirement — and the
same static bundle must run inside the Electron webview. One Vite SPA serves both,
halving the surface to test. Brief allows "Next.js / React"; we take the React half.

## D4. Persistence: `node:sqlite` behind a repository layer (brief suggested Postgres + Prisma)
Tests must pass "with no network" and a newcomer must run the stack in <10 minutes on
any OS. Prisma's engine downloads + codegen and a running Postgres conflict with
both. Node 24 ships `node:sqlite` (zero deps, synchronous, durable). All access goes
through a `Repository` interface (`apps/backend/src/db/`), so a Postgres
implementation is a contained swap for multi-instance deployments; `DEPLOYMENT.md`
covers it. Event logs get per-stream monotonic `seq` for SSE replay either way.

## D5. Realtime fan-out: SSE (not WebSocket)
Client→server traffic is plain REST; only server→client push is needed. SSE matches
Coasty's own event model (`Last-Event-ID` resume), works through proxies, needs no
extra dependency, and the reconnect story is the same one we already implement for
the upstream Coasty stream. Mobile uses a small EventSource polyfill over fetch.

## D6. Auth: single-tenant demo auth with bearer session tokens
The brief's focus is the Coasty integration and key custody, not an identity system.
`POST /api/auth/login {email}` issues an opaque, hashed-at-rest, expiring session
token (no password — it's a demo gate, stated plainly in SECURITY.md). Every other
route requires the token. The trust boundary that matters — Coasty key server-side
only — is fully enforced and tested. Pluggable: the auth layer is one Fastify hook.

## D7. Mobile verification: component tests + react-native-web E2E; Maestro flows shipped but not CI-run
No Android emulator / iOS simulator exists on this Windows dev machine, and CI
runners for mobile E2E are out of scope. The Expo app is built with
`react-native-web` compatibility, so the *same screens* are E2E-exercised in
chromium via Playwright; `.maestro/` flows are included for on-device runs and
documented in `apps/mobile/README.md`.

## D8. Push notifications: in-app via global SSE feed; OS push behind an interface
Real APNs/FCM requires store credentials and live devices. `NotificationPort` has an
in-app implementation (SSE-driven banner + badge) used everywhere and an
`ExpoPushAdapter` stub documented for production wiring. The cross-device loop
(start on laptop → see + approve on phone) works through the backend feed.

## D9. Mock server lives in `tools/mock-coasty`, standalone
It depends only on Fastify, not on `core`, so M1 could build both in parallel and a
bug in one can't hide a bug in the other. Contract tests cross-check the two against
the documented schemas.

## D10. Workflow DSL evaluator implemented client-side in `core`
The server executes workflows on Coasty's side; our evaluator mirrors the documented
semantics for: builder validation (instant feedback), dry-run cost estimates, and
the mock server's executor (mock-coasty embeds its own simpler copy — see D9). Doc
limits enforced: ≤200 steps, ≤8 depth, ≤16 branches, retry 1–20, parallel content
restrictions, reserved `save_as` names.

## D11. Versions
TypeScript 5.x `strict`, ESLint 9 flat config + typescript-eslint, Prettier 3,
Vitest 3, Playwright 1.x, Fastify 5, React 19, Vite 6, zustand 5, Electron 33+,
Expo SDK 53. Node ≥ 22.5 required (`node:sqlite`); dev machine runs Node 24.

## Assumptions (product)
- A1. Single user per backend instance (demo auth, D6); multi-user is a schema field
  away (`user_id` is already on every table).
- A2. "Email the report"-class side effects happen *inside* the controlled machine
  (the agent drives a mail client); open-cowork itself sends no email.
- A3. Live screen view = periodic screenshot frames (machine screenshot endpoint /
  local capture), not VNC video. Coasty exposes VNC ports, but frames are
  cross-platform, cheap, and sufficient for supervision. Frame cadence 1–2s while
  watching, paused when the view is hidden.
- A4. Cost display uses the documented static pricing table plus live
  `X-Credits-*` headers / `GET /v1/usage` when available.
- A5. The `.env` at repo root contained a **live** key when work started; it is
  gitignored, never read by tests, and `README.md` tells the owner to rotate it if
  it ever leaked (it was committed nowhere).

## Doc-vs-brief drift noticed (details in SUMMARY.md)
- Run resume body is `{note}`; **workflow** resume is `{approved, note}` (brief
  implied `{approved}` for runs).
- `on_awaiting_human` is a run-create option (`pause|fail|cancel`), not a webhook.
- Idempotency is an `Idempotency-Key` *header*, not a body field.
- Docs' reference table vs examples disagree on some action params (`wait`:
  `{ms}` vs `{seconds}`; `key_press`: `{key}` vs `{keys}`; `scroll`:
  `{x,y,direction,amount}` vs `{clicks}`; `drag`: `from_x…` vs `x1…`). Core types +
  executors accept both shapes; the mock emits the reference shape.
- `cua_version` allows `v1|v3|v4` (no `v2`); v4 needs professional tier.
