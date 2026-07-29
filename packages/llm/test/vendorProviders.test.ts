/**
 * Anthropic and Google are first-class vendors, not OpenAI-dialect base URLs.
 * These tests pin the parts that would silently break if someone tried to fold
 * them back into `openai-compatible`: the auth mechanism (header vs query
 * param), the version header Anthropic requires, and the model-list shapes.
 */
import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/openaiCompatibleProvider';
import { LlmProviderError } from '../src/errors';
import type { ProviderConfig } from '../src/types';

const KEY = 'sk-ant-test-key';

/**
 * A fetch double that records its arguments. The parameters are declared
 * explicitly so `mock.calls[0]` is a 2-tuple — asserting on the URL and headers
 * is the whole point of these tests.
 */
function jsonFetch(body: unknown, status = 200) {
  return vi.fn(
    async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function provider(config: Partial<ProviderConfig>, fetchImpl: typeof fetch) {
  return new OpenAiCompatibleProvider({
    config: {
      kind: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: KEY,
      ...config,
    } as ProviderConfig,
    fetchImpl,
  });
}

// ────────────────────────────────────────────────────────────────── Anthropic
describe('Anthropic listModels', () => {
  it('authenticates with x-api-key and the dated version header, NOT a bearer token', async () => {
    const fetchImpl = jsonFetch({
      data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }],
    });
    await provider({}, fetchImpl as unknown as typeof fetch).listModels();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('https://api.anthropic.com/v1/models');
    const headers = (init as { headers?: Record<string, string> }).headers as Record<
      string,
      string
    >;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // A bearer header would be the tell that someone reused the OpenAI path.
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps display_name to the label and detects Claude vision', async () => {
    const fetchImpl = jsonFetch({
      data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }],
    });
    const models = await provider({}, fetchImpl as unknown as typeof fetch).listModels();
    expect(models).toEqual([{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vision: true }]);
  });

  it('falls back to the id when display_name is absent', async () => {
    const fetchImpl = jsonFetch({ data: [{ id: 'claude-opus-5' }] });
    const models = await provider({}, fetchImpl as unknown as typeof fetch).listModels();
    expect(models[0]).toMatchObject({ id: 'claude-opus-5', label: 'claude-opus-5' });
  });

  it('honours a custom base URL (proxy / gateway)', async () => {
    const fetchImpl = jsonFetch({ data: [] });
    await provider(
      { baseUrl: 'https://anthropic.internal.example' },
      fetchImpl as unknown as typeof fetch,
    ).listModels();
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(
      'https://anthropic.internal.example/v1/models',
    );
  });

  it('surfaces a 401 as a typed auth error', async () => {
    const fetchImpl = jsonFetch({ error: 'nope' }, 401);
    await expect(
      provider({}, fetchImpl as unknown as typeof fetch).listModels(),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('health() reports the failure instead of throwing', async () => {
    const fetchImpl = jsonFetch({}, 401);
    const res = await provider({}, fetchImpl as unknown as typeof fetch).health();
    expect(res).toMatchObject({ ok: false, code: 'PROVIDER_AUTH' });
  });

  it('refuses to build a model without a key rather than sending an unauthenticated request', async () => {
    const p = new OpenAiCompatibleProvider({
      config: { kind: 'anthropic', model: 'claude-sonnet-5', vision: true },
    });
    await p.beginRun({ task: 't', width: 100, height: 100 });
    await expect(
      p.predict({
        screenshotB64: 'QUJD',
        instruction: 'go',
        stepIndex: 0,
        width: 100,
        height: 100,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });
});

// ───────────────────────────────────────────────────────────────────── Google
describe('Google listModels', () => {
  const googleConfig = { kind: 'google' as const, model: 'gemini-2.0-flash', apiKey: 'AIza-test' };

  it('authenticates with a query parameter, not a header', async () => {
    const fetchImpl = jsonFetch({
      models: [
        {
          name: 'models/gemini-2.0-flash',
          displayName: 'Gemini 2.0 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    });
    await provider(googleConfig, fetchImpl as unknown as typeof fetch).listModels();
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('key=AIza-test');
  });

  it('strips the models/ prefix so the id is what the SDK expects', async () => {
    const fetchImpl = jsonFetch({
      models: [
        {
          name: 'models/gemini-2.0-flash',
          displayName: 'Gemini 2.0 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    });
    const models = await provider(googleConfig, fetchImpl as unknown as typeof fetch).listModels();
    expect(models[0]).toMatchObject({ id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' });
  });

  it('drops models that cannot generateContent (embeddings etc.)', async () => {
    const fetchImpl = jsonFetch({
      models: [
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    });
    const models = await provider(googleConfig, fetchImpl as unknown as typeof fetch).listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-2.0-flash']);
  });

  it('keeps a model that reports no methods at all rather than hiding it', async () => {
    const fetchImpl = jsonFetch({ models: [{ name: 'models/gemini-experimental' }] });
    const models = await provider(googleConfig, fetchImpl as unknown as typeof fetch).listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-experimental']);
  });

  it('url-encodes the key so a key with reserved characters still works', async () => {
    const fetchImpl = jsonFetch({ models: [] });
    await provider(
      { ...googleConfig, apiKey: 'a+b/c=d' },
      fetchImpl as unknown as typeof fetch,
    ).listModels();
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('key=a%2Bb%2Fc%3Dd');
  });

  it('refuses to build a model without a key', async () => {
    const p = new OpenAiCompatibleProvider({
      config: { kind: 'google', model: 'gemini-2.0-flash', vision: true },
    });
    await p.beginRun({ task: 't', width: 100, height: 100 });
    await expect(
      p.predict({
        screenshotB64: 'QUJD',
        instruction: 'go',
        stepIndex: 0,
        width: 100,
        height: 100,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });
});

// ───────────────────────────────────────────────────────── shared guarantees
describe('vendor-agnostic behaviour still holds', () => {
  it('a non-JSON body is reported as BAD_OUTPUT, not a crash', async () => {
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response('<html>gateway</html>', { status: 200 }),
    );
    await expect(
      provider({}, fetchImpl as unknown as typeof fetch).listModels(),
    ).rejects.toBeInstanceOf(LlmProviderError);
  });

  it('an OpenAI-compatible provider still needs a base URL', async () => {
    const p = new OpenAiCompatibleProvider({
      config: { kind: 'openai-compatible', model: 'x', vision: true },
    });
    await p.beginRun({ task: 't', width: 10, height: 10 });
    await expect(
      p.predict({ screenshotB64: 'QUJD', instruction: 'go', stepIndex: 0, width: 10, height: 10 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('an empty base URL falls back to the vendor default instead of becoming a broken URL', async () => {
    const fetchImpl = jsonFetch({ data: [] });
    await provider({ baseUrl: '   ' }, fetchImpl as unknown as typeof fetch).listModels();
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('https://api.anthropic.com');
  });
});

// ────────────────────────────────── xAI / Mistral / Groq (OpenAI-shaped lists)
describe('OpenAI-shaped vendors hit their own hosts', () => {
  it.each([
    ['xai', 'https://api.x.ai/v1/models'],
    ['mistral', 'https://api.mistral.ai/v1/models'],
    ['groq', 'https://api.groq.com/openai/v1/models'],
  ])('%s lists models from %s with bearer auth', async (kind, expected) => {
    const fetchImpl = jsonFetch({ data: [{ id: 'some-model' }] });
    await provider(
      { kind: kind as ProviderConfig['kind'], apiKey: 'k-123', baseUrl: undefined },
      fetchImpl as unknown as typeof fetch,
    ).listModels();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(expected);
    const headers = (init as { headers?: Record<string, string> }).headers ?? {};
    // These three DO use bearer auth, unlike Anthropic and Google.
    expect(headers.Authorization).toBe('Bearer k-123');
  });

  it('an explicit base URL still wins over the vendor default', async () => {
    const fetchImpl = jsonFetch({ data: [] });
    await provider(
      { kind: 'groq', apiKey: 'k', baseUrl: 'https://proxy.internal/v1' },
      fetchImpl as unknown as typeof fetch,
    ).listModels();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://proxy.internal/v1/models');
  });

  it('resolves vision through the catalog, so a current model is not blocked', async () => {
    const fetchImpl = jsonFetch({ data: [{ id: 'grok-4' }, { id: 'pixtral-large-latest' }] });
    const models = await provider(
      { kind: 'xai', apiKey: 'k' },
      fetchImpl as unknown as typeof fetch,
    ).listModels();
    expect(models.every((m) => m.vision === true)).toBe(true);
  });
});
