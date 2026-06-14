import { describe, expect, it } from 'vitest';
import { ProviderStore, parseStoredConfig, type ProviderStoreIo } from '../src/providerStore';

/** In-memory IO with a reversible "encryption" (base64 with a marker). */
function fakeIo(over: Partial<ProviderStoreIo> = {}): ProviderStoreIo & { file: string | null } {
  const state = { file: null as string | null };
  return {
    get file() {
      return state.file;
    },
    read: () => state.file,
    write: (d) => {
      state.file = d;
    },
    remove: () => {
      state.file = null;
    },
    encrypt: (p) => `enc:${Buffer.from(p).toString('base64')}`,
    decrypt: (c) =>
      c.startsWith('enc:') ? Buffer.from(c.slice(4), 'base64').toString('utf8') : null,
    secureStorageAvailable: () => true,
    ...over,
  };
}

describe('parseStoredConfig', () => {
  it('accepts a valid config', () => {
    expect(
      parseStoredConfig({ kind: 'openrouter', model: 'x', baseUrl: 'http://b', vision: true }),
    ).toEqual({
      kind: 'openrouter',
      model: 'x',
      baseUrl: 'http://b',
      vision: true,
      visionOverride: undefined,
      label: undefined,
    });
  });
  it.each([
    null,
    'str',
    {},
    { kind: 'bogus', model: 'x' },
    { kind: 'openai', model: '' },
    { kind: 'openai' },
  ])('rejects %j', (raw) => {
    expect(parseStoredConfig(raw)).toBeNull();
  });
  it('drops unknown vision values', () => {
    expect(
      parseStoredConfig({ kind: 'openai', model: 'm', vision: 'maybe' })!.vision,
    ).toBeUndefined();
  });
});

describe('ProviderStore', () => {
  it('round-trips a config + encrypted key (never plaintext on disk)', () => {
    const io = fakeIo();
    const store = new ProviderStore(io);
    store.save({ kind: 'openrouter', model: 'm', vision: true }, 'sk-secret-123456');
    expect(io.file).not.toContain('sk-secret-123456'); // encrypted at rest
    const loaded = store.load();
    expect(loaded!.config).toMatchObject({ kind: 'openrouter', model: 'm' });
    expect(loaded!.apiKey).toBe('sk-secret-123456');
  });

  it('status is secret-free and reports hasKey', () => {
    const store = new ProviderStore(fakeIo());
    store.save({ kind: 'openai', model: 'gpt-4o', vision: true }, 'sk-x-123456');
    const s = store.status();
    expect(s).toMatchObject({
      kind: 'openai',
      model: 'gpt-4o',
      hasKey: true,
      isDefault: false,
      secureStorage: true,
    });
    expect(JSON.stringify(s)).not.toContain('sk-x-123456');
  });

  it('no config → Coasty default status', () => {
    const s = new ProviderStore(fakeIo()).status();
    expect(s).toMatchObject({ kind: 'coasty', isDefault: true, hasKey: false });
  });

  it('clear reverts to default', () => {
    const store = new ProviderStore(fakeIo());
    store.save({ kind: 'openai', model: 'm', vision: true }, 'k123456');
    store.clear();
    expect(store.load()).toBeNull();
    expect(store.status().isDefault).toBe(true);
  });

  it('saves config WITHOUT the key when secure storage is unavailable', () => {
    const io = fakeIo({ encrypt: () => null, secureStorageAvailable: () => false });
    const store = new ProviderStore(io);
    store.save({ kind: 'openrouter', model: 'm', vision: true }, 'sk-secret-123456');
    expect(io.file).not.toContain('sk-secret-123456');
    expect(store.load()!.apiKey).toBeUndefined();
    expect(store.status()).toMatchObject({ hasKey: false, secureStorage: false });
  });

  it('a key needing no encryption (Ollama, no key) stores fine', () => {
    const store = new ProviderStore(fakeIo());
    store.save({
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-vl',
      vision: true,
    });
    expect(store.status()).toMatchObject({ kind: 'openai-compatible', hasKey: false });
  });

  it('corrupt file → null (degrades to default, never throws)', () => {
    const io = fakeIo({ read: () => '{ not json' });
    expect(new ProviderStore(io).load()).toBeNull();
    expect(new ProviderStore(io).status().isDefault).toBe(true);
  });

  it('rejects an invalid config on save', () => {
    expect(() =>
      new ProviderStore(fakeIo()).save({ kind: 'openai', model: '' } as never),
    ).toThrow();
  });
});
