# Contributing to open-cowork

Thanks for helping build an open, cross-platform agentic coworker. This guide covers
workflow and ground rules; see `ARCHITECTURE.md` for how the system fits together.

## Prerequisites

- Node ≥ 22.5 (we develop on Node 24) — `node:sqlite` is required by the backend.
- pnpm 10 (`corepack enable` or `npm i -g pnpm`).
- No Coasty account needed for development: everything runs against the bundled
  mock server (`tools/mock-coasty`).

## Setup

```bash
pnpm install
cp .env.example .env        # defaults point at the mock server — no real key needed
```

## Day-to-day commands (run from the repo root)

| Command | What it does |
| --- | --- |
| `pnpm dev:mock` | Mock Coasty API on http://127.0.0.1:4010/v1 |
| `pnpm dev:backend` | open-cowork backend on http://127.0.0.1:4000 |
| `pnpm dev:web` | Web app on http://127.0.0.1:5173 |
| `pnpm dev:desktop` / `pnpm dev:mobile` | Desktop (Electron) / Mobile (Expo) |
| `pnpm test` | All unit + integration tests (offline, no spend) |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | Static checks |
| `pnpm e2e` | Playwright E2E (web + desktop) against the mock |
| `pnpm security:scan` | Assert no secret material in client code/bundles |

## Ground rules

1. **The Coasty key never touches a client.** Anything under `apps/web`,
   `apps/desktop`, `apps/mobile`, `packages/ui`, or `packages/core` must not read
   `COASTY_API_KEY` or embed key/secret values. `pnpm security:scan` and the
   security test suite enforce this — keep them green.
2. **No test may spend money.** Tests run against `tools/mock-coasty` or (opt-in,
   `COWORK_RUN_LIVE=1`) a `sk-coasty-test-*` sandbox key, which Coasty never bills.
   Never put a `sk-coasty-live-*` key in a test or fixture.
3. **Strict TypeScript everywhere.** `any` is a lint error outside tests. Keep
   `pnpm typecheck` and `pnpm lint` clean before pushing.
4. **`packages/core` stays isomorphic and dependency-free.** No `node:` imports in
   `src/`, no framework imports, injectable `fetch`/clock/random for testability.
5. **Tests are part of the feature.** New behavior ships with deterministic,
   offline tests (Vitest; React Testing Library for components; Playwright for
   user journeys). Cover loading/error/empty states for UI.
6. **Billable actions need explicit confirmation.** Any new endpoint or UI that can
   spend credits must surface a server-computed estimate and require the
   `confirmCostCents` handshake (see `ARCHITECTURE.md` → Spend safety).

## Pull requests

- Branch from `main`; keep PRs focused; CI must pass (lint, typecheck, unit,
  integration, security scan; E2E runs on PRs).
- Describe *what* and *why*; link issues; include screenshots for UI changes.
- New dependencies need a short justification in the PR description and must not
  introduce native build steps without discussion (Windows dev support matters).

## Reporting security issues

Please do not open public issues for vulnerabilities — see `SECURITY.md`.
