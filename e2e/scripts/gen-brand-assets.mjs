#!/usr/bin/env node
/**
 * Rasterize the open-cowork brand mark into the PNG app icons that Electron and
 * Expo need (they can't consume the SVG / `currentColor` mark the UI uses).
 *
 * One source of truth: the same six-stop "horizon" gradient circle as
 * `public/logo_{light,dark}.svg` and `packages/ui` `<Logo>`. Run occasionally
 * and commit the outputs — it is NOT part of the build:
 *
 *   pnpm --filter @open-cowork/e2e exec node scripts/gen-brand-assets.mjs
 *
 * Uses the Chromium that Playwright already installs for the E2E suite.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const BRAND_BG = '#0a0a0a'; // tokens.css --background (neutral near-black)
const MARK_LIGHT = '250, 250, 250'; // --foreground (neutral near-white), for dark backgrounds
const STOPS = [
  [0, 0],
  [25, 0.06],
  [45, 0.18],
  [60, 0.4],
  [80, 0.75],
  [100, 1],
];

/** An SVG string of the horizon mark, `rgb(...)` fill, sized to a viewBox of 200. */
function markSvg(rgb, { scale = 1 } = {}) {
  const r = 100 * scale;
  const stops = STOPS.map(
    ([off, op]) => `<stop offset="${off}%" stop-color="rgb(${rgb})" stop-opacity="${op}"/>`,
  ).join('');
  return `
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="0%" y2="100%">${stops}</linearGradient></defs>
    <circle cx="100" cy="100" r="${r}" fill="url(#g)"/>`;
}

/**
 * Render one PNG. `bg` null → transparent (Android adaptive foreground); a
 * color → full-bleed square fill (iOS/desktop/web favicon, OS rounds it).
 */
async function renderPng(page, { size, bg, rgb, scale }) {
  const bgRect = bg ? `<rect width="200" height="200" fill="${bg}"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}">${bgRect}${markSvg(rgb, { scale })}</svg>`;
  const html = `<!doctype html><html><head><style>*{margin:0;padding:0}</style></head><body>${svg}</body></html>`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html, { waitUntil: 'networkidle' });
  return page.locator('svg').screenshot({ omitBackground: !bg });
}

const TARGETS = [
  // Desktop window / taskbar icon (Windows + Linux). Full-bleed dark, white mark.
  { out: 'apps/desktop/assets/icon.png', size: 512, bg: BRAND_BG, rgb: MARK_LIGHT, scale: 0.74 },
  // Expo: iOS + general app icon, full-bleed dark.
  { out: 'apps/mobile/assets/icon.png', size: 1024, bg: BRAND_BG, rgb: MARK_LIGHT, scale: 0.66 },
  // Expo Android adaptive foreground: transparent, mark inside the ~66% safe zone.
  {
    out: 'apps/mobile/assets/adaptive-icon.png',
    size: 1024,
    bg: null,
    rgb: MARK_LIGHT,
    scale: 0.46,
  },
  // Expo splash (resizeMode contain on a dark backgroundColor).
  { out: 'apps/mobile/assets/splash.png', size: 1024, bg: null, rgb: MARK_LIGHT, scale: 0.5 },
  // Expo web favicon.
  { out: 'apps/mobile/assets/favicon.png', size: 64, bg: BRAND_BG, rgb: MARK_LIGHT, scale: 0.82 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
try {
  for (const t of TARGETS) {
    const buf = await renderPng(page, t);
    const dest = path.join(REPO, t.out);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    console.log(`wrote ${t.out} (${t.size}px, ${buf.length} bytes)`);
  }
} finally {
  await browser.close();
}
