/**
 * The provider registry is the single source of truth the desktop, the web
 * Settings UI, and the environment bootstrap all read. These tests guard the
 * invariants those three consumers depend on — most importantly that the table
 * stays internally consistent as vendors are added.
 */
import { describe, expect, it } from 'vitest';
import {
  BYO_PROVIDERS,
  BYO_PROVIDER_KINDS,
  isProviderKind,
  PROVIDER_KINDS,
  providerEnvVar,
  providerMeta,
} from '../src/providers';

describe('provider kinds', () => {
  it('PROVIDER_KINDS is exactly Coasty plus every BYO kind', () => {
    expect(PROVIDER_KINDS).toEqual(['coasty', ...BYO_PROVIDER_KINDS]);
  });

  it('contains no duplicates', () => {
    expect(new Set(PROVIDER_KINDS).size).toBe(PROVIDER_KINDS.length);
  });

  it('includes the vendors that are not OpenAI-dialect', () => {
    // Regression guard: these were once reachable only through OpenRouter,
    // because `openai-compatible` cannot speak either protocol.
    expect(BYO_PROVIDER_KINDS).toContain('anthropic');
    expect(BYO_PROVIDER_KINDS).toContain('google');
  });

  it('isProviderKind accepts every known kind and rejects everything else', () => {
    for (const k of PROVIDER_KINDS) expect(isProviderKind(k)).toBe(true);
    for (const bad of ['claude', 'gpt', '', null, undefined, 42, {}]) {
      expect(isProviderKind(bad)).toBe(false);
    }
  });
});

describe('provider metadata', () => {
  it('every BYO kind has an entry, and Coasty deliberately has none', () => {
    for (const kind of BYO_PROVIDER_KINDS) expect(providerMeta(kind)).not.toBeNull();
    expect(providerMeta('coasty')).toBeNull();
  });

  it('BYO_PROVIDERS matches BYO_PROVIDER_KINDS in content and order', () => {
    expect(BYO_PROVIDERS.map((p) => p.kind)).toEqual([...BYO_PROVIDER_KINDS]);
  });

  it('every entry is self-consistent', () => {
    for (const p of BYO_PROVIDERS) {
      expect(p.label.trim()).not.toBe('');
      expect(p.baseUrlHint.trim()).not.toBe('');
      expect(p.docsUrl).toMatch(/^https:\/\//);
      // A provider that requires a key must say which variable supplies it,
      // otherwise the env bootstrap can never satisfy it.
      if (p.needsKey) expect(p.envVar).toBeTruthy();
    }
  });

  it('env var names are unique — two providers must never share one', () => {
    const vars = BYO_PROVIDERS.map((p) => p.envVar).filter(Boolean);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('maps the keys people actually set', () => {
    expect(providerEnvVar('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(providerEnvVar('openai')).toBe('OPENAI_API_KEY');
    expect(providerEnvVar('openrouter')).toBe('OPENROUTER_API_KEY');
    expect(providerEnvVar('google')).toBe('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(providerEnvVar('coasty')).toBeUndefined();
  });

  it('only the local-endpoint provider is keyless, and it ships a default base URL', () => {
    const local = providerMeta('openai-compatible')!;
    expect(local.needsKey).toBe(false);
    expect(local.defaultBaseUrl).toMatch(/^http/);
    // Everything else is a hosted API and must demand a key.
    for (const p of BYO_PROVIDERS.filter((x) => x.kind !== 'openai-compatible')) {
      expect(p.needsKey).toBe(true);
    }
  });

  it('a non-editable base URL is never pre-filled with a value the user cannot change', () => {
    for (const p of BYO_PROVIDERS) {
      if (!p.baseUrlEditable) expect(p.defaultBaseUrl).toBe('');
    }
  });
});
