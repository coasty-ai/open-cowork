/**
 * Optional LIVE smoke tests against the real Coasty API.
 *
 * Skipped unless BOTH are true:
 *   - COWORK_RUN_LIVE=1
 *   - COASTY_API_KEY is a SANDBOX key (sk-coasty-test-*) — sandbox keys never
 *     bill, and this suite refuses to run with a live key at all.
 *
 * Only free or sandbox-billed endpoints are exercised; nothing here can spend.
 */
import { describe, expect, it } from 'vitest';
import { CoastyClient } from '../src/index';

const key = process.env.COASTY_API_KEY ?? '';
const enabled = process.env.COWORK_RUN_LIVE === '1' && key.startsWith('sk-coasty-test-');

describe.runIf(enabled)('live sandbox smoke (opt-in, never bills)', () => {
  const client = new CoastyClient({
    baseUrl: process.env.COASTY_BASE_URL ?? 'https://coasty.ai/v1',
    apiKey: key,
    timeoutMs: 30_000,
  });

  it('GET /v1/models returns the documented catalog', async () => {
    const models = await client.models();
    expect(models.action_types).toContain('click');
    expect(models.cua_versions.length).toBeGreaterThan(0);
  }, 60_000);

  it('POST /v1/parse is free and deterministic', async () => {
    const parsed = await client.parse('pyautogui.click(100, 200)');
    expect(parsed.actions[0]).toMatchObject({ action_type: 'click' });
  }, 60_000);

  it('GET /v1/usage reports a wallet (sandbox: never debited by this suite)', async () => {
    const usage = await client.usage();
    expect(typeof usage.wallet_balance_cents).toBe('number');
  }, 60_000);

  it('sandbox machine provision is instant and free', async () => {
    const res = await client.createMachine(
      { display_name: 'cowork-live-smoke', ttl_minutes: 5 },
      { idempotencyKey: `cowork-smoke-${Date.now()}` },
    );
    expect(res.machine.is_test).toBe(true);
    await client.terminateMachine(res.machine.id);
  }, 120_000);
});

describe.runIf(!enabled)('live sandbox smoke (skipped)', () => {
  it('skips cleanly without COWORK_RUN_LIVE=1 + a sandbox key', () => {
    expect(enabled).toBe(false);
  });
});
