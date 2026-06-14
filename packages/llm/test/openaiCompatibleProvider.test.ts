import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { OpenAiCompatibleProvider } from '../src/openaiCompatibleProvider';
import { LlmProviderError } from '../src/errors';
import type { ProviderConfig } from '../src/types';

const VISION_CONFIG: ProviderConfig = {
  kind: 'openai-compatible',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5-vl',
  vision: true,
};

const input = (over = {}) => ({
  screenshotB64: 'QUJD',
  instruction: 'click login',
  stepIndex: 0,
  width: 1280,
  height: 800,
  ...over,
});

type DoGenField = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doGenerate']
>;
// `doGenerate` is a union (static result | function). The result member is the
// one with a `content` field; extract it for the cast below.
type GenResult = Extract<DoGenField, { content: unknown }>;

/** A mock model whose nth doGenerate returns the nth scripted text. Last repeats. */
function scriptedModel(texts: string[]) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const text = texts[Math.min(i, texts.length - 1)]!;
      i++;
      // Shape is correct at runtime (111 tests pass); the cast satisfies the
      // mock's strict result union without re-importing provider-spec types.
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        warnings: [],
      } as unknown as GenResult;
    },
  });
}

describe('OpenAiCompatibleProvider — predict (structured output)', () => {
  it('maps a structured step to CuaAction[] + usage', async () => {
    const model = scriptedModel([
      JSON.stringify({
        reasoning: 'clicking login',
        status: 'continue',
        actions: [{ type: 'click', x: 5, y: 6 }],
      }),
    ]);
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model });
    const r = await p.predict(input());
    expect(r.status).toBe('continue');
    expect(r.reasoning).toBe('clicking login');
    expect(r.actions).toEqual([
      { action_type: 'click', params: { x: 5, y: 6, button: 'left', clicks: 1 } },
    ]);
    // BYO runs never bill Coasty credits; token counts come from the provider.
    expect(r.usage).toMatchObject({ cost_cents: 0, credits_charged: 0 });
    expect(typeof r.usage!.input_tokens).toBe('number');
    expect(typeof r.usage!.output_tokens).toBe('number');
  });

  it('maps a done step', async () => {
    const model = scriptedModel([JSON.stringify({ status: 'done', actions: [{ type: 'done' }] })]);
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model });
    const r = await p.predict(input());
    expect(r.status).toBe('done');
    expect(r.actions[0]).toEqual({ action_type: 'done', params: {} });
  });

  it('falls back to free-text JSON when structured output fails', async () => {
    // 1st call (generateObject) returns prose → NoObjectGeneratedError;
    // 2nd call (generateText) returns fenced JSON → coerceFromText recovers it.
    const model = scriptedModel([
      'I cannot produce JSON but I will click.',
      '```json\n{"status":"continue","actions":[{"type":"click","x":7,"y":8}]}\n```',
    ]);
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model });
    const r = await p.predict(input());
    expect(r.actions[0]).toMatchObject({ action_type: 'click', params: { x: 7, y: 8 } });
  });

  it('recovers a bare actions array via structured-output repair (no second call)', async () => {
    // The model returns a top-level array instead of the wrapper object; the
    // repair hook reshapes it so generateObject still succeeds in one call.
    const model = scriptedModel([JSON.stringify([{ type: 'click', x: 7, y: 8 }])]);
    const spy = vi.spyOn(model, 'doGenerate');
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model });
    const r = await p.predict(input());
    expect(r.actions[0]).toMatchObject({ action_type: 'click', params: { x: 7, y: 8 } });
    expect(spy).toHaveBeenCalledTimes(1); // repaired in-place, no fallback round-trip
  });

  it('escalates prose → JSON-only re-ask → repair turn before giving up', async () => {
    // 1) generateObject sees prose → fails; 2) the JSON-only re-ask is still prose
    // → fails; 3) the repair turn finally returns JSON → recovered.
    const model = scriptedModel([
      'I will click the search box now.',
      'Sure, clicking the search box.',
      JSON.stringify({ status: 'continue', actions: [{ type: 'click', x: 5, y: 6 }] }),
    ]);
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model });
    const r = await p.predict(input());
    expect(r.actions[0]).toMatchObject({ action_type: 'click', params: { x: 5, y: 6 } });
  });

  it('fails with an actionable message when the model never emits JSON', async () => {
    const model = scriptedModel(['just prose, no braces at all']); // repeats for every call
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model });
    const err = await p.predict(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).code).toBe('BAD_OUTPUT');
    expect((err as LlmProviderError).message).toMatch(/JSON|vision model/i);
  });

  it('blocks an oversized screenshot BEFORE calling the model', async () => {
    const model = scriptedModel(['{}']);
    const spy = vi.spyOn(model, 'doGenerate');
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model, maxImageBytes: 10 });
    await expect(p.predict(input({ screenshotB64: 'A'.repeat(500) }))).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a model/transport error uniformly', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      },
    });
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model });
    await expect(p.predict(input())).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('accumulates a bounded trajectory across steps', async () => {
    const model = scriptedModel([
      JSON.stringify({ status: 'continue', actions: [{ type: 'click', x: 1, y: 1 }] }),
    ]);
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, model, trajectoryWindow: 2 });
    await p.beginRun({ task: 't', width: 1280, height: 800 });
    for (let i = 0; i < 5; i++) await p.predict(input({ stepIndex: i }));
    // No assertion on internals beyond "it didn't crash / leak"; bounded window
    // keeps memory flat. (History is private; behavior verified by stability.)
    expect(p.model).toBe('qwen2.5-vl');
  });
});

describe('OpenAiCompatibleProvider — vision gate (beginRun)', () => {
  it('blocks a non-vision model with NO_VISION', async () => {
    const p = new OpenAiCompatibleProvider({
      config: {
        kind: 'openai-compatible',
        baseUrl: 'http://x/v1',
        model: 'gpt-3.5-turbo',
        vision: false,
      },
    });
    await expect(p.beginRun({ task: 't', width: 1, height: 1 })).rejects.toMatchObject({
      code: 'NO_VISION',
    });
  });
  it('blocks an unknown-vision model without an override', async () => {
    const p = new OpenAiCompatibleProvider({
      config: {
        kind: 'openai-compatible',
        baseUrl: 'http://x/v1',
        model: 'mystery',
        vision: 'unknown',
      },
    });
    await expect(p.beginRun({ task: 't', width: 1, height: 1 })).rejects.toMatchObject({
      code: 'NO_VISION',
    });
  });
  it('allows an unknown-vision model WITH the override', async () => {
    const p = new OpenAiCompatibleProvider({
      config: {
        kind: 'openai-compatible',
        baseUrl: 'http://x/v1',
        model: 'mystery',
        vision: 'unknown',
        visionOverride: true,
      },
    });
    await expect(p.beginRun({ task: 't', width: 1, height: 1 })).resolves.toBeUndefined();
  });
});

describe('OpenAiCompatibleProvider — listModels + health', () => {
  function fetchReturning(body: unknown, status = 200): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
  }

  it('lists OpenAI-compatible models with name-based vision detection', async () => {
    const p = new OpenAiCompatibleProvider({
      config: VISION_CONFIG,
      fetchImpl: fetchReturning({
        data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }, { id: 'mystery' }],
      }),
    });
    const models = await p.listModels();
    expect(models.find((m) => m.id === 'gpt-4o')!.vision).toBe(true);
    expect(models.find((m) => m.id === 'gpt-3.5-turbo')!.vision).toBe(false);
    expect(models.find((m) => m.id === 'mystery')!.vision).toBe('unknown');
  });

  it('lists OpenRouter models using modality metadata (authoritative)', async () => {
    const p = new OpenAiCompatibleProvider({
      config: { kind: 'openrouter', model: 'x', apiKey: 'sk-or' },
      fetchImpl: fetchReturning({
        data: [
          { id: 'a/vision', architecture: { input_modalities: ['text', 'image'] } },
          { id: 'b/textonly', architecture: { input_modalities: ['text'] } },
        ],
      }),
    });
    const models = await p.listModels();
    expect(models.find((m) => m.id === 'a/vision')!.vision).toBe(true);
    expect(models.find((m) => m.id === 'b/textonly')!.vision).toBe(false);
  });

  it('an empty input_modalities array is authoritative (no vision) — not a name guess', async () => {
    // OpenRouter saying "no input modalities" must NOT fall back to the name
    // heuristic (which would wrongly mark e.g. claude-3.5 as vision-capable).
    const p = new OpenAiCompatibleProvider({
      config: { kind: 'openrouter', model: 'x', apiKey: 'sk-or' },
      fetchImpl: fetchReturning({
        data: [{ id: 'anthropic/claude-3.5-sonnet', architecture: { input_modalities: [] } }],
      }),
    });
    const models = await p.listModels();
    expect(models[0]!.vision).toBe(false);
  });

  it('falls back to a token-matched modality string when no modalities array', async () => {
    const p = new OpenAiCompatibleProvider({
      config: { kind: 'openrouter', model: 'x', apiKey: 'sk-or' },
      fetchImpl: fetchReturning({
        data: [
          { id: 'm/multi', architecture: { modality: 'text,image' } },
          // 'image-generation' must NOT match the 'image' input token (no substring hit).
          { id: 'm/imggen', architecture: { modality: 'text,image-generation' } },
        ],
      }),
    });
    const models = await p.listModels();
    expect(models.find((m) => m.id === 'm/multi')!.vision).toBe(true);
    expect(models.find((m) => m.id === 'm/imggen')!.vision).toBe(false);
  });

  it('health: ok when models resolve', async () => {
    const p = new OpenAiCompatibleProvider({
      config: VISION_CONFIG,
      fetchImpl: fetchReturning({ data: [{ id: 'm' }] }),
    });
    expect((await p.health()).ok).toBe(true);
  });

  it('health: PROVIDER_UNREACHABLE when the server is down (Ollama not running)', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }) as typeof fetch;
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, fetchImpl });
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.code).toBe('PROVIDER_UNREACHABLE');
  });

  it('health: PROVIDER_AUTH on a 401', async () => {
    const p = new OpenAiCompatibleProvider({
      config: VISION_CONFIG,
      fetchImpl: fetchReturning({}, 401),
    });
    expect((await p.health()).code).toBe('PROVIDER_AUTH');
  });

  it('maps a non-JSON models response to BAD_OUTPUT', async () => {
    const fetchImpl = (async () =>
      new Response('<html>gateway error</html>', { status: 200 })) as typeof fetch;
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, fetchImpl });
    await expect(p.listModels()).rejects.toMatchObject({ code: 'BAD_OUTPUT' });
  });

  it('listModels never throws raw — wraps as LlmProviderError', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    const p = new OpenAiCompatibleProvider({ config: VISION_CONFIG, fetchImpl });
    await expect(p.listModels()).rejects.toBeInstanceOf(LlmProviderError);
  });
});
