# @open-cowork/e2e

End-to-end tests that run the **real** apps against the bundled mock Coasty
server. Fully offline, zero spend.

## Suites

| Command | What it proves |
| --- | --- |
| `pnpm e2e` (repo root) | Playwright: web + desktop |
| `pnpm --filter @open-cowork/e2e e2e:web` | Browser journey: login → provision → delegate → confirm cost → live timeline + screen frames → approve human step → succeeded + cost summary; workflow build → validate → run → approve → output; server-side budget refusal. Plus a runtime watcher asserting **no Coasty key/secret material appears in any browser request**. |
| `pnpm --filter @open-cowork/e2e e2e:desktop` | Electron shell boots, exposes the secure `window.cowork` bridge (no Node in the renderer), login works, the "This computer (local screen)" target + local-control warning appear. |
| `pnpm --filter @open-cowork/e2e smoke:bootstrap` | **Zero-config / one-key proof.** Spawns the *actual* backend entrypoint (`apps/backend/src/main.ts`) and the mock CLI — the same processes `pnpm dev` runs — with **no Coasty key and no session secret** (demo mode), on auto-picked free ports, and drives login → provision → delegate → run → succeeded over real HTTP (webhook included). |

## How the Playwright suites are wired

`playwright.config.ts` boots three `webServer`s in order — the mock Coasty
server (`:4010`), the backend with a sandbox key + in-memory DB (`:4000`), and
the built web app preview (`:4173`) — then runs the `web` and `desktop`
projects against them. CI builds the web + desktop bundles first and runs the
suite under `xvfb` (see `.github/workflows/ci.yml`).

The `smoke:bootstrap` script manages its own processes and free ports, so it
can run alongside a live dev stack or the Playwright suite without colliding.
