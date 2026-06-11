/**
 * Coasty webhook signature signing + verification.
 *
 * Scheme (llms.txt §4 Webhooks): header `Coasty-Signature: t=<unix>,v1=<hex>`,
 * signed payload `"<t>." + raw_request_body`, HMAC-SHA256 keyed with the
 * per-run `webhook_secret`. Verification uses a constant-time comparison and a
 * timestamp tolerance window (default 5 minutes, matching the documented replay
 * window) in BOTH directions — stale and future timestamps are rejected.
 *
 * Isomorphic: Web Crypto only (works in Node ≥20 and browsers).
 */

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison over UTF-8 bytes. Always processes the full
 * longer length so content differences don't change timing; length mismatch
 * still returns false.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

export interface SignWebhookOptions {
  secret: string;
  /** Raw request body, exactly as it will be sent. */
  body: string;
  /** Unix seconds. Default: now. */
  timestamp?: number;
}

/** Produce a `Coasty-Signature` header value: `t=<unix>,v1=<hex>`. */
export async function signWebhookPayload(opts: SignWebhookOptions): Promise<string> {
  const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const v1 = await hmacSha256Hex(opts.secret, `${t}.${opts.body}`);
  return `t=${t},v1=${v1}`;
}

export type WebhookVerifyFailure =
  | 'malformed_header'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'future_timestamp';

export interface VerifyWebhookOptions {
  /** Raw request body EXACTLY as received (do not re-serialize parsed JSON). */
  body: string;
  /** The `Coasty-Signature` header value. */
  header: string;
  secret: string;
  /** Allowed clock skew in seconds, both directions. Default 300 (5 min). */
  toleranceSeconds?: number;
  /** Injectable clock, unix seconds. Default: now. */
  now?: () => number;
}

export interface VerifyWebhookResult {
  valid: boolean;
  reason?: WebhookVerifyFailure;
  timestamp?: number;
}

/**
 * Verify a webhook signature. Accepts multiple `v1=` entries (key-rotation
 * style); any matching signature passes. Timestamp is validated BEFORE the
 * HMAC result is consulted, but the HMAC is always computed to keep timing
 * uniform.
 */
export async function verifyWebhookSignature(opts: VerifyWebhookOptions): Promise<VerifyWebhookResult> {
  const { body, header, secret, toleranceSeconds = 300 } = opts;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) {
    return { valid: false, reason: 'malformed_header' };
  }
  let t: number | undefined;
  const v1s: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) return { valid: false, reason: 'malformed_header' };
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') {
      const parsed = Number(v);
      if (!Number.isInteger(parsed) || parsed <= 0) return { valid: false, reason: 'malformed_header' };
      t = parsed;
    } else if (k === 'v1') {
      if (!/^[0-9a-f]{64}$/i.test(v)) return { valid: false, reason: 'malformed_header' };
      v1s.push(v.toLowerCase());
    }
    // Unknown schemes (v0, ...) are ignored for forward compatibility.
  }
  if (t === undefined || v1s.length === 0) return { valid: false, reason: 'malformed_header' };

  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  const signatureMatches = v1s.some((candidate) => timingSafeEqualHex(expected, candidate));

  const age = now() - t;
  if (age > toleranceSeconds) return { valid: false, reason: 'stale_timestamp', timestamp: t };
  if (age < -toleranceSeconds) return { valid: false, reason: 'future_timestamp', timestamp: t };

  if (!signatureMatches) return { valid: false, reason: 'bad_signature', timestamp: t };
  return { valid: true, timestamp: t };
}
