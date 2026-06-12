# SUMMARY

What was built, how it is verified, the platform status matrix, coverage
numbers, and every deviation from the brief / live Coasty docs. Built
2026-06-11 against the live docs snapshot (`https://coasty.ai/docs/llms.txt`,
fetched the same day).

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

## Verification status

`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`,
`pnpm security:scan` — **all green, fully offline** (18/18 turbo tasks across
9 packages). E2E (Playwright, against mock + real backend + built SPA):
**web 3/3, desktop 1/1 — green** on Windows 11.

| Suite | Tests | Notes |
| --- | --- | --- |
| core (unit) | 166 + live-smoke gate | loop, DSL, cost table, HMAC vectors (valid/tampered/stale/future/malformed/rotation), retry, SSE parser, client incl. SSE-reconnect Last-Event-ID |
| executor (unit) | 31 | fake-daemon protocol, DPI scaling, action mapping; +1 opt-in native capture smoke (passed on real hardware) |
| mock-coasty | 56 | pricing math incl. HD boundary, run state machine, SSE drop→reconnect (no dupes/gaps), signed webhooks verified by hand-rolled HMAC, workflow guards/approvals, machines |
| backend (integration) | 22 | real HTTP vs in-process mock: lifecycle, awaiting_human→resume, webhook tamper/stale/unknown → 401, SSE replay+reconnect, BUDGET_EXCEEDED / ESTIMATE_CHANGED / 402 paths, local runs, allowlisted actions |
| ui (RTL) | 107 | all 20 components: roles/names, loading/error/empty, keyboard interactions |
| web (RTL) | 19 | login, delegate→confirm-cost→create, budget-error surfacing, empty/error states, event mapping |
| desktop (unit) | 8 | LocalRunManager happy path/cancel/failure/batching vs fake executor + scripted backend; build smoke |
| mobile (RTL via react-native-web) | 33 | all 5 screens incl. cursor-polled timeline, approval flow, banners |
| **E2E web** | 3 | full journey: login→provision→delegate→confirm $1.25→live timeline+frames→approve with note→succeeded+cost summary; workflow build→validate→run→approve→output; server-side budget refusal. Plus a runtime watcher asserting **no request ever contains key/secret material** |
| **E2E desktop** | 1 | Electron boots, secure bridge present, no Node leak in renderer, login works, "This computer (local screen)" target + local-control warning |
| **Total** | **≈446** | |

Coverage (v8, lines): core **94.1%**, ui **99.9%**, mobile **98.4%**,
mock-coasty **84.2%**, backend **83.5%**, executor **64.7%** (the embedded
PowerShell daemon string and untestable-on-CI unix bridges dominate the
uncovered lines), desktop **63.4%** (Electron main/preload are E2E-covered
instead), web **25.5% by unit tests** — the pages are primarily covered by the
three full-journey E2E flows.

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
- `cua_version` values are `v1 | v3 | v4` (no v2; v4 needs professional tier).
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
