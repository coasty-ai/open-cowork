# @open-cowork/backend

The open-cowork backend: Fastify + `node:sqlite`. The **only** component that
holds `COASTY_API_KEY` and per-run webhook secrets.

## Run

```bash
cp ../../.env.example ../../.env   # repo-root .env is auto-loaded
pnpm dev:backend                   # http://127.0.0.1:4000
```

Defaults point at the bundled mock (`pnpm dev:mock`); see `DEPLOYMENT.md` for
live configuration and the production checklist.

## Responsibilities

- **Auth**: demo email login → hashed, expiring bearer tokens.
- **Coasty proxy**: runs, workflows, machines, and the inference session proxy
  (`/api/proxy/sessions*`) used by the desktop local loop.
- **Spend safety**: server-computed estimates, the `confirmCostCents`
  handshake (`409 ESTIMATE_CHANGED` on mismatch), per-user budget caps
  (`422 BUDGET_EXCEEDED` with a suggested `maxSteps`), wallet pre-flight 402s,
  `budget_cents` guards passed to Coasty.
- **Realtime**: per-run Coasty SSE ingestion → durable `events` table
  (upstream seq preserved) → SSE fan-out with `Last-Event-ID` replay; REST
  polling fallback at `/api/runs/:id/events.json?after=N`; per-user
  notification feed at `/api/events`.
- **Webhooks**: `POST /webhooks/coasty` — per-run HMAC verification over the
  raw body (constant-time, ±5 min) *before* any state change.
- **Local runs**: desktop-executed runs are mirrored via `/api/local-runs*`
  so every device can supervise them.

## API quick reference

All under `/api` with `Authorization: Bearer <token>` (login + `/health` +
`/webhooks/*` excepted). See `apps/backend/src/routes/*.ts` for the full
surface and `e2e/tests/web.spec.ts` for it in action.

## Test

```bash
pnpm --filter @open-cowork/backend test
```

22 integration tests boot the real server against an in-process mock-coasty
over actual HTTP — run lifecycles, SSE replay/reconnect, signed/tampered/stale
webhooks, budget refusals, workflow approvals, machine lifecycles. Offline,
free, deterministic.
