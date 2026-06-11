# PLAN — open-cowork

A cross-platform agentic coworker on the Coasty Computer Use API. This plan pins the
monorepo layout, the inter-package contracts, the milestone order, and the test
strategy. `DECISIONS.md` records stack choices and assumptions.

## Monorepo layout

```
open-cowork/
├── packages/
│   ├── core/          # framework-agnostic: Coasty client, agent loop, workflow DSL
│   │                  # evaluator, cost estimator, retry/backoff, HMAC, shared types.
│   │                  # Zero runtime deps; isomorphic (Node + browser). No UI imports.
│   ├── executor/      # Executor interface + LocalExecutor (desktop native bridge),
│   │                  # RemoteMachineExecutor (Coasty machines), BrowserExecutor (Playwright).
│   └── ui/            # shared React component library + design tokens (web/desktop/RN-web).
├── apps/
│   ├── backend/       # Fastify: auth, Coasty proxy, webhook receiver (HMAC), SQLite
│   │                  # persistence, SSE fan-out, budget enforcement. ONLY holder of the key.
│   ├── web/           # Vite + React SPA (also hosted by the desktop webview).
│   ├── desktop/       # Electron shell: hosts the SPA + runs LocalExecutor in main process.
│   └── mobile/        # Expo / React Native (verified via react-native-web + Maestro flows).
├── tools/
│   └── mock-coasty/   # offline mock of the full Coasty API: REST + SSE + signed webhooks.
├── e2e/               # Playwright E2E (web + desktop) against mock-coasty + backend.
└── .github/workflows/ # CI: lint + typecheck + unit + integration on push; E2E on PR.
```

## Hard rules (from the brief + live docs)

1. `COASTY_API_KEY` exists **only** in `apps/backend` env. Clients authenticate to the
   backend with short-lived session tokens. A security test asserts no `sk-coasty-`
   string or webhook secret appears in any client bundle.
2. All automated tests run against `tools/mock-coasty` (offline) or sandbox
   `sk-coasty-test-*` keys (gated behind `COWORK_RUN_LIVE=1`). Nothing ever bills.
3. Any billable action (start run, provision machine) returns a server-computed cost
   estimate first and requires the client to echo `confirmCostCents`; the backend
   enforces wallet/budget caps server-side.
4. Executor abstraction: one shared agent loop in `core`, three executors in
   `executor` (local / remote machine / browser). Desktop = LocalExecutor; web/mobile
   = RemoteMachineExecutor via backend.

## Coasty surface (source of truth: docs/llms.txt fetched 2026-06-11)

- Base `https://coasty.ai/v1`, auth `X-API-Key` or `Authorization: Bearer`.
- Inference: `POST /predict` (5cr), `POST /sessions` (10cr) + `/sessions/{id}/predict`
  (4cr) + reset/get/list/delete (free), `POST /ground` (3cr), `POST /parse` (free).
  Surcharges: +2cr/trajectory image, +1cr/HD image (w>1280 or h>720 strictly),
  +3cr v1 engine, +1cr system_prompt >500 chars.
- Runs: `POST /runs` (Idempotency-Key header; one-time `webhook_secret` when
  webhook_url present), `GET /runs[/{id}]`, `POST /runs/{id}/cancel`,
  `POST /runs/{id}/resume {note}`, `GET /runs/{id}/events` SSE with `Last-Event-ID`
  / `?after=` replay. States: queued → running ↔ awaiting_human → succeeded | failed
  | cancelled | timed_out. Steps bill 5cr (v3/v4) or 8cr (v1).
- Webhooks: `Coasty-Signature: t=<unix>,v1=<hex>`; HMAC-SHA256 over `"<t>." + raw_body`
  with the per-run `webhook_secret`; constant-time compare + 5-minute tolerance.
  Events: run.awaiting_human / run.succeeded / run.failed / run.cancelled / run.timed_out.
- Workflows: DSL version `2026-06-01`. 9 step types (task, assert, if, loop, parallel,
  human_approval, retry, succeed, fail); 13 condition ops (eq ne lt gt lte gte contains
  truthy falsy exists and or not); `{{inputs.x}}` / `{{vars.y}}` / `{{stepId.field}}`
  templating; guards budget_cents / max_iterations / deadline_seconds; limits: ≤200
  steps, ≤8 nesting, ≤16 parallel branches, retry 1–20, no human_approval/succeed/fail
  inside parallel, save_as ∉ {inputs, vars}. Resume body `{approved, note}`.
- Machines: provision/list/get/start/stop/restart/terminate/PATCH ttl_minutes/
  snapshot(1cr)/screenshot/connection/actions/actions-batch/browser/{op}/terminal/
  files/{op}; `GET /machines/pricing`. Linux $0.05/hr, Windows $0.09/hr, stopped
  $0.01/hr; $0.20 wallet gate to provision. Test keys → instant `mch_test_*` mocks.
- Errors: `{error:{code,message,type,request_id,suggestion,docs_url,...}}`. Retry
  `UPSTREAM_TIMEOUT`/`UPSTREAM_UNAVAILABLE` honoring Retry-After; 402
  INSUFFICIENT_CREDITS / WALLET_EXHAUSTED; 403 INSUFFICIENT_SCOPE (required_scope);
  409 state errors; 422 validation.

## Package contracts

### packages/core (`@open-cowork/core`) — zero runtime deps, isomorphic

- `types.ts` — every Coasty request/response type, run/workflow/machine objects,
  event types, error envelope, action types (defensive: `wait` accepts `ms` or
  `seconds`; `key_press` accepts `key` or `keys`).
- `client.ts` — `CoastyClient` (fetch-injectable): typed methods for every endpoint,
  timeouts, retry with exponential backoff + full jitter on 429/5xx/network honoring
  `Retry-After`, error mapping to `CoastyApiError` (carries code/request_id/status),
  Idempotency-Key support, SSE event-stream reader with Last-Event-ID resume
  (`streamRunEvents`, `streamWorkflowRunEvents` as AsyncIterables).
- `agentLoop.ts` — `runAgentLoop({executor, predict, task, maxSteps, onEvent, signal,
  settle})`: screenshot → predict → execute actions → repeat until done/fail/cap;
  emits structured events; supports cancellation via AbortSignal; coordinate-space
  scaling stays inside the executor.
- `workflow/evaluator.ts` — full client-side DSL evaluator mirroring the server
  semantics (validation limits, condition ops, templating, guards, human_approval
  pause points) used for offline validation, dry-run cost estimation, and the
  builder UI; `workflow/validate.ts` — structural validator returning typed issues.
- `cost.ts` — cost estimator: per-endpoint pricing table from the docs, surcharge
  rules, run/workflow/machine-runtime estimators returning cents.
- `webhook.ts` — `signWebhook` / `verifyWebhookSignature` using Web Crypto
  (HMAC-SHA256, constant-time compare, timestamp tolerance, default 300s).
- `retry.ts` — generic `withRetry` (exp backoff, full jitter, Retry-After, max
  attempts, retryable predicate). `errors.ts` — error classes + mapping.
- `sse.ts` — minimal SSE parser over fetch ReadableStream (id/event/data framing,
  multi-line data, comment lines, reconnect cursor).

### tools/mock-coasty (`@open-cowork/mock-coasty`) — Fastify

Implements the documented API offline: predict/sessions/ground/parse with canned
deterministic scripts (instruction keywords drive `continue/done/fail`), runs with a
simulated stepper (timers; configurable speed), durable in-memory event logs with seq
+ SSE replay via Last-Event-ID, awaiting_human + resume + cancel, HMAC-signed webhook
delivery to webhook_url, workflows (validate + execute DSL incl. human_approval),
machines (instant `mch_test_*`, screenshot returns a generated PNG, actions/terminal/
files/browser stubs), usage/wallet with credit accounting that matches the pricing
table, full error envelope + catalog semantics (401/402/403/404/409/422), and
`X-Coasty-*` headers. Exports `createMockCoasty()` for in-process tests + a CLI
(`PORT=4010`). Test-mode keys `sk-coasty-test-*` charge 0; a configurable wallet lets
tests exercise 402/WALLET_EXHAUSTED.

### packages/executor (`@open-cowork/executor`)

```ts
interface Executor {
  readonly kind: 'local' | 'remote-machine' | 'browser'
  screenshot(): Promise<{ base64: string; width: number; height: number }>
  execute(action: CuaAction): Promise<void>
  dimensions(): Promise<{ width: number; height: number }>
  dispose(): Promise<void>
}
```

- `RemoteMachineExecutor` — drives a Coasty machine through an injected transport
  (the backend proxy client or a CoastyClient): GET screenshot, POST actions.
- `LocalExecutor` — native bridge interface (`NativeBridge`) with a Windows
  PowerShell implementation (System.Drawing capture + SendInput/SendKeys) and
  best-effort macOS (screencapture/osascript) and Linux (import/xdotool) bridges;
  coordinate scaling between capture size and model size; unit-tested via a fake
  bridge.
- `BrowserExecutor` — Playwright `Page` adapter (optional peer dep, type-only import).

### apps/backend (`@open-cowork/backend`) — Fastify + node:sqlite

Env: `COASTY_API_KEY`, `COASTY_BASE_URL` (mock in dev/test), `COWORK_PORT`,
`COWORK_DB_PATH`, `COWORK_SESSION_SECRET`, `COWORK_PUBLIC_URL`,
`COWORK_DEFAULT_BUDGET_CENTS`.

REST (all under `/api`, bearer session-token auth):
- `POST /api/auth/login {email}` → `{token, user}` (single-tenant demo auth; see SECURITY.md)
- `GET /api/me`, `GET /api/wallet` (proxied `/v1/usage` + local budget state)
- `POST /api/estimate` `{kind: 'run'|'machine'|'workflow', params}` → `{cents, breakdown}`
- Runs: `POST /api/runs {machineId, task, cuaVersion?, maxSteps?, budgetCents?,
  confirmCostCents}` (server re-computes estimate; mismatch → 409 ESTIMATE_CHANGED;
  budget enforced) · `GET /api/runs[/{id}]` · `POST /api/runs/{id}/cancel` ·
  `POST /api/runs/{id}/resume {note}` · `GET /api/runs/{id}/events` (SSE; replays
  from DB then live; Last-Event-ID)
- Local runs (desktop-executed): `POST /api/local-runs` · `POST
  /api/local-runs/{id}/events` (batch append from desktop) · `PATCH
  /api/local-runs/{id}` (status) — so phones can watch/approve desktop work.
- Workflows: CRUD + `POST /api/workflows/{id}/runs`, `POST /api/workflows/runs`
  (ad-hoc), `GET /api/workflows/runs/{id}`, cancel, `resume {approved, note}`,
  events SSE. Definitions validated with core's validator before proxying.
- Machines: `GET/POST /api/machines` (POST requires confirmCostCents ≥ first-hour
  estimate), start/stop/terminate/snapshot, `GET /api/machines/{id}/screenshot`,
  `GET /api/machines/pricing`, `POST /api/machines/{id}/actions` (allowlisted).
- Inference proxy (for desktop local loop): `POST /api/proxy/sessions`,
  `POST /api/proxy/sessions/{id}/predict`, `DELETE /api/proxy/sessions/{id}` —
  authenticated, rate-limited, never exposes the key.
- Global stream: `GET /api/events` (SSE) — per-user feed of run/workflow/machine
  status transitions, awaiting-human notifications, billing updates.
- Webhook receiver: `POST /webhooks/coasty` — raw-body HMAC verify against the
  per-run/per-workflow-run secret (looked up by payload id), constant-time, 5-min
  tolerance; idempotent event ingestion; fan-out to `/api/events` subscribers.

Internals: repository layer over `node:sqlite` (users, sessions, runs, workflow runs,
machines cache, events with per-stream seq, webhook secrets, budgets); Coasty SSE
ingestor per active run (reconnects with Last-Event-ID); budget service; estimate
service (uses core cost estimator).

### packages/ui (`@open-cowork/ui`)

Design tokens (colors/spacing/typography, dark-first), primitives (Button, Card,
Badge, Spinner, Modal, Field, CodeBlock), domain components (RunStatusBadge,
EventTimeline, CostPill, ScreenView (renders base64 frames), ApprovalBar,
WorkflowStepTree, MachineCard, WalletCard). Accessible roles/labels; RTL tests for
loading/error/empty states.

### apps/web — Vite + React SPA

Routes: `/login`, `/` (delegate chat + recent runs), `/runs`, `/runs/:id` (live
timeline + screen view + cancel/resume/takeover), `/workflows`, `/workflows/:id`
(DSL editor w/ validation + run + monitor + approve), `/machines`, `/settings`.
State: lightweight store (zustand) + SSE hooks with auto-reconnect + offline
indicator; cost-confirm dialogs before billable actions; error boundaries;
responsive to 360px.

### apps/desktop — Electron

Main process: loads the web SPA (dev server or built assets), exposes IPC
`cowork:local-run` that runs core's agent loop with `LocalExecutor`, streaming
events to the renderer and mirroring them to the backend (local-runs API). Preload
with contextIsolation; no nodeIntegration in renderer. Renderer adds a "Local
machine" target in the delegate UI (via `window.cowork.platform`).

### apps/mobile — Expo / React Native

Screens: Login, Runs list, Run detail (timeline + screen frames + approve/reject +
resume), Workflow runs (view + approve), Machines (list/start/stop), Wallet.
In-app notification banner driven by the global SSE feed (polyfilled EventSource);
Maestro flow files under `apps/mobile/.maestro/` (run on emulator); CI-verifiable
via react-native-web export. Push notifications stubbed behind an interface
(Expo Notifications adapter documented, not exercised in tests).

## Milestones (vertical slice first)

- **M0** Root scaffolding (pnpm + turbo + ts strict + eslint + prettier + vitest),
  all package.json manifests pinned, single root install. Tree compiles empty.
- **M1** `core` + `mock-coasty` in parallel, both fully unit-tested (loop, DSL,
  cost, HMAC vectors, retry, SSE parser; mock: endpoint semantics + SSE replay +
  signed webhooks). Contract tests: core client requests vs documented schemas.
- **M2** `backend` (against mock-coasty: proxy, persistence, webhook verify,
  SSE fan-out, budget caps — integration-tested) + `executor` in parallel.
- **M3** `ui` + `web`; vertical slice E2E green: login → delegate task on a cloud
  machine → live events → awaiting_human → approve → completed with cost summary.
- **M4** `desktop` (Electron + LocalExecutor, E2E via Playwright _electron) +
  `mobile` (Expo; component tests + RN-web flow) in parallel.
- **M5** Security tests (no secret in client bundles), SSE-reconnect + HMAC vector
  suites, GitHub Actions CI, full-tree green run.
- **M6** Docs (README/ARCHITECTURE/SECURITY/DEPLOYMENT/COOKBOOK/CONTRIBUTING/
  per-app) + SUMMARY.md with coverage + platform matrix.

## Test strategy

- **Unit (vitest)**: every core function deterministic + offline; fake timers for
  backoff; Web-Crypto HMAC vectors (valid / tampered body / stale t / future t /
  malformed header); DSL evaluator table tests incl. limits + guards; cost estimator
  vs the documented pricing table; SSE parser framing edge cases.
- **Contract**: a recording fetch asserts outbound paths/headers/bodies against the
  documented schemas (cua_version enum, Idempotency-Key, condition op set,
  on_awaiting_human enum, machine fields).
- **Integration (vitest)**: backend ↔ in-process mock-coasty: run lifecycle incl.
  awaiting_human→resume, webhook ingestion (valid/tampered/stale), SSE fan-out with
  reconnect via Last-Event-ID, budget refusal paths (402 mapping, cap exceeded,
  estimate drift), machine lifecycle + screenshot proxy.
- **UI (RTL + jsdom)**: primitives + domain components: loading/error/empty,
  roles/names, approval interactions.
- **E2E (Playwright)**: web (chromium) + desktop (_electron): full delegate → watch
  → approve → complete → cost summary against mock-coasty; SSE drop/reconnect.
  Mobile: Maestro flows included (emulator required, documented), plus the same
  user journey exercised through react-native-web in chromium.
- **Security**: build all client bundles, scan for `sk-coasty-`, webhook secrets,
  `COASTY_API_KEY` strings; assert backend never logs the key; `pnpm audit` in CI
  (non-blocking warn).
- **Live smoke (optional)**: `COWORK_RUN_LIVE=1` + `sk-coasty-test-*` key → tiny
  predict/parse/machine-provision smoke, skipped cleanly when unset.

## Runner targets

Root: `pnpm dev:backend|web|desktop|mobile|mock`, `pnpm test`, `pnpm test:unit`,
`pnpm test:integration`, `pnpm e2e`, `pnpm lint`, `pnpm typecheck`, `pnpm build`,
`pnpm security:scan`. Turbo pipelines wire dependencies (`build` → `^build`).

## Ports

mock-coasty 4010 · backend 4000 · web dev 5173 / preview 4173 · desktop loads web.
