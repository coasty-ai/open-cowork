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

const COASTY_KEY_RE = /^(sk-coasty-(live|test)-[0-9a-fA-F]{8,}|cua_sk_[0-9a-fA-F]{8,})$/;

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
}

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
  const coastyBaseUrl = env.COASTY_BASE_URL?.trim() || (demoMode ? MOCK_BASE_URL : LIVE_BASE_URL);

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
  if (!sandbox && !parsed.data.publicUrl.startsWith('https://')) {
    // Loud warning, not fatal: local development against live keys is legal but risky.
    console.warn(
      '[config] WARNING: live Coasty key with a non-https COWORK_PUBLIC_URL — webhooks require https in production.',
    );
  }
  if (!env.COWORK_SESSION_SECRET?.trim()) {
    console.warn(
      '[config] No COWORK_SESSION_SECRET set — generated an ephemeral one. Sessions will not survive a restart; set COWORK_SESSION_SECRET in production.',
    );
  }

  return { ...parsed.data, demoMode, sandbox };
}
