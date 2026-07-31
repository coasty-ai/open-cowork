# ARCHITECTURE

How open-cowork is put together, and why. Companion docs: `DECISIONS.md`
(choices + trade-offs), `SECURITY.md` (trust boundaries), `PLAN.md` (original
build plan and package contracts).

## The two hard truths the design hangs on

**1. Local vs remote execution.** Only the desktop app can capture and control
the user's *own* screen; web and mobile drive a Coasty cloud machine instead.
This is modeled as one `Executor` interface with three implementations behind a
single shared agent loop — the rest of the product never cares which screen it
is driving.

There is a fourth way to get a screen that bypasses the executor entirely:
a **managed task** (`POST /v1/tasks`), where Coasty provisions, drives, and
destroys an ephemeral machine server-side. It produces the same durable `Run`
object as a cloud run, so the timeline, approvals UI, cancel, and cost plumbing
all work on it unchanged — see *Managed tasks* below.

**2. The API key never touches a client.** All clients speak to the
open-cowork backend, which is the only holder of `COASTY_API_KEY` and of every
per-run `webhook_secret`. Clients hold short-lived session tokens.

## Component map

```text
                       ┌────────────────────────────────────────────┐
                       │                 Coasty API                  │
                       │  /predict /sessions /runs /workflows        │
                       │  /machines  · SSE events · HMAC webhooks    │
                       └────────▲───────────────────────┬───────────┘
                                │ X-API-Key (backend only)│ webhooks (HMAC)
┌──────────────┐       ┌────────┴───────────────────────▼───────────┐
│ apps/desktop │ IPC   │              apps/backend (Fastify)         │
│  Electron    ├──────►│  auth (bearer tokens) · Coasty proxy        │
│  main proc:  │ local │  estimates + confirmCostCents + budget caps │
│  LocalRun-   │ runs  │  Ingestor: Coasty SSE → events table → bus  │
│  Manager     │ mirror│  webhook receiver (verify before mutate)    │
│  + Local-    │       │  SQLite (node:sqlite) · SSE fan-out         │
│  Executor    │       └────────▲───────────────▲────────────────────┘
└──────▲───────┘                │ REST + SSE     │ REST + polling
       │ hosts                  │                │
┌──────┴───────┐        ┌───────┴──────┐  ┌──────┴───────┐
│ webview:     │        │  apps/web    │  │ apps/mobile  │
│ the same SPA │        │  Vite+React  │  │ Expo / RN    │
└──────────────┘        └──────────────┘  └──────────────┘
         shared: packages/core · packages/executor · packages/ui
```

## packages/core — the framework-agnostic heart

Zero runtime dependencies, isomorphic (Node + browser): injectable `fetch`,
Web Crypto for HMAC, injectable clocks/sleeps for deterministic tests.

- **`CoastyClient`** — typed methods for every documented endpoint. Transport
  policy: timeouts compose with caller signals; retries use exponential backoff
  with full jitter and honor `Retry-After`; **GET/DELETE retry by default, POST
  retries only when an `Idempotency-Key` was provided** (a retried unkeyed POST
  could double-bill). Errors map to `CoastyApiError` carrying `code`,
  `request_id`, and code-specific extras.
- **`runAgentLoop`** — screenshot → predict → execute → repeat until
  done/fail/cap/abort. Takes an `AgentScreen` (what executors implement) and a
  `PredictStepFn`, so predictions can come from a raw Coasty session *or* the
  backend proxy. Emits structured events; tolerates up to 3 consecutive
  action-execution failures; cooperative cancellation via `AbortSignal`.
- **Workflow DSL** — validator enforcing every documented limit (≤200 steps,
  ≤8 nesting, ≤16 parallel branches, retry 1–20, no approvals inside parallel,
  reserved `save_as` names), the 13-op condition evaluator, `{{path}}`
  templating, and a deterministic executor with `budget_cents` /
  `max_iterations` / `deadline_seconds` guards — used for builder feedback,
  dry-run estimates, and cross-checking the server.
- **Cost estimator** — mirrors the documented pricing table exactly (including
  the strict HD boundary: 1280×720 is *not* HD) and computes run/workflow/task
  worst-case estimates the backend uses for the confirmation handshake.
  `taskEstimateCents` is separate from `runEstimateCents` because a task bills
  **two** meters — agent steps *and* ephemeral machine runtime — and rounds the
  runtime component **up**, since a quoted ceiling must never be exceeded.
- **Action policy** — `validateActionPolicy` mirrors every documented limit of
  the fail-closed `action_policy` control (allow/deny overlap, ≤128 name lists,
  `esc`↔`escape` aliasing, `max_actions` 1–10000, the *inclusive* coordinate
  rectangle) so a bad policy is caught before a billable round-trip.
  `canonicalizeActionPolicy` gives a stable hashable form for the client audit
  log — necessary because responses never echo the normalized policy back.
- **Webhook HMAC** — sign/verify `t=<unix>,v1=<hex>` over `"<t>.<body>"`,
  constant-time byte comparison, ±300s tolerance both directions, multiple
  `v1` entries accepted (rotation).
- **SSE** — a spec-correct parser plus reconnecting event streams that resume
  via `Last-Event-ID` with overlap de-duplication.

## packages/executor — one loop, three screens

```ts
interface Executor extends AgentScreen {
  kind: 'local' | 'remote-machine' | 'browser';
  screenshot(): Promise<{ base64; width; height }>;
  execute(action: CuaAction): Promise<void>;
  dimensions(): Promise<{ width; height }>;
  dispose(): Promise<void>;
}
```

- **RemoteMachineExecutor** maps canonical actions onto the documented machine
  endpoints (`GET /machines/{id}/screenshot`, `POST /machines/{id}/actions`)
  through an injected transport — `CoastyClient` on the backend, a thin proxy
  client elsewhere. `wait` sleeps locally; `raw` code execution is refused by
  policy on every target.
- **LocalExecutor** wraps a `NativeBridge` and solves the #1 documented
  pitfall — coordinate scaling — by mapping model-space (screenshot pixels) to
  input-space (real screen pixels) on every action.
- **Bridges**: Windows is the reference — a persistent PowerShell daemon
  (`System.Drawing` capture + `user32` SendInput-family input) speaking
  JSON-lines over stdio, started via `-EncodedCommand`; zero native npm
  modules, so installs never compile anything. macOS (`screencapture`/
  `cliclick`/`osascript`) and Linux (`import`/`xdotool`) are best-effort
  equivalents behind the same interface.
- Actions are normalized first (`normalizeAction`) because the upstream docs'
  reference table and examples disagree on some param shapes — both are
  accepted, one canonical shape is executed.

## apps/backend — proxy, custodian, fan-out

- **Auth**: `POST /api/auth/login {email}` issues an opaque random token
  (stored hashed, 7-day expiry). Single-tenant demo auth by design
  (`DECISIONS.md` D6); every table already carries `user_id`.
- **Spend safety — the confirmCostCents handshake.** Billable routes compute
  the relevant number server-side (run worst case = `maxSteps × perStep`;
  machines = first-hour rate; workflows = the budget cap itself) and reject
  unless the client echoes it exactly (`409 ESTIMATE_CHANGED` with the expected
  value). Budgets are then enforced again: runs whose worst case exceeds the
  user's cap are refused with a suggested `maxSteps`; workflow runs pass
  `budget_cents` so *Coasty* halts them at the cap (`GUARD_EXCEEDED`); wallet
  pre-flight checks surface 402s before anything starts.
- **Event pipeline.** Creating a run starts an **Ingestor** subscription to
  Coasty's SSE stream (resuming from the last stored seq). Events are mirrored
  into the `events` table **keeping the upstream `seq`**, applied to run state,
  and published on an in-process bus. Client SSE routes replay from SQLite
  (`Last-Event-ID`), then attach to the bus — with gap-filling if live events
  race the replay. The same table serves cloud runs, local runs, workflow
  runs, and per-user notification feeds (`stream_kind` + `stream_id`).
- **Webhooks as reconciliation.** `POST /webhooks/coasty` verifies the HMAC
  against the per-run secret (looked up by the payload's run id) over the
  exact raw bytes before *any* state change; stale/tampered/unknown deliveries
  get 401. Verified events update run state and post to the owner's
  notification stream — so terminal transitions arrive even if an SSE
  subscription dropped. `GET /api/runs/:id` additionally reconciles
  non-terminal runs against Coasty on read.
- **Local runs.** The desktop app mirrors its LocalExecutor loop through
  `POST /api/local-runs(/:id/events)`, so a run on your laptop is supervisable
  from your phone exactly like a cloud run — same timeline route, same
  approval notifications.
- **Persistence**: `node:sqlite` behind a repository class (`db.ts`); events
  have `(stream_kind, stream_id, seq)` primary keys so ingestion is idempotent
  and replay is a range scan. Postgres is a contained swap (`DEPLOYMENT.md`).
  Columns added after the first release are ALTERed in explicitly at boot
  (`addColumnIfMissing`) — `CREATE TABLE IF NOT EXISTS` is a no-op on an
  existing database, so without that an upgraded install would fail on its
  first task rather than at startup.

## Managed tasks (`POST /api/tasks`)

A submit-and-forget task hands Coasty one goal and no machine. It is admitted as
an ordinary `agent.run` — so `GET /api/runs/:id`, the SSE timeline, and cancel
all work untouched — but four things about it are genuinely different, and each
one shaped the integration:

- **Two meters, one handshake.** A task bills agent steps *and* the runtime of
  the machine Coasty provisions for it. Reusing the run estimate would
  under-quote the user, so `/api/tasks` confirms a `kind: 'task'` estimate. The
  `BUDGET_EXCEEDED` response therefore reports `stepsCents` and `machineCents`
  separately, and its `suggestedMaxSteps` is `null` (not `0`) when the machine
  component alone already breaks the cap.
- **The deadline is mandatory here, though optional upstream.** Machine runtime
  accrues for as long as the task runs, so an unbounded deadline is an unbounded
  bill and there is nothing honest to confirm. The backend always sends an
  explicit `deadline_seconds`, defaulting to `DEFAULT_TASK_DEADLINE_SECONDS`.
- **`machine_id` starts null.** It only appears once provisioning finishes, so
  it is picked up from the ingested `status` event and from the read-time
  reconcile — never at create time.
- **Cleanup outlives the run.** Termination of the ephemeral machine begins
  *after* the terminal transition and can still be `terminating`/`retrying` when
  the run already reads `succeeded`. The read-time reconcile therefore does not
  stop at the terminal status — it keeps reconciling until `cleanup_status`
  settles — and the UI never reports the machine as destroyed until it is.

Because a task never enters `awaiting_human` (the endpoint-owned executor
intercepts the model's handoff request), `POST /api/runs/:id/resume` refuses a
task run outright rather than forwarding a call that could only 409 upstream.

`GET /api/runs/:id/screenshots` proxies the run's **model-input frames** — the
exact images the agent saw before each decision. For a managed task these
outlive the machine that produced them, which makes them the only surviving
evidence after cleanup; the run view falls back to the newest stored frame once
live screenshots stop working. Inlined frames are served `Cache-Control:
no-store` all the way to the browser, because a frame can show an inbox or a
billing page.

## Realtime model (end to end)

```text
Coasty SSE ──► Ingestor ──► events table (durable, seq) ──► bus ──► client SSE
Coasty webhooks ──► HMAC verify ──► state + notification stream ──► bus ──► feeds
desktop local loop ──► POST /api/local-runs/:id/events ──► same table/bus
```

Every hop resumes: the Ingestor reconnects to Coasty with `Last-Event-ID`;
clients reconnect to the backend the same way; mobile polls
`/api/runs/:id/events.json?after=N` (React Native fetch lacks streaming).
Nothing is lost or duplicated because the durable seq is the single cursor.

## apps/desktop — local control, safely

Electron with `contextIsolation: true`, `nodeIntegration: false`. The renderer
is the same SPA as the web app; a small preload exposes
`window.cowork = { platform, backendUrl, startLocalRun, cancelLocalRun }`.
`LocalRunManager` (main process) runs core's `runAgentLoop` with
`LocalExecutor`, gets predictions through the backend's `/api/proxy/sessions`
(key stays server-side), and mirrors events to `/api/local-runs` in batches.
The E2E suite deliberately never starts a local run (it would seize the real
mouse); that path is covered by unit tests plus an opt-in native capture smoke
test (`COWORK_NATIVE_SMOKE=1`).

## apps/web + packages/ui

One Vite SPA serves browsers and the desktop webview. `packages/ui` is a
dependency-free design system (dark-first tokens, accessible primitives,
domain components like `EventTimeline`, `ScreenView`, `ApprovalBar`,
`WorkflowStepTree`); apps map API DTOs into its presentational props. The live
screen view polls machine screenshots every 2s while a run is active — frames
are cross-platform and cheap (`DECISIONS.md` A3).

## apps/mobile

Expo/React Native with zero extra native deps; every screen is
react-native-web-compatible, which is how the same UI is verified in CI
(D7). Timelines poll the REST fallback; approvals hit the same resume routes.

## tools/mock-coasty

A faithful offline twin of the documented API: key kinds + billing headers,
the full error catalog, exact pricing math, run/workflow steppers with the
documented state machine, durable SSE with replay, HMAC-signed webhook
delivery, sandbox machines with generated-PNG screenshots. Deliberately does
**not** import `core` (D9) so contract bugs can't hide; behavior triggers in
task text (`NEEDS_HUMAN`, `MUST_FAIL`, `RUN_LONG`, `MOCK_DONE`) make every
lifecycle deterministic for tests and demos.

## Data model (SQLite)

```text
users(id, email, budget_cents, created_at)
sessions(token_hash PK, user_id, expires_at)            -- tokens stored hashed
runs(id, user_id, kind coasty|local|task, coasty_run_id, machine_id, task,
     status, cua_version, max_steps, budget_cents, cost_cents, steps_completed,
     result_json, error_json, awaiting_human_reason, webhook_secret,
     machine_json,          -- automatic machine lifecycle view (task runs)
     deadline_seconds,      -- the wall-clock budget we pinned at create
     action_policy_json,    -- our submission; upstream never echoes it back
     …)
workflow_runs(id, user_id, coasty_workflow_run_id, workflow_id, status,
     budget_cents, spent_cents, awaiting_step_id, webhook_secret, …)
events(stream_kind, stream_id, seq, type, data_json, created_at,
       PRIMARY KEY (stream_kind, stream_id, seq))       -- the realtime spine
```
