/**
 * The model catalog is the layer that answers "can this model see?" from
 * recorded capability data instead of a regex guess. These tests pin the two
 * things that make it trustworthy: it knows CURRENT models, and it does not
 * get fooled by a single mis-reporting gateway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  catalogStats,
  catalogVision,
  normalizeModelId,
  refreshCatalog,
  resetCatalogRefresh,
} from '../src/modelCatalog';
import { detectVisionFromName, resolveModelVision } from '../src/capabilities';

afterEach(() => resetCatalogRefresh());

describe('normalizeModelId', () => {
  it('strips a vendor prefix (OpenRouter style)', () => {
    expect(normalizeModelId('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(normalizeModelId('openai/gpt-4o')).toBe('gpt-4o');
  });

  it('strips an Ollama tag', () => {
    expect(normalizeModelId('qwen2.5-vl:7b')).toBe('qwen2.5-vl');
    expect(normalizeModelId('gemma3:12b-it-q4_K_M')).toBe('gemma3');
  });

  it('lower-cases and trims', () => {
    expect(normalizeModelId('  GPT-4o  ')).toBe('gpt-4o');
  });

  it('handles both a prefix and a tag together', () => {
    expect(normalizeModelId('library/llava:13b')).toBe('llava');
  });

  it('survives empty and junk input', () => {
    expect(normalizeModelId('')).toBe('');
    expect(normalizeModelId('   ')).toBe('');
  });
});

describe('bundled snapshot', () => {
  it('is substantial — a truncated generation would be caught here', () => {
    const s = catalogStats();
    expect(s.models).toBeGreaterThan(2000);
    expect(s.vision).toBeGreaterThan(500);
    expect(s.textOnly).toBeGreaterThan(500);
  });

  it.each([
    'claude-sonnet-5',
    'claude-opus-5',
    'gpt-5',
    'o3',
    'gemini-3-pro',
    'grok-4',
    'pixtral-large-latest',
  ])('knows %s accepts images', (id) => {
    expect(catalogVision(id)).toBe(true);
  });

  it.each(['gpt-3.5-turbo', 'text-embedding-3-large', 'gpt-oss-120b', 'o3-mini'])(
    'knows %s does NOT accept images',
    (id) => {
      expect(catalogVision(id)).toBe(false);
    },
  );

  it('returns unknown for a model nobody lists', () => {
    expect(catalogVision('my-private-finetune-v3')).toBe('unknown');
  });

  it('resists a single mis-reporting gateway', () => {
    // One aggregator lists gpt-3.5-turbo as image-capable; eight say otherwise.
    // Majority vote is what keeps a blind screenshot from being sent to it.
    expect(catalogVision('gpt-3.5-turbo')).toBe(false);
    expect(catalogVision('gpt-oss-120b')).toBe(false);
  });
});

describe('resolveModelVision layering', () => {
  it('the live provider outranks the catalog', () => {
    // A provider that says "no" about its own model is authoritative even when
    // the catalog disagrees — it knows what it actually serves.
    expect(resolveModelVision('gpt-4o', false)).toBe(false);
    expect(resolveModelVision('gpt-3.5-turbo', true)).toBe(true);
  });

  it('the catalog CORRECTS a wrong name heuristic', () => {
    // The `o1/o3/o4 reasoning models have vision` pattern also matches
    // `o3-mini`, which does not. Recorded capability beats pattern-matching a
    // name, and this is exactly the class of error the catalog layer exists to
    // absorb — without it, a run would start blind against a text-only model.
    expect(detectVisionFromName('o3-mini')).toBe(true); // heuristic: wrong
    expect(catalogVision('o3-mini')).toBe(false); // catalog: right
    expect(resolveModelVision('o3-mini', undefined)).toBe(false); // catalog wins
  });

  it('falls through to the heuristic for local models no catalog lists', () => {
    const id = 'my-qwen2.5-vl-finetune';
    expect(catalogVision(id)).toBe('unknown');
    expect(resolveModelVision(id, undefined)).toBe(true); // family name saves it
  });

  it('ends at unknown when nothing knows the model', () => {
    expect(resolveModelVision('zzz-unlisted-model', undefined)).toBe('unknown');
  });
});

describe('refreshCatalog', () => {
  const catalogBody = {
    someprovider: {
      models: {
        a: { id: 'brand-new-vision-model', modalities: { input: ['text', 'image'] } },
        b: { id: 'brand-new-text-model', modalities: { input: ['text'] } },
      },
    },
  };

  it('learns models released since the snapshot', async () => {
    expect(catalogVision('brand-new-vision-model')).toBe('unknown');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(catalogBody), { status: 200 }));

    const res = await refreshCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(res.ok).toBe(true);
    expect(res.added).toBe(2);
    expect(catalogVision('brand-new-vision-model')).toBe(true);
    expect(catalogVision('brand-new-text-model')).toBe(false);
  });

  it('applies majority voting to refreshed data too', async () => {
    const body = {
      good: { models: { a: { id: 'disputed', modalities: { input: ['text'] } } } },
      alsoGood: { models: { a: { id: 'disputed', modalities: { input: ['text'] } } } },
      bad: { models: { a: { id: 'disputed', modalities: { input: ['text', 'image'] } } } },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    await refreshCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(catalogVision('disputed')).toBe(false); // 2 text vs 1 image
  });

  it('leaves a tie unknown so the heuristic decides', async () => {
    const body = {
      p1: { models: { a: { id: 'tied-model', modalities: { input: ['text'] } } } },
      p2: { models: { a: { id: 'tied-model', modalities: { input: ['text', 'image'] } } } },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    await refreshCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(catalogVision('tied-model')).toBe('unknown');
  });

  it('never throws when the network is down — the snapshot stays in force', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await refreshCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/ECONNREFUSED/);
    expect(catalogVision('claude-sonnet-5')).toBe(true); // bundled data untouched
  });

  it('reports a non-200 without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const res = await refreshCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toMatchObject({ ok: false, detail: 'HTTP 503' });
  });

  it('reports malformed JSON without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 200 }));
    const res = await refreshCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.ok).toBe(false);
  });

  it('a refresh cannot downgrade a model the snapshot knows is vision', async () => {
    const body = {
      rogue: { models: { a: { id: 'claude-sonnet-5', modalities: { input: ['text'] } } } },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    await refreshCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    // The bundled snapshot is the floor: one bad upstream entry must not block
    // a model we already shipped as working.
    expect(catalogVision('claude-sonnet-5')).toBe(true);
  });

  it('honours a timeout instead of hanging the Settings dialog', async () => {
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const res = await refreshCatalog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/timed out/);
  });
});
