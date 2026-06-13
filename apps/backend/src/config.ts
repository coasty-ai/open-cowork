/**
 * Backend configuration. The ONLY place in the entire product that reads
 * COASTY_API_KEY. Values come from the environment (.env is loaded by the
 * entrypoint); everything is validated up front so misconfiguration fails
 * loudly at boot, not at request time.
 *
 * ONE-KEY SETUP CONTRACT (see README):
 *   - Provide ONLY `COASTY_API_KEY` and the whole product works end-to-end.
 *     Every other setting has a working default; the session secret is
 *     auto-generated if you don't pin one.
 *   - Provide NOTHING at all and the backend boots in DEMO MODE: it mints an
 *     ephemeral sandbox key and points at the bundled mock Coasty server
 *     (`pnpm dev` starts that mock for you). Zero spend, zero accounts.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const MOCK_BASE_URL = 'http://127.0.0.1:4010/v1';
export const LIVE_BASE_URL = 'https://coasty.ai/v1';

/**
 * The one canonical Coasty key shape. Exported so the runtime-config route can
 * validate a user-supplied key with the EXACT same rule the boot path uses.
 */
export const COASTY_KEY_RE = /^(sk-coasty-(live|test)-[0-9a-fA-F]{8,}|cua_sk_[0-9a-fA-F]{8,})$/;

/** The "mode" of a key, derived solely from its prefix. */
export type CoastyKeyMode = 'live' | 'test' | 'legacy';

/**
 * Derive the key mode from its prefix, or null for anything that doesn't match a
 * known prefix. Returns ONLY an enum — never the key value — so it is safe to
 * surface in API responses/logs.
 */
export function keyMode(key: string | null | undefined): CoastyKeyMode | null {
  if (!key) return null;
  if (key.startsWith('sk-coasty-live-')) return 'live';
  if (key.startsWith('sk-coasty-test-')) return 'test';
  if (key.startsWith('cua_sk_')) return 'legacy';
  return null;
}

const configSchema = z.object({
  /** Coasty API key — never logged, never returned by any route. */
  coastyApiKey: z.string().regex(COASTY_KEY_RE, {
    message: 'COASTY_API_KEY must be a Coasty key (sk-coasty-live-*, sk-coasty-test-*, cua_sk_*)',
  }),
  coastyBaseUrl: z.string().url(),
  port: z.coerce.number().int().min(1).max(65535).default(4000),
  host: z.string().default('127.0.0.1'),
  /** Public URL Coasty calls back with webhooks (https required in production). */
  publicUrl: z.string().url().default('http://127.0.0.1:4000'),
  /** SQLite file path, or ':memory:' for tests. */
  dbPath: z.string().default('./data/cowork.sqlite'),
  /**
   * Secret backing client session tokens. Optional: if unset, a random one is
   * generated at boot (tokens then do not survive a restart — fine for dev,
   * set it explicitly in production for durable sessions). Min 16 chars when
   * provided.
   */
  sessionSecret: z.string().min(16),
  /** Server-enforced default per-run budget cap, cents. */
  defaultBudgetCents: z.coerce.number().int().min(1).default(500),
  /** Session token lifetime in seconds. Default 7 days. */
  sessionTtlSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .default(7 * 24 * 3600),
});

export interface BackendConfig extends z.infer<typeof configSchema> {
  /** True when no COASTY_API_KEY was supplied and we fell back to the mock. */
  demoMode: boolean;
  /** True when the resolved key is a sandbox key (never bills). */
  sandbox: boolean;
  /**
   * The webhook URL to register with Coasty for runs/workflow runs, or `null`
   * when we must not send one. Coasty requires HTTPS webhook URLs, so a
   * non-https `COWORK_PUBLIC_URL` (the local-dev default) would make the real
   * API reject every run with a validation error. We therefore send a webhook
   * URL only when `COWORK_PUBLIC_URL` is https, OR when the upstream is the
   * local mock (which accepts http). When null, run state still converges via
   * the SSE ingestor + read-time reconcile — webhooks are an optimization.
   */
  webhookUrl: string | null;
  /**
   * The base URL the operator explicitly pinned via `COASTY_BASE_URL`, or null
   * if none. Runtime key changes default to the LIVE base URL, but honor this
   * override when present (e.g. pointing a runtime key at the local mock). Kept
   * separate from `coastyBaseUrl` (which is the *resolved* boot URL) so the
   * runtime-config path doesn't have to re-read `process.env`.
   */
  explicitBaseUrl: string | null;
}

const LOCAL_UPSTREAM_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

/** Generate a syntactically valid sandbox key for demo mode (the mock accepts any). */
function ephemeralSandboxKey(): string {
  return `sk-coasty-test-${randomBytes(24).toString('hex')}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const rawKey = env.COASTY_API_KEY?.trim() || undefined;
  const demoMode = rawKey === undefined;

  // Demo mode: mint a sandbox key and point at the local mock unless the user
  // explicitly set a base URL.
  const coastyApiKey = rawKey ?? ephemeralSandboxKey();
  const explicitBaseUrl = env.COASTY_BASE_URL?.trim() || null;
  const coastyBaseUrl = explicitBaseUrl ?? (demoMode ? MOCK_BASE_URL : LIVE_BASE_URL);

  // Session secret is optional — auto-generate when absent so the one-key
  // setup needs nothing else.
  const sessionSecret = env.COWORK_SESSION_SECRET?.trim() || randomBytes(32).toString('hex');

  const parsed = configSchema.safeParse({
    coastyApiKey,
    coastyBaseUrl,
    port: env.COWORK_PORT,
    host: env.COWORK_HOST,
    publicUrl: env.COWORK_PUBLIC_URL,
    dbPath: env.COWORK_DB_PATH,
    sessionSecret,
    defaultBudgetCents: env.COWORK_DEFAULT_BUDGET_CENTS,
    sessionTtlSeconds: env.COWORK_SESSION_TTL_SECONDS,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid backend configuration: ${issues}`);
  }

  const sandbox = coastyApiKey.startsWith('sk-coasty-test-');
  const publicIsHttps = parsed.data.publicUrl.startsWith('https://');
  const upstreamIsLocal = LOCAL_UPSTREAM_RE.test(parsed.data.coastyBaseUrl);
  // Coasty rejects non-https webhook URLs. Only register one when we have a
  // public https URL, or when the upstream is the local mock (accepts http).
  const webhookUrl =
    publicIsHttps || upstreamIsLocal ? `${parsed.data.publicUrl}/webhooks/coasty` : null;

  if (!publicIsHttps && !upstreamIsLocal) {
    // Talking to the real Coasty API over a non-https public URL: webhooks
    // can't be registered (they require https). Not fatal — run/workflow state
    // still syncs via the SSE ingestor + read reconcile.
    console.warn(
      '[config] COWORK_PUBLIC_URL is not https — Coasty webhooks are disabled (state still syncs via SSE). Set an https COWORK_PUBLIC_URL to enable instant webhook updates.',
    );
  }
  if (!env.COWORK_SESSION_SECRET?.trim()) {
    console.warn(
      '[config] No COWORK_SESSION_SECRET set — generated an ephemeral one. Sessions will not survive a restart; set COWORK_SESSION_SECRET in production.',
    );
  }

  return { ...parsed.data, demoMode, sandbox, webhookUrl, explicitBaseUrl };
}
