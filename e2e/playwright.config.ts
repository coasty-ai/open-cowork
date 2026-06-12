/**
 * E2E orchestration: boots the mock Coasty server, the backend (test key,
 * in-memory DB), and the built web app, then runs browser + Electron flows.
 * Fully offline; the sandbox-style key never bills anything.
 */
import { defineConfig } from '@playwright/test';

const CI = Boolean(process.env.CI);
const E2E_TEST_KEY = `sk-coasty-test-${'e'.repeat(48)}`;

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  workers: 1, // flows share one backend; serial keeps state deterministic
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'web', testMatch: /web\.spec\.ts/ },
    { name: 'desktop', testMatch: /desktop\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'pnpm --filter @open-cowork/mock-coasty start',
      url: 'http://127.0.0.1:4010/health',
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: { PORT: '4010' },
    },
    {
      command: 'pnpm --filter @open-cowork/backend start',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: {
        COASTY_API_KEY: E2E_TEST_KEY,
        COASTY_BASE_URL: 'http://127.0.0.1:4010/v1',
        COWORK_PORT: '4000',
        COWORK_PUBLIC_URL: 'http://127.0.0.1:4000',
        COWORK_DB_PATH: ':memory:',
        COWORK_SESSION_SECRET: 'e2e-session-secret-32-chars-min!!',
        COWORK_DEFAULT_BUDGET_CENTS: '500',
      },
    },
    {
      // NOTE: requires a prior `pnpm --filter @open-cowork/web build`
      // (turbo's `e2e` task depends on `build`; CI builds explicitly).
      command: 'pnpm --filter @open-cowork/web preview',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
