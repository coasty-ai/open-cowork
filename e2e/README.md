# @open-cowork/e2e

End-to-end tests that run the **real** apps against the bundled mock Coasty
server. Fully offline, zero spend.

## Suites

| Command | What it proves |
| --- | --- |
| `pnpm e2e` (repo root) | Playwright: web + desktop + features (25 tests) |
| `pnpm --filter @open-cowork/e2e e2e:web` | Browser journey: login → provision → delegate → confirm cost → live timeline + screen frames → approve human step → succeeded + cost summary; a **managed task** that provisions nothing, never pauses, and reports its machine shut down; workflow build → validate → run → approve → output; server-side budget refusal. Plus a runtime watcher asserting **no Coasty key/secret material appears in any browser request**. |
| `npx playwright test --project=features` | Breadth coverage of every capability through the real stack: machine lifecycle in the UI, `INVALID_STATE` + rate-handshake + action-allowlist refusals, managed-task behaviour (estimate parity, cancel-still-cleans-up, no-resume, action policy, provisioning failure), model-input frame paging + `no-store` + surviving teardown, SSE cursor replay and the per-user notification feed, wallet/settings/auth, workflow DSL validation. Capabilities with no UI affordance are driven from the browser's own session token, which also proves they are enforced **server-side**. |
| `pnpm --filter @open-cowork/e2e e2e:desktop` | Electron shell boots, exposes the secure `window.cowork` bridge (no Node in the renderer), login works, the "This computer (local screen)" target + local-control warning appear. |
| `pnpm --filter @open-cowork/e2e smoke:bootstrap` | **Zero-config / one-key proof.** Spawns the *actual* backend entrypoint (`apps/backend/src/main.ts`) and the mock CLI — the same processes `pnpm dev` runs — with **no Coasty key and no session secret** (demo mode), on auto-picked free ports, and drives login → provision → delegate → run → succeeded over real HTTP (webhook included). |

## How the Playwright suites are wired

`playwright.config.ts` boots three `webServer`s in order — the mock Coasty
server (`:4010`), the backend with a sandbox key + in-memory DB (`:4000`), and
the built web app preview (`:4173`) — then runs the `web`, `desktop`, and
`features` projects against them. CI builds the web + desktop bundles first and
runs the suite under `xvfb` (see `.github/workflows/ci.yml`).

> The preview server serves the **built** bundle from `apps/web/dist`, so a
> source change is invisible to Playwright until `pnpm --filter @open-cowork/web
> build` runs. Turbo's `e2e` task depends on `build`; invoking `playwright test`
> directly does not, so rebuild first when iterating by hand.

`features` is declared **last**: `workers: 1` means the projects share one
backend, and that suite provisions and terminates machines of its own.

The `smoke:bootstrap` script manages its own processes and free ports, so it
can run alongside a live dev stack or the Playwright suite without colliding.
