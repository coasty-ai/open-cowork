#!/usr/bin/env node
/**
 * Offline design-review harness: screenshot every major web screen WITHOUT a
 * backend, a network, or the Coasty key.
 *
 * How it stays safe (the repo .env holds a LIVE billable key):
 *   - It drives the *built* SPA served by `vite preview` (static files only).
 *   - Every `/api/**` request is fulfilled from in-memory fixtures here.
 *   - Anything aimed at the backend port (:4000) is hard-aborted as defence in
 *     depth, so nothing can ever reach a real account.
 *
 * Usage (preview server must already be running on BASE_URL):
 *   pnpm --filter @open-cowork/web build
 *   pnpm --filter @open-cowork/web preview --port 4188 --strictPort   # background
 *   BASE_URL=http://127.0.0.1:4188 OUT=.screens/after \
 *     pnpm --filter @open-cowork/e2e exec node scripts/render-screens.mjs
 *
 * Not part of CI — a manual visual-review tool, like gen-brand-assets.mjs.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4188';
const OUT = path.resolve(REPO, process.env.OUT ?? '.screens');

const ISO = '2026-06-12T18:30:00.000Z';

// A representative populated run timeline (SSE), so the reference screen renders
// the way a real live run looks rather than an empty card.
const TIMELINE_SSE =
  [
    'id: 1\nevent: status\ndata: {"status":"running"}',
    'id: 2\nevent: text\ndata: {"text":"Opening the vendor portal and locating the June invoices."}',
    'id: 3\nevent: action\ndata: {"action":{"action_type":"click"}}',
    'id: 4\nevent: step\ndata: {"steps_completed":1}',
    'id: 5\nevent: text\ndata: {"text":"Cross-checking invoice #4471 against PO-2231."}',
    'id: 6\nevent: billing\ndata: {"cost_cents":415}',
    'id: 7\nevent: step\ndata: {"steps_completed":2}',
    'id: 8\nevent: awaiting_human\ndata: {"reason":"About to send 3 emails — approve?"}',
  ].join('\n\n') + '\n\n';

// A run mid-flight (no terminal event) — the live running transcript.
const RUNNING_SSE =
  [
    'id: 1\nevent: status\ndata: {"status":"running"}',
    'id: 2\nevent: text\ndata: {"text":"Opening the vendor portal and locating the June invoices."}',
    'id: 3\nevent: action\ndata: {"action":{"action_type":"click"}}',
    'id: 4\nevent: step\ndata: {"steps_completed":1}',
    'id: 5\nevent: reasoning\ndata: {"text":"The June statement lists 14 invoices; I will reconcile each against the PO ledger and flag any variance over $50."}',
    'id: 6\nevent: text\ndata: {"text":"Cross-checking invoice #4471 against PO-2231 — the amounts match."}',
    'id: 7\nevent: billing\ndata: {"cost_cents":415}',
    'id: 8\nevent: step\ndata: {"steps_completed":2}',
    'id: 9\nevent: text\ndata: {"text":"Reviewing invoice #4472 next."}',
  ].join('\n\n') + '\n\n';

// A run that finishes cleanly — closes with a terminal `done` event.
const DONE_SSE =
  [
    'id: 1\nevent: status\ndata: {"status":"running"}',
    'id: 2\nevent: text\ndata: {"text":"Exporting the Q2 dashboard to PDF."}',
    'id: 3\nevent: action\ndata: {"action":{"action_type":"click"}}',
    'id: 4\nevent: step\ndata: {"steps_completed":1}',
    'id: 5\nevent: text\ndata: {"text":"Saved Q2-dashboard.pdf and filed it under Reports/."}',
    'id: 6\nevent: billing\ndata: {"cost_cents":310}',
    'id: 7\nevent: done\ndata: {"status":"succeeded"}',
  ].join('\n\n') + '\n\n';

/** Which SSE body each run id streams (others get an empty, well-formed stream). */
const SSE_BY_RUN = { r1: TIMELINE_SSE, r2: RUNNING_SSE, r3: DONE_SSE, r5: RUNNING_SSE };

const run = (over) => ({
  id: 'r1',
  kind: 'coasty',
  machineId: 'm1',
  task: 'Reconcile the June vendor invoices against the PO ledger and flag mismatches',
  status: 'running',
  cuaVersion: 'cua-1',
  maxSteps: 25,
  budgetCents: 1250,
  costCents: 415,
  stepsCompleted: 9,
  result: null,
  error: null,
  awaitingHumanReason: null,
  createdAt: ISO,
  finishedAt: null,
  ...over,
});

const RUNS = [
  run({
    id: 'r1',
    status: 'awaiting_human',
    awaitingHumanReason: 'About to send 3 emails — approve?',
  }),
  run({
    id: 'r2',
    kind: 'local',
    status: 'running',
    task: 'Tidy my Downloads folder by file type',
    costCents: 90,
    stepsCompleted: 4,
  }),
  run({
    id: 'r3',
    status: 'succeeded',
    task: 'Export the Q2 dashboard to PDF and file it',
    costCents: 310,
    stepsCompleted: 12,
    finishedAt: ISO,
    result: { passed: true, summary: 'Saved Q2-dashboard.pdf to Reports/.' },
  }),
  run({
    id: 'r4',
    kind: 'local',
    status: 'failed',
    task: 'Rename screenshots to their capture date',
    costCents: 35,
    stepsCompleted: 2,
    finishedAt: ISO,
    error: { code: 'STEP_FAILED', message: 'Permission denied writing to the folder.' },
  }),
];

const MACHINES = [
  {
    id: 'm1',
    display_name: 'invoice-bot',
    status: 'running',
    os_type: 'linux',
    is_test: false,
    created_at: ISO,
  },
  {
    id: 'm2',
    display_name: 'windows-qa',
    status: 'stopped',
    os_type: 'windows',
    is_test: false,
    created_at: ISO,
  },
];

const WORKFLOWS = [
  {
    id: 'w1',
    name: 'Invoice check',
    slug: 'invoice-check',
    version: 3,
    definition: {},
    description: 'Validate invoices then email a summary.',
    status: 'active',
  },
  {
    id: 'w2',
    name: 'Daily standup digest',
    slug: 'standup-digest',
    version: 1,
    definition: {},
    description: null,
    status: 'active',
  },
];

/** Exact-path GET fixtures. Functions get the URL for param routes. */
const GET = {
  '/api/me': {
    user: { id: 'u1', email: 'demo@open-cowork.dev', budgetCents: 50000 },
    monthSpendCents: 1875,
  },
  '/api/wallet': {
    balanceCents: 48125,
    periodCostCents: 1875,
    period: '2026-06',
    monthSpendCents: 1875,
    walletAvailable: true,
  },
  '/api/runs': { runs: RUNS },
  '/api/runs/r1': RUNS[0],
  '/api/runs/r2': RUNS[1],
  '/api/runs/r3': RUNS[2],
  '/api/runs/r4': RUNS[3],
  '/api/runs/r5': run({ id: 'r5', status: 'running', costCents: 415, stepsCompleted: 9 }),
  '/api/machines': { machines: MACHINES },
  '/api/machines/m1/screenshot': { image_b64: '', width: 1280, height: 800, captured_at: ISO },
  // Local-run live frame (the desktop forwards the user's own screen).
  '/api/local-runs/r2/frame': { base64: '', width: 1280, height: 800, capturedAt: ISO },
  '/api/workflows': { workflows: WORKFLOWS },
  '/api/workflows/runs': { runs: [] },
  // Default Coasty-key status: demo mode (no real key). Per-screen `coastyKey`
  // overrides this to show the configured/connected states.
  '/api/config/coasty-key': { configured: false, mode: null, demoMode: true, source: 'demo' },
};

async function fulfillApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  // The reference run's timeline streams a representative set of events; other
  // SSE streams hand back an empty, well-formed event-stream and close.
  const sse = p.match(/^\/api\/runs\/(\w+)\/events$/);
  if (sse) {
    const body = SSE_BY_RUN[sse[1]] ?? ': ok\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  }
  if (p.endsWith('/events')) {
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': ok\n\n' });
  }
  if (req.method() === 'POST' && p === '/api/estimate') {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ kind: 'run', cents: 125, breakdown: {} }),
    });
  }
  const body = GET[p];
  if (body !== undefined) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }
  // Unknown GET → empty 200 so the UI degrades gracefully rather than erroring.
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
}

const SESSION = JSON.stringify({
  state: {
    token: 'demo-session-token',
    user: { id: 'u1', email: 'demo@open-cowork.dev', budgetCents: 50000 },
  },
  version: 0,
});

const SCREENS = [
  { name: 'login', path: '/login', auth: false, theme: 'dark', w: 1280, h: 900 },
  { name: 'home', path: '/', theme: 'dark', w: 1280, h: 900 },
  { name: 'runs', path: '/runs', theme: 'dark', w: 1280, h: 900 },
  { name: 'run-detail', path: '/runs/r1', theme: 'dark', w: 1280, h: 1040 },
  {
    name: 'machines',
    path: '/machines',
    theme: 'dark',
    w: 1280,
    h: 900,
    coastyKey: { configured: true, mode: 'test', demoMode: false, source: 'env' },
  },
  { name: 'machines-gated', path: '/machines', theme: 'dark', w: 1280, h: 900 },
  { name: 'settings', path: '/settings', theme: 'dark', w: 1280, h: 900 },
  {
    name: 'workflows',
    path: '/workflows',
    theme: 'dark',
    w: 1280,
    h: 900,
    coastyKey: { configured: true, mode: 'test', demoMode: false, source: 'env' },
  },
  { name: 'workflows-gated', path: '/workflows', theme: 'dark', w: 1280, h: 900 },
  { name: 'home-light', path: '/', theme: 'light', w: 1280, h: 900 },
  { name: 'runs-light', path: '/runs', theme: 'light', w: 1280, h: 900 },
  { name: 'run-detail-light', path: '/runs/r1', theme: 'light', w: 1280, h: 1040 },
  { name: 'run-detail-tablet', path: '/runs/r1', theme: 'dark', w: 820, h: 1180 },
  // Run-as-chat: the full lifecycle across themes and viewports.
  { name: 'run-chat-running', path: '/runs/r5', theme: 'dark', w: 1280, h: 1080 },
  { name: 'run-chat-running-light', path: '/runs/r5', theme: 'light', w: 1280, h: 1080 },
  { name: 'run-chat-done', path: '/runs/r3', theme: 'dark', w: 1280, h: 1080 },
  { name: 'run-chat-done-light', path: '/runs/r3', theme: 'light', w: 1280, h: 1080 },
  { name: 'run-chat-failed', path: '/runs/r4', theme: 'dark', w: 1280, h: 1080 },
  { name: 'run-chat-local', path: '/runs/r2', theme: 'dark', w: 1280, h: 1080 },
  { name: 'run-chat-mobile', path: '/runs/r1', theme: 'dark', w: 390, h: 900 },
  { name: 'run-chat-zoom', path: '/runs/r5', theme: 'dark', w: 1280, h: 1080, expandScreen: true },
  // Scrolled to the bottom so the live status dock (below the screen) is shown.
  { name: 'run-chat-running-dock', path: '/runs/r5', theme: 'dark', w: 1280, h: 760, scroll: true },
  { name: 'runs-mobile', path: '/runs', theme: 'dark', w: 390, h: 900 },
  { name: 'home-collapsed', path: '/', theme: 'dark', w: 1280, h: 900, collapsed: true },
  { name: 'home-collapsed-light', path: '/', theme: 'light', w: 1280, h: 900, collapsed: true },
  // Tall content scrolled to the bottom — the sidebar must stay fixed in place.
  {
    name: 'runs-scroll',
    path: '/runs',
    theme: 'dark',
    w: 1280,
    h: 700,
    manyRuns: true,
    scroll: true,
  },
  // Coasty API key setup states (login + settings).
  { name: 'login-light', path: '/login', auth: false, theme: 'light', w: 1280, h: 900 },
  {
    name: 'login-connected',
    path: '/login',
    auth: false,
    theme: 'dark',
    w: 1280,
    h: 900,
    coastyKey: { configured: true, mode: 'live', demoMode: false, source: 'env' },
  },
  // Delegate (Home) — the centered single-focus composer.
  {
    name: 'home-typed',
    path: '/',
    theme: 'dark',
    w: 1280,
    h: 900,
    typeTask:
      'Reconcile the June vendor invoices against the PO ledger,\nflag any mismatches over $50,\nand email me a summary.',
    selectMachine: 'm1',
  },
  { name: 'home-no-machine', path: '/', theme: 'dark', w: 1280, h: 900, noMachines: true },
  { name: 'home-mobile', path: '/', theme: 'dark', w: 390, h: 760 },
  // Desktop (Electron) variant — different subtitle + a local run target.
  { name: 'home-desktop', path: '/', theme: 'dark', w: 1280, h: 900, desktop: true },
  // Desktop multi-monitor: pick "This computer" → the Screen selector appears.
  {
    name: 'home-screen-select',
    path: '/',
    theme: 'dark',
    w: 1280,
    h: 900,
    desktop: true,
    selectLocal: true,
    screens: [
      { id: 1, label: 'Display 1 · 1920×1080 (primary)', primary: true, current: false },
      { id: 2, label: 'Display 2 · 2560×1440', primary: false, current: true },
    ],
  },
  {
    name: 'home-screen-select-light',
    path: '/',
    theme: 'light',
    w: 1280,
    h: 900,
    desktop: true,
    selectLocal: true,
    openScreen: true,
    screens: [
      { id: 1, label: 'Display 1 · 1920×1080 (primary)', primary: true, current: false },
      { id: 2, label: 'Display 2 · 2560×1440', primary: false, current: true },
    ],
  },
  // In-house machine dropdown, opened — both themes.
  { name: 'home-menu', path: '/', theme: 'dark', w: 1280, h: 900, openMachine: true },
  { name: 'home-menu-light', path: '/', theme: 'light', w: 1280, h: 900, openMachine: true },
  { name: 'settings-key-demo', path: '/settings', theme: 'dark', w: 1280, h: 980 },
  {
    name: 'settings-key-connected',
    path: '/settings',
    theme: 'dark',
    w: 1280,
    h: 980,
    coastyKey: { configured: true, mode: 'test', demoMode: false, source: 'runtime' },
  },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  // Render a realistic dark "machine screen" frame (a real run would supply a
  // genuine screenshot here) so ScreenView shows representative content.
  const framePage = await browser.newPage();
  const frameB64 = await framePage.evaluate(() => {
    // eslint-disable-next-line no-undef
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 800;
    const x = c.getContext('2d');
    x.fillStyle = '#1c1c1c';
    x.fillRect(0, 0, 1280, 800);
    x.fillStyle = '#2a2a2a';
    x.fillRect(0, 0, 1280, 44); // window chrome bar
    x.fillStyle = '#3a3a3a';
    for (let i = 0; i < 6; i++) x.fillRect(48, 96 + i * 70, 560 + i * 60, 8); // text lines
    x.fillStyle = '#333';
    x.fillRect(820, 120, 380, 240); // a panel
    return c.toDataURL('image/png').split(',')[1];
  });
  await framePage.close();
  GET['/api/machines/m1/screenshot'].image_b64 = frameB64;
  GET['/api/local-runs/r2/frame'].base64 = frameB64;

  for (const s of SCREENS) {
    const context = await browser.newContext({
      viewport: { width: s.w, height: s.h },
      deviceScaleFactor: 1,
    });
    // Hard block the live backend port; fulfill all API from fixtures.
    await context.route('**://127.0.0.1:4000/**', (r) => r.abort());
    await context.route('**://localhost:4000/**', (r) => r.abort());
    await context.route('**/api/**', fulfillApi);
    if (s.auth !== false) {
      // Runs in the browser context (before app scripts) to seed the session.
      await context.addInitScript((session) => {
        try {
          // eslint-disable-next-line no-undef
          localStorage.setItem('cowork-session', session);
        } catch {
          /* storage unavailable */
        }
      }, SESSION);
    }
    if (s.collapsed) {
      await context.addInitScript(() => {
        try {
          // eslint-disable-next-line no-undef
          localStorage.setItem('oc-sidebar-collapsed', '1');
        } catch {
          /* storage unavailable */
        }
      });
    }
    // Seed the theme preference so the footer switcher's active state matches.
    await context.addInitScript((theme) => {
      try {
        // eslint-disable-next-line no-undef
        localStorage.setItem('oc-theme', theme);
      } catch {
        /* storage unavailable */
      }
    }, s.theme);
    if (s.desktop) {
      await context.addInitScript((screens) => {
        // eslint-disable-next-line no-undef
        window.cowork = {
          platform: 'desktop',
          startLocalRun: async () => ({ runId: 'r1' }),
          cancelLocalRun: async () => undefined,
          listScreens: async () => screens ?? [],
        };
      }, s.screens ?? null);
    }
    if (s.manyRuns) {
      const many = Array.from({ length: 30 }, (_, i) =>
        run({
          id: `rm${i}`,
          status: ['running', 'succeeded', 'awaiting_human', 'failed'][i % 4],
          task: `Task ${i + 1} — reconcile, validate, and file the result`,
          costCents: (i * 37) % 600,
          stepsCompleted: (i % 12) + 1,
        }),
      );
      // Registered after the general route, so it wins for this exact path.
      await context.route('**/api/runs', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ runs: many }),
        }),
      );
    }
    if (s.coastyKey) {
      await context.route('**/api/config/coasty-key', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(s.coastyKey),
        }),
      );
    }
    if (s.noMachines) {
      await context.route('**/api/machines', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ machines: [] }),
        }),
      );
    }
    const page = await context.newPage();
    await page.goto(`${BASE_URL}${s.path}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.evaluate((t) => {
      // eslint-disable-next-line no-undef
      document.documentElement.dataset.theme = t;
    }, s.theme);
    if (s.scroll) {
      await page.evaluate(() => {
        // eslint-disable-next-line no-undef
        const m = document.querySelector('.app-main');
        if (m) m.scrollTop = m.scrollHeight;
      });
    }
    if (s.typeTask) {
      await page.fill('textarea[aria-label="Task"]', s.typeTask).catch(() => {});
    }
    if (s.openMachine) {
      await page.click('[role="combobox"][aria-label="Machine"]').catch(() => {});
    }
    if (s.selectLocal) {
      // Choose the local "This computer" target so the Screen selector appears.
      await page.click('[role="combobox"][aria-label="Machine"]').catch(() => {});
      await page
        .getByRole('option', { name: /this computer/i })
        .click()
        .catch(() => {});
    }
    if (s.openScreen) {
      await page.click('[role="combobox"][aria-label="Screen"]').catch(() => {});
    }
    if (s.expandScreen) {
      // Let the first live frame land so the expand button is enabled.
      await page.waitForTimeout(300);
      await page.click('.oc-chat__screen-btn').catch(() => {});
    }
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, `${s.name}.png`), fullPage: !s.scroll });
    console.log(`shot ${s.name} (${s.w}×${s.h}, ${s.theme})`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`\nWrote ${SCREENS.length} screens to ${OUT}`);
