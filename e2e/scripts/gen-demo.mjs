#!/usr/bin/env node
/**
 * Generate the README demo GIF: a clean, professional walkthrough of open-cowork
 * delegating a task and driving Chrome on a cloud machine — the real built SPA,
 * not a mockup of it.
 *
 * Like render-screens.mjs it stays 100% offline and live-key-safe. The built SPA
 * calls its API at same-origin relative paths, so the real guard is the catch-all
 * `/api` route below: it fulfils EVERY /api request from the in-memory fixtures
 * here — in the browser, before it can reach vite preview's /api proxy (which
 * would otherwise forward to the backend on :4000 that holds the live key).
 * Aborting :4000 directly is belt-and-suspenders; same-origin SPA traffic never
 * addresses it. The "Chrome" on the machine's screen is a self-contained HTML
 * mock rendered to PNG here (no network, no real browser automation, no spend).
 *
 * Usage (preview server must already be running on BASE_URL):
 *   pnpm --filter @open-cowork/web build
 *   pnpm --filter @open-cowork/web preview --port 4188 --strictPort   # background
 *   BASE_URL=http://127.0.0.1:4188 \
 *     pnpm --filter @open-cowork/e2e exec node scripts/gen-demo.mjs
 *
 * Requires ffmpeg on PATH for the GIF encode. Not part of the build — run
 * occasionally and commit public/demo.gif, like gen-brand-assets.mjs.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4188';
// Scratch frames live in the OS temp dir (not the repo / OneDrive — which locks
// the folder and breaks cleanup); only the final GIF lands in the repo.
const FRAMES = path.join(os.tmpdir(), 'oc-demo-frames');
const GIF = path.resolve(REPO, 'public', 'demo.gif');

const APP = { w: 1280, h: 800 }; // app capture size (side-by-side run view needs >980)
const SCREEN = { w: 1280, h: 800 }; // the machine's "Chrome" frame

// ─────────────────────────────────────────────────────────────────────────────
// The "Chrome" the agent drives — a self-contained HTML browser shell + page.
// ─────────────────────────────────────────────────────────────────────────────

const ICON = {
  back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#bdc1c6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  reload:
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#5f6368" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};

/** Full 1280×800 Chrome window: tab strip + toolbar + page body. */
function chromeShell(url, body, { tab = 'Google Flights' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${SCREEN.w}px;height:${SCREEN.h}px;overflow:hidden;
    font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#202124;background:#fff}
  .win{display:flex;flex-direction:column;height:100%}
  .tabs{height:44px;background:#dee1e6;display:flex;align-items:flex-end;padding:0 8px;gap:2px}
  .tab{height:34px;background:#fff;border-radius:10px 10px 0 0;display:flex;align-items:center;
    gap:9px;padding:0 14px;min-width:210px;max-width:240px;margin-top:10px;box-shadow:0 -1px 2px rgba(0,0,0,.04)}
  .tab .fav{width:15px;height:15px;border-radius:50%;background:linear-gradient(135deg,#4285f4,#34a853);flex:0 0 auto}
  .tab .t{font-size:12.5px;color:#3c4043;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tab .x{margin-left:auto;color:#80868b;font-size:15px;line-height:1}
  .newtab{margin:0 0 4px 6px;color:#5f6368;font-size:20px;line-height:1;align-self:center}
  .toolbar{height:48px;background:#fff;border-bottom:1px solid #e6e8eb;display:flex;align-items:center;
    gap:6px;padding:0 12px}
  .nav{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center}
  .nav:hover{background:#f1f3f4}
  .omni{flex:1;height:32px;background:#f1f3f4;border-radius:16px;display:flex;align-items:center;
    gap:9px;padding:0 14px;margin:0 6px}
  .omni .u{font-size:13.5px;color:#202124}.omni .u b{color:#5f6368;font-weight:400}
  .tb-r{display:flex;align-items:center;gap:10px}
  .tb-r .star{color:#5f6368;font-size:17px}
  .avatar{width:26px;height:26px;border-radius:50%;background:#1a73e8;color:#fff;font-size:12px;font-weight:600;
    display:flex;align-items:center;justify-content:center}
  .page{flex:1;overflow:hidden;background:#fff}
  </style></head><body><div class="win">
    <div class="tabs">
      <div class="tab"><span class="fav"></span><span class="t">${tab}</span><span class="x">×</span></div>
      <span class="newtab">+</span>
    </div>
    <div class="toolbar">
      <span class="nav">${ICON.back}</span>
      <span class="nav">${ICON.fwd}</span>
      <span class="nav">${ICON.reload}</span>
      <div class="omni">${ICON.lock}<span class="u">${url}</span></div>
      <div class="tb-r"><span class="star">☆</span><div class="avatar">A</div></div>
    </div>
    <div class="page">${body}</div>
  </div></body></html>`;
}

/** Chrome's new-tab page — Google search box centred. */
function bodyNewTab() {
  return `<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;background:#fff">
    <div style="font-size:64px;font-weight:500;letter-spacing:-1px">
      <span style="color:#4285f4">G</span><span style="color:#ea4335">o</span><span style="color:#fbbc05">o</span><span style="color:#4285f4">g</span><span style="color:#34a853">l</span><span style="color:#ea4335">e</span>
    </div>
    <div style="width:560px;height:50px;border:1px solid #dfe1e5;border-radius:25px;display:flex;align-items:center;padding:0 22px;gap:14px;box-shadow:0 1px 6px rgba(32,33,36,.10)">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#9aa0a6" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3" stroke-linecap="round"/></svg>
      <span style="color:#3c4043;font-size:16px">google flights sfo to jfk</span>
    </div>
  </div>`;
}

const FLIGHTS_HEADER = `<div style="display:flex;align-items:center;gap:12px;padding:16px 28px;border-bottom:1px solid #ebedf0">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16l20-7-9 13-2-6-9-0z" transform="rotate(8 12 12)"/></svg>
    <span style="font-size:19px;color:#5f6368">Flights</span>
  </div>`;

/** The search panel, optionally filled in. */
function bodyFlights({ filled }) {
  const from = filled ? 'San Francisco (SFO)' : 'Where from?';
  const to = filled ? 'New York (JFK)' : 'Where to?';
  const fromC = filled ? '#202124' : '#80868b';
  const date = filled ? 'Fri, Jun 20' : 'Departure';
  const dateC = filled ? '#202124' : '#80868b';
  const field = (label, val, c) =>
    `<div style="flex:1;border:1px solid #dadce0;border-radius:8px;padding:11px 14px;display:flex;flex-direction:column;gap:2px">
       <span style="font-size:11px;color:#5f6368">${label}</span>
       <span style="font-size:15px;color:${c}">${val}</span>
     </div>`;
  return `${FLIGHTS_HEADER}
  <div style="padding:34px 28px">
    <div style="font-size:30px;font-weight:400;color:#202124;margin-bottom:22px">Find the best fare</div>
    <div style="background:#fff;border:1px solid #dadce0;border-radius:12px;padding:18px;box-shadow:0 1px 5px rgba(32,33,36,.08);max-width:1180px">
      <div style="display:flex;gap:18px;margin-bottom:14px;font-size:13px;color:#5f6368">
        <span style="color:#1a73e8;font-weight:600;border-bottom:2px solid #1a73e8;padding-bottom:4px">Round trip</span>
        <span>1 adult</span><span>Economy</span>
        <span style="margin-left:auto;color:${filled ? '#1a73e8' : '#5f6368'};font-weight:${filled ? 600 : 400}">✓ Nonstop only</span>
      </div>
      <div style="display:flex;gap:12px">
        ${field('From', from, fromC)}${field('To', to, fromC)}${field('Depart', date, dateC)}
        <div style="background:#1a73e8;color:#fff;border-radius:8px;padding:0 26px;display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3" stroke-linecap="round"/></svg>Search
        </div>
      </div>
    </div>
  </div>`;
}

/** Results list. `mark` highlights the top three with value tags. */
function bodyResults({ mark = false } = {}) {
  const rows = [
    ['JetBlue', '6:30 AM', '3:11 PM', '5h 41m', '$298', '#1', mark],
    ['Delta', '6:05 AM', '2:33 PM', '5h 28m', '$312', '#2', mark],
    ['American', '9:15 AM', '5:34 PM', '5h 19m', '$356', '#3', mark],
    ['United', '12:40 PM', '9:08 PM', '5h 28m', '$341', '', false],
    ['Alaska', '3:20 PM', '11:46 PM', '5h 26m', '$369', '', false],
  ];
  const tag = { '#1': 'Cheapest', '#2': 'Best value', '#3': 'Fastest' };
  const tagColor = { '#1': '#188038', '#2': '#1a73e8', '#3': '#9334e6' };
  const row = ([air, dep, arr, dur, price, rank, hl]) => `
    <div style="display:flex;align-items:center;gap:18px;padding:16px 20px;border:1px solid ${hl ? '#1a73e8' : '#ebedf0'};
      border-radius:12px;margin-bottom:10px;background:${hl ? '#f6f9ff' : '#fff'};${hl ? 'box-shadow:0 1px 4px rgba(26,115,232,.12)' : ''}">
      <div style="width:30px;height:30px;border-radius:50%;background:#eef1f5;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#5f6368">${air[0]}</div>
      <div style="width:188px"><div style="font-size:16px;color:#202124">${dep} – ${arr}</div><div style="font-size:13px;color:#5f6368">${air}</div></div>
      <div style="width:120px;text-align:center"><div style="font-size:14px;color:#202124">${dur}</div><div style="font-size:12px;color:#5f6368">SFO–JFK</div></div>
      <div style="width:90px;font-size:13px;color:#188038;font-weight:600">Nonstop</div>
      ${rank && hl ? `<div style="font-size:11px;font-weight:700;color:${tagColor[rank]};background:${tagColor[rank]}1a;padding:4px 9px;border-radius:20px">${tag[rank]}</div>` : '<div style="width:0"></div>'}
      <div style="margin-left:auto;text-align:right"><div style="font-size:19px;font-weight:600;color:#202124">${price}</div><div style="font-size:12px;color:#5f6368">round trip</div></div>
    </div>`;
  return `${FLIGHTS_HEADER}
  <div style="padding:22px 28px">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">
      <span style="font-size:15px;color:#5f6368">SFO → JFK · Fri, Jun 20 · Nonstop · 1 adult</span>
    </div>
    <div style="font-size:22px;font-weight:400;color:#202124;margin:8px 0 16px">${mark ? 'Top picks' : 'Best departing flights'} <span style="font-size:14px;color:#5f6368">· 9 nonstop results</span></div>
    ${rows.map(row).join('')}
  </div>`;
}

const CHROME = {
  newtab: () => chromeShell('<b>Search Google or type a URL</b>', bodyNewTab(), { tab: 'New Tab' }),
  landing: () => chromeShell('google.com/travel/<b>flights</b>', bodyFlights({ filled: false })),
  search: () => chromeShell('google.com/travel/<b>flights</b>', bodyFlights({ filled: true })),
  results: () =>
    chromeShell('google.com/travel/<b>flights/search</b>', bodyResults({ mark: false })),
  best: () => chromeShell('google.com/travel/<b>flights/search</b>', bodyResults({ mark: true })),
};

// ─────────────────────────────────────────────────────────────────────────────
// App fixtures + scene script.
// ─────────────────────────────────────────────────────────────────────────────

const ISO = () => new Date().toISOString(); // fresh, so the screen never reads "stale"
const TASK =
  'Open Chrome, find the cheapest nonstop SFO→JFK flight this Friday, and summarize the 3 best options.';

const machine = {
  id: 'm1',
  display_name: 'browser-vm',
  status: 'running',
  os_type: 'linux',
  is_test: false,
  created_at: ISO(),
};

function run(over) {
  return {
    id: 'r1',
    kind: 'coasty',
    machineId: 'm1',
    task: TASK,
    status: 'running',
    cuaVersion: 'v3',
    maxSteps: 12,
    budgetCents: 300,
    costCents: 0,
    stepsCompleted: 0,
    result: null,
    error: null,
    awaitingHumanReason: null,
    createdAt: ISO(),
    finishedAt: null,
    ...over,
  };
}

// Cumulative SSE event log; each scene streams a prefix of this.
const EVENTS = [
  { event: 'status', data: { status: 'running' } },
  { event: 'text', data: { text: 'Opening Chrome on the cloud machine.' } },
  { event: 'action', data: { action: { action_type: 'click' } } },
  { event: 'step', data: { steps_completed: 1 } },
  { event: 'text', data: { text: 'Navigating to Google Flights.' } },
  { event: 'step', data: { steps_completed: 2 } },
  { event: 'text', data: { text: 'Searching SFO → JFK, departing Fri Jun 20, nonstop only.' } },
  { event: 'billing', data: { cost_cents: 10 } },
  { event: 'step', data: { steps_completed: 3 } },
  {
    event: 'text',
    data: { text: 'Reading the 9 nonstop results and comparing price against duration.' },
  },
  { event: 'step', data: { steps_completed: 4 } },
  { event: 'text', data: { text: 'Picking the three best by price, value, and speed.' } },
];

function sse(n) {
  return (
    EVENTS.slice(0, n)
      .map((e, i) => `id: ${i + 1}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}`)
      .join('\n\n') + '\n\n'
  );
}

const DONE_SUMMARY =
  'Cheapest: JetBlue 6:30a, $298 (5h41m). Best value: Delta 6:05a, $312 (5h28m). Fastest: American 9:15a, $356 (5h19m).';

// route → JSON fixtures shared across scenes (overridden per scene where noted).
const GET_BASE = {
  '/api/me': {
    user: { id: 'u1', email: 'you@example.com', budgetCents: 50000 },
    monthSpendCents: 1875,
  },
  '/api/machines': { machines: [machine] },
  '/api/config/coasty-key': { configured: true, mode: 'test', demoMode: false, source: 'env' },
};

const SESSION = JSON.stringify({
  state: { token: 'demo-token', user: { id: 'u1', email: 'you@example.com', budgetCents: 50000 } },
  version: 0,
});

// Each scene: app state + which Chrome frame the machine shows + how long to hold.
const SCENES = [
  { name: 'delegate', path: '/', typeTask: true, hold: 2.0 },
  {
    name: 'open',
    path: '/runs/r1',
    run: run({ stepsCompleted: 0 }),
    n: 2,
    shot: 'newtab',
    hold: 1.5,
  },
  {
    name: 'navigate',
    path: '/runs/r1',
    run: run({ stepsCompleted: 1, costCents: 5 }),
    n: 5,
    shot: 'landing',
    hold: 1.5,
  },
  {
    name: 'search',
    path: '/runs/r1',
    run: run({ stepsCompleted: 2, costCents: 10 }),
    n: 7,
    shot: 'search',
    hold: 1.6,
  },
  {
    name: 'results',
    path: '/runs/r1',
    run: run({ stepsCompleted: 3, costCents: 15 }),
    n: 10,
    shot: 'results',
    hold: 1.7,
  },
  {
    name: 'compare',
    path: '/runs/r1',
    run: run({ stepsCompleted: 4, costCents: 20 }),
    n: 12,
    shot: 'best',
    hold: 1.7,
  },
  {
    name: 'done',
    path: '/runs/r1',
    run: run({
      status: 'succeeded',
      stepsCompleted: 4,
      costCents: 20,
      finishedAt: ISO(),
      result: { passed: true, summary: DONE_SUMMARY },
    }),
    n: 12,
    shot: 'best',
    done: true,
    scrollBottom: true, // land on the summary card — the payoff
    hold: 3.2,
  },
];

async function main() {
  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });
  await mkdir(path.dirname(GIF), { recursive: true });

  const browser = await chromium.launch();

  // 1) Pre-render every distinct Chrome frame to a base64 PNG.
  const shotPage = await browser.newPage({
    viewport: { width: SCREEN.w, height: SCREEN.h },
    deviceScaleFactor: 1,
  });
  const FRAME_B64 = {};
  for (const [key, html] of Object.entries(CHROME)) {
    await shotPage.setContent(html(), { waitUntil: 'networkidle' });
    FRAME_B64[key] = (await shotPage.screenshot({ type: 'png' })).toString('base64');
  }
  await shotPage.close();

  // 2) Capture one app frame per scene from the real built SPA.
  const list = [];
  let i = 0;
  for (const s of SCENES) {
    const ctx = await browser.newContext({
      viewport: { width: APP.w, height: APP.h },
      deviceScaleFactor: 2, // crisp text; scaled back down in the GIF
    });
    await ctx.route('**://127.0.0.1:4000/**', (r) => r.abort());
    await ctx.route('**://localhost:4000/**', (r) => r.abort());
    await ctx.addInitScript((session) => {
      try {
        // eslint-disable-next-line no-undef
        localStorage.setItem('cowork-session', session);
        // eslint-disable-next-line no-undef
        localStorage.setItem('oc-theme', 'dark');
      } catch {
        /* storage unavailable */
      }
    }, SESSION);

    await ctx.route('**/api/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === `/api/runs/r1/events`) {
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sse(s.n ?? 0),
        });
      }
      if (p === '/api/runs/r1' && s.run) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(s.run),
        });
      }
      if (p === '/api/machines/m1/screenshot') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            image_b64: s.shot ? FRAME_B64[s.shot] : '',
            width: SCREEN.w,
            height: SCREEN.h,
            captured_at: new Date().toISOString(),
          }),
        });
      }
      const body = GET_BASE[p];
      if (body !== undefined) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}${s.path}`, { waitUntil: 'networkidle' }).catch(() => {});
    // eslint-disable-next-line no-undef
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));

    if (s.typeTask) {
      await page.fill('textarea[aria-label="Task"]', TASK).catch(() => {});
      await page.click('[role="combobox"][aria-label="Machine"]').catch(() => {});
      await page
        .getByRole('option', { name: /browser-vm/i })
        .click()
        .catch(() => {});
    }

    await page.waitForTimeout(700); // let the screen frame land + render settle
    if (s.scrollBottom) {
      await page.evaluate(() => {
        // eslint-disable-next-line no-undef
        const r = document.querySelector('.run-split__scroll');
        if (r) r.scrollTop = r.scrollHeight;
      });
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(2, '0')}.png`) });
    list.push({ file: `f${String(i).padStart(2, '0')}.png`, hold: s.hold });
    console.log(`scene ${s.name} → f${String(i).padStart(2, '0')}.png`);
    i++;
    await ctx.close();
  }
  await browser.close();

  // 3) Encode the GIF with ffmpeg (per-scene hold via concat; shared palette).
  const concat =
    list.map((f) => `file '${f.file}'\nduration ${f.hold}`).join('\n') +
    `\nfile '${list[list.length - 1].file}'\n`;
  await writeFile(path.join(FRAMES, 'concat.txt'), concat);

  const VF = 'fps=15,scale=1100:-1:flags=lanczos';
  await exec(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'concat.txt',
      '-vf',
      `${VF},palettegen=max_colors=240:stats_mode=diff`,
      'palette.png',
    ],
    { cwd: FRAMES },
  );
  await exec(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'concat.txt',
      '-i',
      'palette.png',
      '-lavfi',
      `${VF}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      '-loop',
      '0',
      GIF,
    ],
    { cwd: FRAMES },
  );

  console.log(`\nWrote ${path.relative(REPO, GIF)}`);
}

await main();
