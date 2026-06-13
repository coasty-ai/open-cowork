/**
 * Runtime Coasty-API-key configuration.
 *
 * The backend can boot with NO key (demo mode against the local mock) and a key
 * can be set/changed/cleared at runtime — no restart. This module owns the
 * read/update surface for that, backed by a mutable "credentials cell" that the
 * single shared CoastyClient resolves from on every call (see server.ts).
 *
 * SECURITY: no route here ever returns, logs, or echoes a key VALUE. Status is
 * pure enums/booleans. The persisted key is write-only (db.setSetting).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  COASTY_KEY_RE,
  keyMode,
  LIVE_BASE_URL,
  type BackendConfig,
  type CoastyKeyMode,
} from '../config';
import type { Db } from '../db';
import { AppError } from '../errors';

/** The single setting key under which the runtime Coasty key is persisted. */
export const COASTY_KEY_SETTING = 'coasty_api_key';

/** Where the currently-active Coasty key came from. */
export type KeySource = 'runtime' | 'env' | 'demo';

/**
 * The mutable credentials the running CoastyClient resolves on every call. The
 * config endpoints mutate this in place; the client's getters read it live, so
 * the Ingestor and all routes (which share the one client) pick up changes
 * immediately. `key`/`baseUrl` are the live credentials; the rest is metadata
 * used only to derive the (secret-free) status response.
 */
export interface CoastyCredentials {
  /** The active API key VALUE — never serialized to a client. */
  key: string;
  /** The active upstream base URL. */
  baseUrl: string;
  /** Where `key` came from. */
  source: KeySource;
  /** Running on the mock with no real key. */
  demoMode: boolean;
}

/** The secret-free public status of the active Coasty key. */
export interface CoastyKeyStatus {
  configured: boolean;
  mode: CoastyKeyMode | null;
  demoMode: boolean;
  source: KeySource;
}

/**
 * Resolve where the boot-time key should come from and build the initial cell.
 * Precedence: persisted runtime key > env key (when not demo) > demo/mock.
 */
export function resolveBootCredentials(config: BackendConfig, db: Db): CoastyCredentials {
  const persisted = db.getSetting(COASTY_KEY_SETTING)?.trim();
  // Only honor a persisted key that still matches the canonical shape; a corrupt
  // row must never wedge boot — fall through to env/demo instead.
  if (persisted && COASTY_KEY_RE.test(persisted)) {
    return {
      key: persisted,
      baseUrl: runtimeBaseUrl(config),
      source: 'runtime',
      demoMode: false,
    };
  }
  if (!config.demoMode) {
    // A real env key was supplied — config already resolved its base URL.
    return {
      key: config.coastyApiKey,
      baseUrl: config.coastyBaseUrl,
      source: 'env',
      demoMode: false,
    };
  }
  // Demo: the ephemeral sandbox key + mock base URL that loadConfig synthesized.
  return {
    key: config.coastyApiKey,
    baseUrl: config.coastyBaseUrl,
    source: 'demo',
    demoMode: true,
  };
}

/**
 * The base URL to use when a runtime key is applied: LIVE, unless the operator
 * explicitly pinned COASTY_BASE_URL (then honor that — e.g. pointing a runtime
 * key at the local mock for testing). Uses the resolved config (not
 * `process.env`) so injected test environments behave the same as production.
 */
function runtimeBaseUrl(config: BackendConfig): string {
  return config.explicitBaseUrl ?? LIVE_BASE_URL;
}

/** Derive the secret-free status from the live credentials cell. */
export function statusFromCredentials(cell: CoastyCredentials): CoastyKeyStatus {
  // "configured" === a REAL key is active (env or runtime), i.e. not the demo
  // ephemeral key.
  const configured = cell.source !== 'demo';
  return {
    configured,
    mode: configured ? keyMode(cell.key) : null,
    demoMode: cell.demoMode,
    source: cell.source,
  };
}

export interface ConfigRouteDeps {
  config: BackendConfig;
  db: Db;
  /** The shared, mutable credentials cell the running CoastyClient reads from. */
  credentials: CoastyCredentials;
}

const postSchema = z.object({ apiKey: z.string() });

export function registerConfigRoutes(app: FastifyInstance, deps: ConfigRouteDeps): void {
  const { config, db, credentials } = deps;

  // GET — PUBLIC (login screen calls it pre-auth). Secret-free status only.
  app.get('/api/config/coasty-key', async () => statusFromCredentials(credentials));

  // POST — AUTH required. Set/rotate the runtime key. Never echoes the value.
  app.post('/api/config/coasty-key', async (request, reply) => {
    const { apiKey } = postSchema.parse(request.body);
    const key = apiKey.trim();
    if (!COASTY_KEY_RE.test(key)) {
      // Do NOT crash — return a clean 400 with a stable code.
      throw new AppError(
        400,
        'INVALID_KEY_FORMAT',
        'apiKey must be a Coasty key (sk-coasty-live-*, sk-coasty-test-*, cua_sk_*)',
      );
    }
    // Persist write-only, then apply live by mutating the shared cell in place.
    db.setSetting(COASTY_KEY_SETTING, key);
    credentials.key = key;
    credentials.baseUrl = runtimeBaseUrl(config);
    credentials.source = 'runtime';
    credentials.demoMode = false;

    // Return the SAME full status shape as GET/DELETE (incl. demoMode) so the
    // client persists a complete, well-typed CoastyKeyStatus.
    void reply.status(200);
    return { ok: true, ...statusFromCredentials(credentials) };
  });

  // DELETE — AUTH required. Clear the runtime key → revert to env (if present)
  // else demo/mock. Returns the same shape as GET.
  app.delete('/api/config/coasty-key', async () => {
    db.deleteSetting(COASTY_KEY_SETTING);
    const reverted = resolveBootCredentials(config, db);
    credentials.key = reverted.key;
    credentials.baseUrl = reverted.baseUrl;
    credentials.source = reverted.source;
    credentials.demoMode = reverted.demoMode;
    return statusFromCredentials(credentials);
  });
}
