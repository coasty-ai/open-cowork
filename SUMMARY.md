# SUMMARY

What was built, how it is verified, the platform status matrix, coverage
numbers, and every deviation from the brief / live Coasty docs. Built
2026-06-11 against the live docs snapshot (`https://coasty.ai/docs/llms.txt`,
fetched the same day).

> **Updated 2026-07-30** against a re-fetched docs snapshot. Two upstream
> changes had opened a gap: the engine lineup moved on (`v5` shipped and became
> the default; `v4` stopped being pro-gated), and a new fully-managed
> **submit-and-forget task** surface (`POST /v1/tasks`) appeared. Both are now
> integrated end to end — see *Managed tasks* below.

## What was built

A complete, working implementation of the brief: a cross-platform agentic
coworker on the Coasty Computer Use API, as a pnpm + Turborepo monorepo
(TypeScript `strict` everywhere, zero native npm modules):

- **`packages/core`** — typed client for every documented Coasty endpoint
  (timeouts, Retry-After-aware backoff with full jitter, POSTs retried only
  with an `Idempotency-Key`, reconnecting SSE streams), the shared agent loop,
  the full workflow-DSL validator/evaluator (13 ops, templating, guards), the
  cost estimator mirroring the documented pricing table, and isomorphic
  webhook HMAC sign/verify. Zero runtime deps.
- **`packages/executor`** — the `Executor` interface +
  `RemoteMachineExecutor` (cloud VMs), `BrowserExecutor` (Playwright), and
  `LocalExecutor` with native OS bridges (Windows reference implementation: a
  persistent PowerShell daemon — verified live on real hardware via the
  opt-in capture smoke test; macOS/Linux best-effort). Model→input coordinate
  scaling handled; `raw` code execution refused everywhere by policy.
- **`tools/mock-coasty`** — a faithful offline mock of the entire API: key
  kinds + billing headers, the full error catalog, exact pricing math, the
  run state machine with per-step billing, durable SSE with `Last-Event-ID`
  replay, HMAC-signed webhooks, a workflow interpreter, sandbox machines with
  generated-PNG screenshots. Every test and demo runs against it — **no test
  can ever spend money**.
- **`apps/backend`** — Fastify + `node:sqlite`: bearer-token auth, the Coasty
  proxy (sole key holder), HMAC-verified webhook receiver, durable event
  mirroring + SSE fan-out with replay, server-side estimates with the
  `confirmCostCents` handshake and budget caps, local-run mirroring for the
  desktop, per-user notification feed.
- **`packages/ui` + `apps/web`** — dark-first design system (20 accessible
  components) and the SPA: delegate-with-cost-confirm, live run view (SSE
  timeline + screen frames + approvals), workflow builder with instant
  validation + estimates, machines + wallet, settings.
- **`apps/desktop`** — Electron shell (contextIsolation, no Node in the
  renderer) hosting the same SPA; `LocalRunManager` runs the agent loop on the
  user's own screen through the backend inference proxy and mirrors events so
  any device can supervise.
- **`apps/mobile`** — Expo/React Native companion: runs, live machine frames,
  approvals with notes, workflow approvals, machines, wallet; in-app
  awaiting-approval banner; Maestro flows included.
- **Docs**: README (≤10-min offline quickstart), ARCHITECTURE, SECURITY,
  DECISIONS, DEPLOYMENT, COOKBOOK, CONTRIBUTING, per-app READMEs. **CI**:
  GitHub Actions (ubuntu + windows matrix: lint/format/typecheck/unit/
  integration/security-scan on push; E2E with xvfb on PRs; non-blocking audit).

## Managed tasks (`POST /v1/tasks`), added 2026-07-30

A submit-and-forget task takes one goal and no machine: Coasty provisions,
drives, and destroys an ephemeral VM server-side and returns an ordinary
durable `agent.run`, so the existing timeline, cancel, and cost plumbing work
on it unchanged. What the integration had to get right:

| Concern | How it is handled |
| --- | --- |
| **Two billing meters** | A task bills agent steps *and* machine runtime. `taskEstimateCents` sums both and rounds the runtime component **up** — a confirmed ceiling must never be exceeded. Reusing the run estimate would silently under-quote the user. |
| **Unbounded deadline = unbounded bill** | `deadline_seconds` is optional upstream but mandatory here; the backend always sends one (default 1h) so the worst case is finite and honest. |
| **`machine_id` starts null** | Picked up from the ingested `status` event and the read-time reconcile, never at create. |
| **Cleanup outlives the run** | Termination starts *after* the terminal transition and can still be `terminating`/`retrying` when the run reads `succeeded`. The reconcile no longer stops at the terminal status, and no UI claims the machine is gone until it is. |
| **No human pause** | The endpoint intercepts handoff requests, so `awaiting_human` is never entered. `/api/runs/:id/resume` refuses a task run outright instead of forwarding a call that could only 409. |
| **Duplicate machines on retry** | The run id derives the internal machine-provision key upstream, so the create always carries an `Idempotency-Key`; an unkeyed POST is never retried by the client. |
| **Evidence after teardown** | `GET /api/runs/:id/screenshots` proxies the model-input frames, which outlive the machine. Inlined frames are `Cache-Control: no-store` end to end — a frame can show an inbox or a billing page. |
| **`action_policy`** | Validated client-side against every documented limit before a billable round-trip, then pinned to the run row — upstream never echoes the normalized policy back, so our submission *is* the audit record. |
| **BYOK on a test key** | Rejected upstream with `422 LLM_PROVIDER_UNSUPPORTED` rather than silently ignored; surfaced faithfully. |

Two bugs were found and fixed while integrating, both of which also affected
ordinary cloud runs:

- A failed run kept `error: null` unless a webhook happened to land — the
  terminal `done` event carries the error, and the ingestor was dropping it.
- The delegate page's machine poll was keyed off "no selectable target". Adding
  an always-available managed target would have silently disabled it, so it now
  keys off runnable *cloud* machines specifically.

## Setup: one key (or none)

The only thing you ever configure is `COASTY_API_KEY`:

- **Nothing set** → `pnpm dev` boots the bundled mock + backend + web in DEMO
  MODE (ephemeral sandbox key, auto-generated session secret). Zero account,
  zero spend, full product end-to-end.
- **One key set** → the whole stack talks to the real Coasty API. Every other
  setting (session secret, ports, base URL, DB path) has a working default.

This is enforced in code (`apps/backend/src/config.ts`) and proven three ways:
`config.test.ts` (12 cases pinning every branch), `bootstrap.test.ts` (boots
the real in-process server from an EMPTY env and runs a full flow), and
`e2e/bootstrap-smoke.mjs` (spawns the actual `main.ts` + mock CLI with no key
and drives login→provision→run→succeeded over real HTTP). `pnpm run doctor` is a
preflight check (the `run` is required — `pnpm doctor` is a pnpm built-in that
shadows the script); `pnpm dev` is the one-command runner.

## Verification status

`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`,
`pnpm security:scan` — **all green, fully offline** (11/11 turbo test tasks).
E2E (Playwright, against mock + real backend + built SPA): **web 4/4,
desktop 1/1, features 20/20 — green** on Windows 11, plus the zero-config
entrypoint smoke.

Counts below are as measured on 2026-07-30.

| Suite | Tests | Notes |
| --- | --- | --- |
| core (unit) | 256 (+4 skipped) | loop, DSL, cost table, HMAC vectors (valid/tampered/stale/future/malformed/rotation), retry, SSE parser, client incl. SSE-reconnect Last-Event-ID; **+ task cost model and client surface (28)**, **+ action-policy validator (28)** |
| llm (unit) | 308 | BYO provider seam, capability/vision resolution, model catalog, action parsing |
| mock-coasty | 204 | full error catalog + types, pricing/HD boundary, run+workflow state machines, SSE drop→reconnect (no dupes/gaps) incl. ?after= replay, hand-verified HMAC webhooks, idempotency, machines (FS/terminal/browser/batch); **+ tasks (70)**: admission validation, machine preferences, BYOK boundary, idempotency identity, wallet gates, provisioning→cleanup lifecycle, model-input frames |
| backend (integration) | 158 | real HTTP vs in-process mock: run+workflow lifecycle/SSE/reconnect, webhook tamper/stale/unknown→401, BUDGET_EXCEEDED/ESTIMATE_CHANGED/402, machines, wallet+budget, inference proxy errors, entrypoint banners, config + zero-config bootstrap, webhook_url HTTPS gating, best-effort usage preflight; **+ tasks (32)** and **+ schema migration onto a pre-task database (6)** |
| executor (unit) | 113 (+1 opt-in native smoke) | macOS/Linux bridge command-string construction via mocked child_process, Windows daemon protocol, agent-loop↔all-3-executors integration, DPI scaling, action mapping |
| ui (RTL) | 147 | all components: roles/names, loading/error/empty, keyboard interactions |
| web (RTL) | 164 | login, delegate→confirm-cost→create, run/workflow detail (stubbed SSE), workflow builder validation, settings, useSse reconnect, global feed banner, 401 auto-logout; **+ managed-task delegate flow and machine-cleanup wording (10)** |
| desktop (unit) | 92 | LocalRunManager happy path/cancel/failure/batching vs fake executor + scripted backend; window state; build smoke |
| mobile (RTL via react-native-web) | 42 | all 5 screens incl. cursor-polled timeline, approval flow, banners |
| **E2E web** | 4 | full journey: login→provision→delegate→live timeline+frames→approve with note→succeeded+cost summary; **managed task: no machine provisioned, NEEDS_HUMAN suppressed, approval bar never appears, machine reported shut down, frames outlive it**; workflow build→validate→run→approve→output; server-side budget refusal. Plus a runtime watcher asserting **no request ever contains key/secret material** |
| **E2E features** | 20 | breadth coverage through the real stack: machine lifecycle in the UI (provision→stop→start→arm/confirm terminate), `INVALID_STATE` refusal, machine-rate handshake, the client action allowlist (`browser_execute` → 403); managed tasks (v5 default, pinned deadline, task-vs-run estimate parity, cancel-still-cleans-up, no-resume, action-policy reject/pin, provisioning failure); model-input frames (paging, `no-store`, distinct frames, outliving the machine, empty page for local runs); SSE cursor replay with no gaps/dupes and the per-user notification feed; wallet, key-mode-without-the-key, bearer required on every route; workflow DSL validation |
| **E2E desktop** | 1 | Electron boots, secure bridge present, no Node leak in renderer, login works, "This computer (local screen)" target + local-control warning |
| **E2E bootstrap smoke** | 1 | real entrypoint, zero config, full flow over HTTP |
| **Total** | **1484 unit/integration (+5 skipped) + 25 E2E + bootstrap smoke** | |

Coverage (v8, lines): ui **99.9%**, mobile **98.4%**, mock-coasty **96.6%**,
backend **96.2%**, executor **95.3%**, core **94.1%**, web **83.2%** (App/main
routing is E2E territory), desktop **63.4%** (Electron main/preload are
E2E-covered instead).

Bugs found and fixed along the way:

- **Wallet preflight aborted creation against a default-scoped key
  ("Could not create run.").** The `usage` scope is NOT granted on a default
  Coasty key, but the backend `await`ed `coasty.usage()` unguarded before
  creating runs/machines/workflow-runs — a 403 there aborted the whole
  operation. Fixed: the preflight is now best-effort (Coasty enforces credits
  authoritatively at creation), `/api/wallet` degrades to a clear
  "unavailable" state, and the web surfaces the full upstream error (code +
  offending fields + request id) instead of a terse line. Proven by a fetch-spy
  integration suite (`preflight.test.ts`).
- **`webhook_url` rejected by real Coasty (every delegate 422'd).** The backend
  always sent `${COWORK_PUBLIC_URL}/webhooks/coasty` — http by default — but
  Coasty requires **HTTPS** webhook URLs, so the live API rejected run/workflow
  creation with a validation error. (The mock accepted http, so every offline
  test passed.) Fixed: `config.webhookUrl` is sent only when the public URL is
  https or the upstream is the local mock; otherwise it's `null` and run state
  still converges via the SSE ingestor + read reconcile. Proven by config unit
  tests and a fetch-spy integration test that captures the exact outbound body.
- **Two dead Retry buttons** — `RunDetailPage`/`WorkflowRunDetailPage` never
  cleared a prior error on a successful refresh.
- **401 resilience** — the web client auto-logs-out on any `401` (so a backend
  restart that forgets a session, the norm with an auto-generated secret,
  returns the user to login instead of stranding them), covered by unit + the
  desktop E2E.

## Platform status matrix

| Capability | Desktop (Electron) | Web | Mobile (Expo) |
| --- | --- | --- | --- |
| Local screen control | ✅ LocalExecutor + PowerShell bridge (capture verified on real hardware; input path unit-tested + gated) | ❌ by design → cloud machine | ❌ by design → cloud machine |
| Cloud-machine control + live view | ✅ (same SPA) | ✅ E2E-verified | ✅ frames polled 2s (component-tested) |
| Task chat + run dashboard | ✅ | ✅ E2E | ✅ |
| Workflow builder | ✅ full | ✅ full, E2E | ✅ view + approve |
| Approvals / human takeover | ✅ | ✅ E2E | ✅ approve/reject + note |
| Cost / wallet view | ✅ | ✅ E2E | ✅ |
| Verified how | unit + Playwright `_electron` | unit + Playwright | unit via react-native-web; Maestro flows shipped (emulator required) |

## Spend-safety guarantees (tested)

Estimate shown → `confirmCostCents` must echo the server's number → per-user
budget cap must cover the worst case (else 422 with a suggested `maxSteps`) →
wallet pre-flight → Coasty-side `budget_cents` / `max_steps` / `ttl_minutes`
guards. Test keys/mock bill $0; the live-smoke suite refuses non-sandbox keys.

## Deviations from the brief (rationale in DECISIONS.md)

1. **Electron instead of Tauri** (D1) — no Rust toolchain on the dev machine;
   the brief's fallback. Native access isolated behind `NativeBridge` for a
   future Tauri port.
2. **`node:sqlite` instead of Postgres + Prisma** (D4) — offline tests +
   <10-min newcomer setup; repository layer makes Postgres a contained swap.
3. **Vite SPA instead of Next.js** (D3) — same bundle serves web + desktop.
4. **Mobile E2E via react-native-web + shipped Maestro flows** (D7) — no
   emulator on the build machine; same screens E2E-able in chromium.
5. **OS push stubbed; in-app notifications real** (D8).
6. **Contract testing approach**: instead of a standalone schema suite, the
   contract is pinned three ways — core's client tests assert exact outbound
   paths/headers/bodies for all 43 endpoints; mock-coasty (built independently
   of core, D9) asserts documented field names/status codes/pricing; backend
   integration runs the real client against the mock end-to-end.
7. **Schedules & Triggers API not implemented** — documented but outside the
   product surface of the brief (runs/workflows/machines cover the scope).

## Drift between the brief and the live docs (docs were followed)

- Run resume body is `{note}`; **workflow** resume is `{approved, note}` — the
  brief implied `{approved}` for runs.
- Idempotency is an `Idempotency-Key` **header**, not a body field.
- `cua_version` values are `v1 | v3 | v4 | v5` (no v2). **As of the 2026-07-30
  snapshot `v5` is the default and `v4` is no longer pro-gated**; pricing is
  flat across v3/v4/v5 (5 cr per run step) and only `v1` surcharges (8 cr).
  Every caller in this repo passes `cua_version` **explicitly** rather than
  relying on the upstream default, so a future default change cannot silently
  move a run onto a different engine behind an already-confirmed estimate.
- The docs' Reference action table and its code examples disagree on params
  (`wait` `{ms}` vs `{seconds}`; `key_press` `{key}` vs `{keys}`; `scroll`
  `{direction,amount}` vs `{clicks}`; `drag` `{from_x…}` vs `{x1…}`) — core
  accepts both shapes and canonicalizes (`normalizeAction`); the mock emits
  the Reference shape.
- HD surcharge boundary is strict (`>1280` or `>720`; exactly 1280×720 is SD)
  — encoded in the cost estimator and its boundary tests.
- The webhook replay window (5 min) is documented for trigger webhooks; we
  apply the same ±300s tolerance to run webhooks (defense-in-depth).

## Known limitations / next steps

- Demo single-tenant auth (D6) — put real identity in front before public
  deployment (`SECURITY.md`).
- macOS/Linux native bridges are structured + typed but untested on real
  hardware (no such hardware in this environment); Windows is the reference.
- Live-screen view is screenshot frames (1–2s), not VNC video (A3).
- Optional live sandbox smoke (`COWORK_RUN_LIVE=1` + `sk-coasty-test-*`)
  exercises free/sandbox endpoints only; it was not run during this build
  (offline-first policy) and skips cleanly when unset.
