# @open-cowork/web

The open-cowork web app: a Vite + React SPA that is also the UI hosted inside
the desktop (Electron) shell.

## Run

```bash
pnpm dev:mock      # terminal 1 — offline Coasty mock
pnpm dev:backend   # terminal 2
pnpm dev:web       # terminal 3 → http://127.0.0.1:5173
```

Dev and preview servers proxy `/api` to the backend on `127.0.0.1:4000`, so
the SPA always talks same-origin. The desktop shell injects an absolute
backend URL via `window.cowork.backendUrl` instead.

## Pages

| Route | What |
| --- | --- |
| `/login` | demo email login → session token (localStorage, zustand-persisted) |
| `/` | delegate a task: composer + machine target + **cost-confirm dialog** |
| `/runs`, `/runs/:id` | dashboard + live run view (SSE timeline, screen frames, approve/cancel, cost summary) |
| `/workflows`, `/workflows/:id` | builder (JSON DSL + instant validation + estimate), step-tree preview, budget-capped runs |
| `/workflows/runs/:id` | live workflow run with approve/reject |
| `/machines` | provision (rate confirmation) / start / stop / terminate + wallet |
| `/settings` | per-run budget cap, theme toggle |

Realtime: `useSse` reconnects with `Last-Event-ID`; the global feed
(`/api/events`) drives approval banners and the offline indicator.

## Test / build

```bash
pnpm --filter @open-cowork/web test        # vitest + RTL (jsdom)
pnpm --filter @open-cowork/web build       # static dist/
pnpm --filter @open-cowork/web preview     # serve dist on :4173 (E2E target)
```

No Coasty key ever reaches this app — see `SECURITY.md` at the repo root.
