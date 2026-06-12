# DEPLOYMENT

How to run open-cowork beyond a dev machine: the backend (the only component
with secrets), each client, and the production hardening checklist.

## Backend (`apps/backend`)

The backend is a single Node ≥22.5 process: Fastify + `node:sqlite` (one file
on disk), no other services required.

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `COASTY_API_KEY` | yes | Use a **scoped** key. Start with `sk-coasty-test-…` (never bills) and switch to live deliberately. |
| `COASTY_BASE_URL` | yes | `https://coasty.ai/v1` for the real service; the mock URL for staging/demos. |
| `COWORK_PUBLIC_URL` | for webhooks | **https** URL Coasty can reach: `https://cowork.example.com`. Webhooks add instant terminal/approval updates; without them, state still converges via SSE + read-time reconcile. |
| `COWORK_PORT` / `COWORK_HOST` | no | Defaults `4000` / `127.0.0.1`. Set `COWORK_HOST=0.0.0.0` behind a reverse proxy. |
| `COWORK_DB_PATH` | no | SQLite file (default `./data/cowork.sqlite`). Put it on persistent storage and back it up. |
| `COWORK_SESSION_SECRET` | yes | 32+ random chars. |
| `COWORK_DEFAULT_BUDGET_CENTS` | no | Server-enforced per-run cap default (500 = $5). |

### Steps (any Linux host)

```bash
corepack enable && pnpm install --frozen-lockfile
COASTY_API_KEY=… COWORK_PUBLIC_URL=https://cowork.example.com \
  pnpm --filter @open-cowork/backend start
```

Run it under a supervisor (systemd example):

```ini
[Service]
WorkingDirectory=/opt/open-cowork
ExecStart=/usr/bin/pnpm --filter @open-cowork/backend start
EnvironmentFile=/etc/open-cowork.env     # chmod 600, owner-only
Restart=always
User=cowork
```

Front it with a TLS-terminating reverse proxy (Caddy/nginx). Two proxy notes:

- **SSE**: disable response buffering for `/api/*/events` (nginx:
  `proxy_buffering off;` — the backend also sends `X-Accel-Buffering: no`).
- **Webhooks**: `/webhooks/coasty` must receive the **raw body** unmodified
  (no body-rewriting middleware), or HMAC verification will fail.

On boot the backend resumes event ingestion for any run that was live when it
stopped — no babysitting required across restarts.

### Scaling note (SQLite → Postgres)

One instance + SQLite comfortably serves a team. For multi-instance HA you
need shared state: the repository layer (`apps/backend/src/db.ts`) is the only
SQL surface (~15 methods) — port it to Postgres and replace the in-process
event bus with `LISTEN/NOTIFY` or Redis pub/sub. See `DECISIONS.md` D4.

## Web (`apps/web`)

```bash
pnpm --filter @open-cowork/web build     # → apps/web/dist (static)
```

Serve `dist/` from any static host **on the same origin as the backend** (the
SPA calls relative `/api/...`), e.g. nginx serving static files and proxying
`/api` + `/webhooks` to the backend port. Different-origin hosting works too:
serve with a reverse proxy that forwards `/api`, or set
`window.cowork.backendUrl` the way the desktop shell does.

## Desktop (`apps/desktop`)

```bash
pnpm --filter @open-cowork/web build
pnpm --filter @open-cowork/desktop build
COWORK_WEB_URL=https://cowork.example.com \
COWORK_BACKEND_URL=https://cowork.example.com \
  pnpm --filter @open-cowork/desktop start
```

For installable artifacts add electron-builder (not wired by default; see
`apps/desktop/README.md`). Windows is the reference platform for local screen
control; macOS needs Screen Recording + Accessibility permissions granted to
the app; Linux needs `xdotool` + ImageMagick (X11).

## Mobile (`apps/mobile`)

- Development: `pnpm dev:mobile` + Expo Go, with
  `EXPO_PUBLIC_BACKEND_URL=https://cowork.example.com` (a phone cannot reach
  your `127.0.0.1`).
- Store builds: standard `eas build` (Expo Application Services). Push
  notifications are stubbed behind an interface (`DECISIONS.md` D8): wire
  `expo-notifications` + a push token route before relying on out-of-app
  alerts; in-app approval banners work out of the box via polling.

## Mock server in production-like staging

`tools/mock-coasty` is deployable like the backend (`PORT=4010 pnpm --filter
@open-cowork/mock-coasty start`) — useful for demo environments and CI: full
product behavior, zero spend, deterministic lifecycles.

## Production checklist

- [ ] `COASTY_API_KEY` is scoped (no `terminal:exec`/`connection:read` unless
      needed), stored in an env file with `600` perms or a secret manager
- [ ] Started with a **test key** first; switched to live after a smoke pass
- [ ] `COWORK_PUBLIC_URL` is https and `/webhooks/coasty` passes raw bodies
- [ ] Real auth in front of the demo login (see `SECURITY.md`)
- [ ] SQLite file on persistent volume + backed up (or Postgres port)
- [ ] Reverse proxy: SSE buffering off; HTTP/1.1 keep-alive for event routes
- [ ] `pnpm security:scan` + CI green on the deployed commit
- [ ] Budget defaults reviewed (`COWORK_DEFAULT_BUDGET_CENTS`), machine TTLs
      used in any automation that provisions VMs
