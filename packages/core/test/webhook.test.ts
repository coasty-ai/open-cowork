import { describe, expect, it } from 'vitest';
import { signWebhookPayload, timingSafeEqualHex, verifyWebhookSignature } from '../src/webhook';

const SECRET = 'whsec_test_secret_0123456789abcdef';
const BODY = JSON.stringify({ event: 'run.succeeded', run: { id: 'run_1' } });

describe('webhook HMAC vectors', () => {
  it('sign → verify roundtrip is valid', async () => {
    const now = 1_750_000_000;
    const header = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: now });
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      now: () => now,
    });
    expect(result).toEqual({ valid: true, timestamp: now });
  });

  it('matches a known Stripe-style vector computed independently', async () => {
    // HMAC-SHA256("secret", "1." + "body") — verified against node:crypto.
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', 'secret').update('1.body').digest('hex');
    const header = await signWebhookPayload({ secret: 'secret', body: 'body', timestamp: 1 });
    expect(header).toBe(`t=1,v1=${expected}`);
  });

  it('rejects a tampered body', async () => {
    const now = 1_750_000_000;
    const header = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: now });
    const tampered = BODY.replace('succeeded', 'failed');
    const result = await verifyWebhookSignature({
      body: tampered,
      header,
      secret: SECRET,
      now: () => now,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects the wrong secret', async () => {
    const now = 1_750_000_000;
    const header = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: now });
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: 'whsec_other',
      now: () => now,
    });
    expect(result).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp beyond tolerance (default 300s)', async () => {
    const t = 1_750_000_000;
    const header = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: t });
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      now: () => t + 301,
    });
    expect(result).toMatchObject({ valid: false, reason: 'stale_timestamp' });
  });

  it('accepts exactly at the tolerance boundary', async () => {
    const t = 1_750_000_000;
    const header = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: t });
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      now: () => t + 300,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects timestamps too far in the future (clock-skew attack)', async () => {
    const t = 1_750_000_000;
    const header = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: t + 9999 });
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      now: () => t,
    });
    expect(result).toMatchObject({ valid: false, reason: 'future_timestamp' });
  });

  it('honors a custom tolerance', async () => {
    const t = 1_750_000_000;
    const header = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: t });
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      toleranceSeconds: 10,
      now: () => t + 11,
    });
    expect(result).toMatchObject({ valid: false, reason: 'stale_timestamp' });
  });

  it.each([
    ['empty', ''],
    ['no v1', 't=123'],
    ['no t', 'v1=' + 'a'.repeat(64)],
    ['non-numeric t', 't=abc,v1=' + 'a'.repeat(64)],
    ['negative t', 't=-5,v1=' + 'a'.repeat(64)],
    ['v1 wrong length', 't=123,v1=abcd'],
    ['v1 not hex', 't=123,v1=' + 'z'.repeat(64)],
    ['garbage', 'utterly-not-a-signature'],
  ])('rejects malformed header: %s', async (_name, header) => {
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      now: () => 123,
    });
    expect(result).toMatchObject({ valid: false, reason: 'malformed_header' });
  });

  it('accepts multiple v1 entries when any matches (rotation)', async () => {
    const now = 1_750_000_000;
    const good = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: now });
    const goodV1 = good.split('v1=')[1]!;
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${goodV1}`;
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      now: () => now,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects when no v1 entry matches', async () => {
    const now = 1_750_000_000;
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`;
    const result = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      now: () => now,
    });
    expect(result).toMatchObject({ valid: false, reason: 'bad_signature' });
  });
});

describe('timingSafeEqualHex', () => {
  it('equal strings → true', () => {
    expect(timingSafeEqualHex('abc123', 'abc123')).toBe(true);
  });
  it('different content, same length → false', () => {
    expect(timingSafeEqualHex('abc123', 'abc124')).toBe(false);
  });
  it('different lengths → false', () => {
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
  });
  it('empty vs non-empty → false; empty vs empty → true', () => {
    expect(timingSafeEqualHex('', 'a')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });
});
