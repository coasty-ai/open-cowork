/**
 * Environment bootstrap: turning `ANTHROPIC_API_KEY=…` in a `.env` into a
 * working provider with no clicking.
 *
 * The behaviour worth pinning hardest is the AMBIGUOUS case. Someone with both
 * an Anthropic and an OpenAI key must be told to choose — silently picking one
 * would make which model drives their screen depend on the order of a table in
 * this repo.
 */
import { describe, expect, it } from 'vitest';
import {
  describeEnvConfig,
  pickVisionModel,
  providersWithKeys,
  resolveProviderFromEnv,
} from '../src/envConfig';

const ANTHROPIC = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa';
const OPENAI = 'sk-proj-bbbbbbbbbbbbbbbbbbbb';

describe('resolveProviderFromEnv — single key', () => {
  it('infers Anthropic from ANTHROPIC_API_KEY alone', () => {
    const { config, ambiguous } = resolveProviderFromEnv({ ANTHROPIC_API_KEY: ANTHROPIC });
    expect(ambiguous).toBeFalsy();
    expect(config).toMatchObject({ kind: 'anthropic', apiKey: ANTHROPIC });
  });

  it('infers OpenAI from OPENAI_API_KEY alone', () => {
    const { config } = resolveProviderFromEnv({ OPENAI_API_KEY: OPENAI });
    expect(config).toMatchObject({ kind: 'openai', apiKey: OPENAI });
  });

  it('leaves the model empty for auto-selection and says so', () => {
    const { config, note } = resolveProviderFromEnv({ ANTHROPIC_API_KEY: ANTHROPIC });
    expect(config?.model).toBe('');
    expect(note).toMatch(/auto-selected/i);
  });

  it('honours COWORK_LLM_MODEL when given, with no note', () => {
    const { config, note } = resolveProviderFromEnv({
      ANTHROPIC_API_KEY: ANTHROPIC,
      COWORK_LLM_MODEL: 'claude-sonnet-5',
    });
    expect(config?.model).toBe('claude-sonnet-5');
    expect(note).toBeUndefined();
  });

  it('ignores a key that is empty or whitespace', () => {
    expect(resolveProviderFromEnv({ ANTHROPIC_API_KEY: '   ' }).config).toBeNull();
    expect(resolveProviderFromEnv({ ANTHROPIC_API_KEY: '' }).config).toBeNull();
  });
});

describe('resolveProviderFromEnv — nothing configured', () => {
  it('returns no config and no complaint for an empty environment', () => {
    // The common case: the user is on Coasty. Not an error, so no note.
    const res = resolveProviderFromEnv({});
    expect(res.config).toBeNull();
    expect(res.note).toBeUndefined();
  });

  it('ignores unrelated variables', () => {
    expect(resolveProviderFromEnv({ PATH: '/usr/bin', HOME: '/root' }).config).toBeNull();
  });
});

describe('resolveProviderFromEnv — ambiguity', () => {
  it('refuses to guess when two provider keys are present', () => {
    const res = resolveProviderFromEnv({
      ANTHROPIC_API_KEY: ANTHROPIC,
      OPENAI_API_KEY: OPENAI,
    });
    expect(res.config).toBeNull();
    expect(res.ambiguous).toBe(true);
    expect(res.note).toMatch(/COWORK_LLM_PROVIDER/);
    // Both must be named so the message is actionable.
    expect(res.note).toMatch(/anthropic/);
    expect(res.note).toMatch(/openai/);
  });

  it('COWORK_LLM_PROVIDER resolves the ambiguity', () => {
    const { config, ambiguous } = resolveProviderFromEnv({
      ANTHROPIC_API_KEY: ANTHROPIC,
      OPENAI_API_KEY: OPENAI,
      COWORK_LLM_PROVIDER: 'openai',
    });
    expect(ambiguous).toBeFalsy();
    expect(config).toMatchObject({ kind: 'openai', apiKey: OPENAI });
  });
});

describe('resolveProviderFromEnv — explicit provider', () => {
  it('rejects an unknown provider name with the valid list', () => {
    const res = resolveProviderFromEnv({ COWORK_LLM_PROVIDER: 'claude' });
    expect(res.config).toBeNull();
    expect(res.note).toMatch(/not a BYO provider/);
    expect(res.note).toMatch(/anthropic/);
  });

  it('rejects "coasty" — it is not a BYO provider', () => {
    const res = resolveProviderFromEnv({ COWORK_LLM_PROVIDER: 'coasty' });
    expect(res.config).toBeNull();
    expect(res.note).toMatch(/not a BYO provider/);
  });

  it('explains which variable is missing when the chosen provider has no key', () => {
    const res = resolveProviderFromEnv({ COWORK_LLM_PROVIDER: 'anthropic' });
    expect(res.config).toBeNull();
    expect(res.note).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('allows a keyless local provider (Ollama)', () => {
    const { config } = resolveProviderFromEnv({
      COWORK_LLM_PROVIDER: 'openai-compatible',
      COWORK_LLM_MODEL: 'qwen2.5-vl',
    });
    expect(config).toMatchObject({ kind: 'openai-compatible', model: 'qwen2.5-vl' });
    expect(config?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('COWORK_LLM_BASE_URL overrides the registry default', () => {
    const { config } = resolveProviderFromEnv({
      COWORK_LLM_PROVIDER: 'openai-compatible',
      COWORK_LLM_BASE_URL: 'http://192.168.1.9:1234/v1',
    });
    expect(config?.baseUrl).toBe('http://192.168.1.9:1234/v1');
  });

  it('falls back to COWORK_LLM_API_KEY for a gateway with no dedicated variable', () => {
    const { config } = resolveProviderFromEnv({
      COWORK_LLM_PROVIDER: 'openai-compatible',
      COWORK_LLM_BASE_URL: 'https://api.groq.com/openai/v1',
      COWORK_LLM_API_KEY: 'gsk_test',
    });
    expect(config?.apiKey).toBe('gsk_test');
  });
});

describe('providersWithKeys', () => {
  it('lists every provider that has a usable key', () => {
    expect(providersWithKeys({ ANTHROPIC_API_KEY: ANTHROPIC, OPENROUTER_API_KEY: 'or-1' })).toEqual(
      ['anthropic', 'openrouter'],
    );
  });

  it('is empty for a bare environment', () => {
    expect(providersWithKeys({})).toEqual([]);
  });
});

describe('pickVisionModel', () => {
  const vision = (id: string) => ({ id, vision: true as const });
  const text = (id: string) => ({ id, vision: false as const });
  const unknown = (id: string) => ({ id, vision: 'unknown' as const });

  it('prefers the registry suggestion when the provider actually lists it', () => {
    const { model } = pickVisionModel([vision('a'), vision('claude-sonnet-5')], 'claude-sonnet-5');
    expect(model).toBe('claude-sonnet-5');
  });

  it('ignores a suggestion the provider does not offer', () => {
    // The registry hint must never become a hard-coded id that does not exist
    // on this account — that is the whole reason it is only a hint.
    const { model } = pickVisionModel([vision('gpt-4o')], 'claude-sonnet-5');
    expect(model).toBe('gpt-4o');
  });

  it('picks a vision model over a text-only one', () => {
    const { model } = pickVisionModel([text('embed-1'), vision('gpt-4o')]);
    expect(model).toBe('gpt-4o');
  });

  it('falls back to an unknown-capability model but warns', () => {
    const { model, note } = pickVisionModel([text('embed-1'), unknown('mystery-7b')]);
    expect(model).toBe('mystery-7b');
    expect(note).toMatch(/Could not confirm/);
  });

  it('returns no model when everything is known text-only', () => {
    const { model, note } = pickVisionModel([text('embed-1'), text('whisper')]);
    expect(model).toBeUndefined();
    expect(note).toMatch(/No vision-capable model/);
  });

  it('handles an empty model list', () => {
    expect(pickVisionModel([])).toMatchObject({ note: expect.stringMatching(/no models/i) });
  });
});

describe('describeEnvConfig', () => {
  it('never leaks the key value', () => {
    const { config } = resolveProviderFromEnv({ ANTHROPIC_API_KEY: ANTHROPIC });
    const text = describeEnvConfig(config!);
    expect(text).not.toContain(ANTHROPIC);
    expect(text).toContain('ANTHROPIC_API_KEY=set');
    expect(text).toContain('Anthropic');
  });

  it('marks an auto-selected model', () => {
    const { config } = resolveProviderFromEnv({ ANTHROPIC_API_KEY: ANTHROPIC });
    expect(describeEnvConfig(config!)).toMatch(/auto-select/);
  });
});
