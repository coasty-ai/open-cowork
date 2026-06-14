import { describe, expect, it } from 'vitest';
import { makeProvider } from '../src/factory';
import { CoastyProvider } from '../src/coastyProvider';
import { OpenAiCompatibleProvider } from '../src/openaiCompatibleProvider';
import { LlmProviderError } from '../src/errors';

describe('makeProvider', () => {
  it('builds a CoastyProvider for kind=coasty with backend deps', () => {
    const p = makeProvider(
      { kind: 'coasty', model: 'v3' },
      { backendUrl: 'http://b', getToken: () => 't' },
    );
    expect(p).toBeInstanceOf(CoastyProvider);
    expect(p.kind).toBe('coasty');
  });

  it('throws a uniform LlmProviderError if Coasty deps are missing', () => {
    const err = (() => {
      try {
        makeProvider({ kind: 'coasty', model: 'v3' }, {});
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).code).toBe('PROVIDER_ERROR');
  });

  it.each(['openai', 'openai-compatible', 'openrouter'] as const)(
    'builds an OpenAiCompatibleProvider for kind=%s',
    (kind) => {
      const p = makeProvider({ kind, model: 'm', baseUrl: 'http://x/v1' });
      expect(p).toBeInstanceOf(OpenAiCompatibleProvider);
      expect(p.kind).toBe(kind);
    },
  );

  it('passes an injected model through to the BYO provider', () => {
    const p = makeProvider({ kind: 'openai-compatible', model: 'm', baseUrl: 'http://x/v1' });
    expect(p.model).toBe('m');
  });
});
