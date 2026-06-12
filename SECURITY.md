# SECURITY

The trust model, what enforces it, and known limitations. Report
vulnerabilities privately to the maintainers (see repository contacts) — not
in public issues.

## Trust boundaries

```text
  UNTRUSTED-ish                     TRUSTED                      EXTERNAL
┌─────────────────┐   session    ┌──────────────────┐  API key ┌────────────┐
│ web / mobile /  │   tokens     │  apps/backend     │─────────►│ Coasty API │
│ desktop renderer│─────────────►│  (key custodian)  │◄─────────│  webhooks  │
└─────────────────┘              └──────────────────┘   HMAC   └────────────┘
        ▲ contextIsolation              ▲ env only
┌─────────────────┐                     │
│ desktop main    │── session token ────┘   (no key in the desktop app either)
│ (LocalRunManager)│
└─────────────────┘
```

## Key custody

- `COASTY_API_KEY` is read from the environment by `apps/backend/src/config.ts`
  — the **only** code in the repository that touches it. It is never logged,
  never serialized into a response, and never passed to any client, including
  the Electron main process (which authenticates with a user session token and
  gets predictions through `/api/proxy/*`).
- Enforcement, layered:
  1. `pnpm security:scan` — scans every client source tree and built bundle
     for key/secret value patterns and for the `COASTY_API_KEY` name (which in
     a client bundle would indicate env leakage through a bundler).
  2. Runtime E2E assertion — during the full web journey, every browser
     request's URL, headers, and body are watched for `sk-coasty-*` /
     `whsec_*` material; one hit fails the suite.
  3. CI runs both on every push.
- `.env` is gitignored; `.env.example` ships placeholders only. **If a real
  key was ever present in a working tree you don't fully trust, rotate it at
  https://coasty.ai/developers/keys** — rotation is cheap, doubt is not.

## Webhook authenticity (HMAC)

Coasty signs callbacks with a **per-run** `webhook_secret` returned exactly
once at run creation and stored only in the backend DB:

- Header `Coasty-Signature: t=<unix>,v1=<hex>`; signed payload is
  `"<t>." + raw_body`. Verification (`packages/core/src/webhook.ts`) recomputes
  HMAC-SHA256 over the **exact raw bytes** (the backend captures the raw body
  before JSON parsing), compares in constant time, and enforces a ±300s
  timestamp window in both directions (replay *and* clock-skew rejection).
- Unknown run ids are rejected with 401 (not 404 — existence isn't leaked),
  and **no state mutation happens before verification**.
- Covered by unit vectors (valid / tampered / stale / future / malformed /
  rotation) and integration tests (tampered + stale + unknown against the live
  receiver).

## Client/server trust

- Session tokens: 32 random bytes, stored **hashed** (SHA-256) with a 7-day
  expiry; bearer-required on every `/api` route except login/health.
- Auth is intentionally a single-tenant demo gate (email → token, no
  password); see `DECISIONS.md` D6. Deploying multi-user means replacing one
  Fastify hook with real identity — every table already keys on `user_id`.
- The machine action passthrough is **allowlisted** (click/type/keys/scroll/
  drag/move/wait/screenshot). Terminal execution, file writes, and raw browser
  JS — which need elevated Coasty scopes — are deliberately not exposed to
  clients.
- The Electron renderer runs with `contextIsolation: true`,
  `nodeIntegration: false`; the preload exposes a three-function bridge and the
  desktop E2E asserts `window.require` does not exist in the renderer.

## Agent-safety policies

- `raw` code actions (model-emitted pyautogui source) are **refused by every
  executor** — local, remote machine, and browser. The docs themselves warn
  against executing them outside a trusted sandbox.
- Local runs require an explicit confirmation that names the consequence
  ("this will control your own mouse and keyboard") before starting, can be
  cancelled from any device, and the loop aborts after 3 consecutive failed
  actions.
- Spend is bounded by four independent layers: client-side estimate display →
  server-side `confirmCostCents` handshake → per-user budget caps (run worst
  case must fit) → Coasty-side `budget_cents` guards and `max_steps` /
  `ttl_minutes` ceilings.

## Threat notes & known limitations

| Threat | Status |
| --- | --- |
| Key exfiltration via client bundle | Blocked; scanned + runtime-asserted in CI |
| Forged/replayed webhooks | Blocked (per-run HMAC, constant-time, ±300s window) |
| Double-billing on network retries | Blocked (POSTs retry only with `Idempotency-Key`) |
| Runaway spend | Bounded (handshake + caps + Coasty guards + TTLs) |
| Prompt injection *on the controlled screen* | **Open risk inherent to CUA**: content the agent reads can steer it. Mitigations: budget caps, step caps, approval gates for sensitive steps, the Cautious prompt preset, full event audit trail. Do not point the agent at untrusted content with broad permissions. |
| Local agent acting on the wrong window | Inherent to OS-level control; the desktop confirm dialog warns, runs are cancellable from any device, and every action is in the timeline. |
| Backend compromise | Owns the key by design; deploy it like any secret-holding service (least-privilege host, https, scoped Coasty key, rotation). |
| Session token theft (demo auth) | Tokens are hashed at rest + expiring, but there is no password/MFA — front the demo gate with real auth before exposing the backend publicly. |

## Dependency hygiene

CI runs `pnpm audit --audit-level high` (non-blocking warn) on every push.
The dependency surface is deliberately small: zero native modules anywhere
(`DECISIONS.md` D2/D4), and `packages/core` has zero runtime dependencies.
