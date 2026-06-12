/**
 * Backend configuration. The ONLY place in the entire product that reads
 * COASTY_API_KEY. Values come from the environment (.env is loaded by the
 * entrypoint); everything is validated up front so misconfiguration fails
 * loudly at boot, not at request time.
 */
import { z } from 'zod';

const configSchema = z.object({
  /** Coasty API key — never logged, never returned by any route. */
  coastyApiKey: z
    .string()
    .min(8)
    .refine((k) => /^(sk-coasty-(live|test)-|cua_sk_)/.test(k), {
      message: 'COASTY_API_KEY must be a Coasty key (sk-coasty-live-*, sk-coasty-test-*, cua_sk_*)',
    }),
  coastyBaseUrl: z.string().url().default('https://coasty.ai/v1'),
  port: z.coerce.number().int().min(1).max(65535).default(4000),
  host: z.string().default('127.0.0.1'),
  /** Public URL Coasty calls back with webhooks (https required in production). */
  publicUrl: z.string().url().default('http://127.0.0.1:4000'),
  /** SQLite file path, or ':memory:' for tests. */
  dbPath: z.string().default('./data/cowork.sqlite'),
  /** Signs nothing itself (tokens are random); kept for future use + must be set. */
  sessionSecret: z.string().min(16),
  /** Server-enforced default per-run budget cap, cents. */
  defaultBudgetCents: z.coerce.number().int().min(1).default(500),
  /** Session token lifetime in seconds. Default 7 days. */
  sessionTtlSeconds: z.coerce.number().int().min(60).default(7 * 24 * 3600),
});

export type BackendConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = configSchema.safeParse({
    coastyApiKey: env.COASTY_API_KEY,
    coastyBaseUrl: env.COASTY_BASE_URL,
    port: env.COWORK_PORT,
    host: env.COWORK_HOST,
    publicUrl: env.COWORK_PUBLIC_URL,
    dbPath: env.COWORK_DB_PATH,
    sessionSecret: env.COWORK_SESSION_SECRET,
    defaultBudgetCents: env.COWORK_DEFAULT_BUDGET_CENTS,
    sessionTtlSeconds: env.COWORK_SESSION_TTL_SECONDS,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid backend configuration: ${issues}`);
  }
  if (parsed.data.coastyApiKey.startsWith('sk-coasty-live-') && !parsed.data.publicUrl.startsWith('https://')) {
    // Loud warning, not fatal: local development against live keys is legal but risky.
    console.warn(
      '[config] WARNING: live Coasty key with a non-https COWORK_PUBLIC_URL — webhooks require https in production.',
    );
  }
  return parsed.data;
}
