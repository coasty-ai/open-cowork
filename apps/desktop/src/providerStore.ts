/**
 * Persisted BYO-LLM provider selection for the desktop. The non-secret config
 * (kind/baseUrl/model/vision/label) lives in a JSON file; the API key is
 * encrypted with Electron `safeStorage` (OS keychain — DPAPI/Keychain/libsecret)
 * and stored as base64 ciphertext beside it. The key is NEVER written in
 * plaintext and NEVER returned in the secret-free `status()`.
 *
 * All I/O + crypto is injected so the logic is unit-testable without Electron;
 * `main.ts` wires the real `safeStorage` + `fs`.
 */
import type { ProviderKind } from '@open-cowork/llm';

const KINDS: ProviderKind[] = ['coasty', 'openai', 'openai-compatible', 'openrouter'];

export interface StoredProviderConfig {
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  vision?: boolean | 'unknown';
  visionOverride?: boolean;
  label?: string;
}

/** Secret-free status the renderer can safely hold. */
export interface ProviderStatus {
  /** The active provider kind ('coasty' when nothing BYO is configured). */
  kind: ProviderKind;
  model: string | null;
  baseUrl?: string;
  label?: string;
  vision?: boolean | 'unknown';
  /** Whether a key is stored (never the value). */
  hasKey: boolean;
  /** True when no BYO provider is configured → Coasty default. */
  isDefault: boolean;
  /** Whether OS-backed key encryption is available on this machine. */
  secureStorage: boolean;
}

export interface ProviderStoreIo {
  read(): string | null;
  write(data: string): void;
  remove(): void;
  /** Encrypt → base64 ciphertext, or null when secure storage is unavailable. */
  encrypt(plain: string): string | null;
  decrypt(cipherB64: string): string | null;
  secureStorageAvailable(): boolean;
}

interface Persisted {
  config: StoredProviderConfig;
  keyEnc?: string;
}

/** Validate an untrusted object into a {@link StoredProviderConfig}, or null. */
export function parseStoredConfig(raw: unknown): StoredProviderConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !KINDS.includes(o.kind as ProviderKind)) return null;
  if (typeof o.model !== 'string' || o.model.trim() === '') return null;
  const vision =
    o.vision === true || o.vision === false || o.vision === 'unknown' ? o.vision : undefined;
  return {
    kind: o.kind as ProviderKind,
    model: o.model,
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : undefined,
    vision,
    visionOverride: o.visionOverride === true ? true : undefined,
    label: typeof o.label === 'string' ? o.label : undefined,
  };
}

const COASTY_DEFAULT_STATUS: ProviderStatus = {
  kind: 'coasty',
  model: null,
  hasKey: false,
  isDefault: true,
  secureStorage: false,
};

export class ProviderStore {
  constructor(private readonly io: ProviderStoreIo) {}

  /** The saved BYO config + decrypted key, or null when none is configured. */
  load(): { config: StoredProviderConfig; apiKey?: string } | null {
    const raw = this.io.read();
    if (!raw) return null;
    let parsed: Persisted;
    try {
      parsed = JSON.parse(raw) as Persisted;
    } catch {
      return null;
    }
    const config = parseStoredConfig(parsed.config);
    if (!config) return null;
    const apiKey = parsed.keyEnc ? (this.io.decrypt(parsed.keyEnc) ?? undefined) : undefined;
    return { config, apiKey };
  }

  /** Persist a BYO config; the key (if given) is encrypted, never plaintext. */
  save(config: StoredProviderConfig, apiKey?: string): void {
    const clean = parseStoredConfig(config);
    if (!clean) throw new Error('Invalid provider config');
    const persisted: Persisted = { config: clean };
    if (apiKey && apiKey.trim()) {
      const enc = this.io.encrypt(apiKey.trim());
      // When secure storage is unavailable we DROP the key rather than persist it
      // in plaintext; the UI surfaces secureStorage=false so the user is informed.
      if (enc) persisted.keyEnc = enc;
    }
    this.io.write(JSON.stringify(persisted));
  }

  /** Remove any BYO config → revert to the Coasty default. */
  clear(): void {
    this.io.remove();
  }

  /** Secret-free status for the renderer. */
  status(): ProviderStatus {
    const secureStorage = this.io.secureStorageAvailable();
    const loaded = this.load();
    if (!loaded) return { ...COASTY_DEFAULT_STATUS, secureStorage };
    const { config, apiKey } = loaded;
    return {
      kind: config.kind,
      model: config.model,
      baseUrl: config.baseUrl,
      label: config.label,
      vision: config.vision,
      hasKey: Boolean(apiKey),
      isDefault: config.kind === 'coasty',
      secureStorage,
    };
  }
}
