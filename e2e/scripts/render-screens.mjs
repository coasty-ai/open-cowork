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
  '/api/machines': { machines: MACHINES },
  '/api/machines/m1/screenshot': { image_b64: '', width: 1280, height: 800, captured_at: ISO },
  '/api/workflows': { workflows: WORKFLOWS },
  '/api/workflows/runs': { runs: [] },
};

async function fulfillApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  // The reference run's timeline streams a representative set of events; other
  // SSE streams hand back an empty, well-formed event-stream and close.
  if (p === '/api/runs/r1/events') {
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: TIMELINE_SSE });
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
  { name: 'machines', path: '/machines', theme: 'dark', w: 1280, h: 900 },
  { name: 'settings', path: '/settings', theme: 'dark', w: 1280, h: 900 },
  { name: 'workflows', path: '/workflows', theme: 'dark', w: 1280, h: 900 },
  { name: 'home-light', path: '/', theme: 'light', w: 1280, h: 900 },
  { name: 'runs-light', path: '/runs', theme: 'light', w: 1280, h: 900 },
  { name: 'run-detail-light', path: '/runs/r1', theme: 'light', w: 1280, h: 1040 },
  { name: 'run-detail-tablet', path: '/runs/r1', theme: 'dark', w: 820, h: 1180 },
  { name: 'runs-mobile', path: '/runs', theme: 'dark', w: 390, h: 900 },
  { name: 'home-collapsed', path: '/', theme: 'dark', w: 1280, h: 900, collapsed: true },
  { name: 'home-collapsed-light', path: '/', theme: 'light', w: 1280, h: 900, collapsed: true },
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
    const page = await context.newPage();
    await page.goto(`${BASE_URL}${s.path}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.evaluate((t) => {
      // eslint-disable-next-line no-undef
      document.documentElement.dataset.theme = t;
    }, s.theme);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, `${s.name}.png`), fullPage: true });
    console.log(`shot ${s.name} (${s.w}×${s.h}, ${s.theme})`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`\nWrote ${SCREENS.length} screens to ${OUT}`);
