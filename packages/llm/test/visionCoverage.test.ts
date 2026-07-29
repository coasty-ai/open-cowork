/**
 * Vision-capability COVERAGE, as a gate rather than a spot check.
 *
 * The failure this file exists to prevent is silent rot. Capability detection is
 * the run gate for a screenshot-driven agent, and it decays in two directions
 * that both look fine locally:
 *
 *   - a new model family ships and resolves to 'unknown', so a perfectly good
 *     model is blocked behind an override checkbox;
 *   - a pattern is written slightly too wide and reports a text-only model as
 *     vision-capable, so a run burns credits on a blind request.
 *
 * So both directions are asserted, over a census of real model ids spanning
 * every vendor and open-weight family we claim to support. Each id below is a
 * real published model, not a shape invented for the test.
 */
import { describe, expect, it } from 'vitest';
import { catalogVision } from '../src/modelCatalog';
import {
  detectVisionFromName,
  hasStrongVisionMarker,
  resolveModelVision,
} from '../src/capabilities';

/**
 * Models that accept image input, grouped by the naming convention they
 * exercise. Every one must resolve to `true` — through the catalog, an
 * unambiguous marker, or a family heuristic; which layer answers is an
 * implementation detail, the verdict is not.
 */
const MULTIMODAL: Record<string, readonly string[]> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022'],
  // Bedrock/Vertex regional ids — the strings you actually pass on those
  // platforms, which models.dev lists only under bare vendor names.
  'bedrock/vertex': [
    'anthropic.claude-3-5-sonnet-20241022-v2',
    'us.anthropic.claude-sonnet-4-20250514-v1',
    'apac.amazon.nova-pro-v1',
  ],
  openai: ['gpt-5', 'gpt-5.6', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o4-mini', 'o1'],
  google: ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro'],
  xai: ['grok-4', 'grok-2-vision-1212'],
  mistral: [
    'pixtral-large-latest',
    'pixtral-12b-2409',
    'mistral-medium-3',
    'mistral-small-3.2-24b-instruct',
  ],
  meta: [
    'llama-4-scout-17b-16e-instruct',
    'llama-4-maverick-17b-128e-instruct',
    'llama-3.2-90b-vision-instruct',
    // multi-segment provider path (Fireworks)
    'accounts/fireworks/models/llama-v3p2-11b-vision-instruct',
  ],
  amazon: ['nova-pro-v1:0', 'nova-lite-v1:0'],
  cohere: ['command-a-vision-07-2025'],
  deepseek: ['deepseek-vl2', 'deepseek-ocr'],
  qwen: [
    'qwen3-vl-235b-a22b-instruct',
    'qwen2.5-vl-72b-instruct',
    'qvq-72b-preview',
    'qwen2.5-omni-7b',
  ],
  zhipu: ['glm-4.6v', 'glm-4v-plus', 'glm-4.1v-thinking'],
  moonshot: ['kimi-vl-a3b-thinking', 'moonshot-v1-128k-vision-preview'],
  internlm: ['internvl3-78b', 'internvl2.5-78b'],
  allenai: ['molmo-72b-0924'],
  microsoft: ['phi-4-multimodal-instruct', 'phi-3.5-vision-instruct'],
  'google-open': ['gemma-3-27b-it', 'paligemma-3b-mix-448'],
  huggingface: ['smolvlm-instruct', 'idefics3-8b-llama3'],
  thudm: ['cogvlm2-llama3-chat-19b', 'cogagent-9b'],
  openbmb: ['minicpm-v-2_6', 'minicpm-o-2_6'],
  llava: ['llava-1.5-7b-hf', 'llava-v1.6-34b', 'llava-onevision-qwen2-7b', 'bakllava'],
  // Purpose-built GUI-agent VLMs — precisely this product's use case.
  'gui-agents': ['ui-tars-72b-dpo', 'ui-tars-1.5-7b', 'showui-2b', 'os-atlas-7b', 'aguvis-72b'],
  'small-local': ['moondream2', 'florence-2-large'],
  'other-open': ['aria', 'nvlm-d-72b', 'mimo-vl-7b-rl', 'ovis2-34b', 'step-1o-vision'],
  // Ids no database will ever list: someone's Ollama finetune.
  'local-finetune': [
    'my-qwen2.5-vl-tune:q4_K_M',
    'custom-vlm-instruct',
    'someones-vision-model:latest',
  ],
};

/**
 * Models that must NOT be reported as vision-capable. Each one is a real
 * regression:
 *
 *   grok-3         every models.dev listing (poe, helicone, github-models) says
 *                  text-only; a `grok-[2-9]` range claimed otherwise.
 *   codellama-70b  a `llama-?[4-9]` pattern matched the "llama-7" inside the
 *                  PARAMETER COUNT and reported a code model as multimodal.
 *   gpt-oss-120b   one provider out of 43 claims image input; the majority vote
 *                  is what keeps this false.
 */
const NOT_MULTIMODAL: readonly string[] = [
  'gpt-3.5-turbo',
  'gpt-oss-120b',
  'deepseek-r1',
  'text-embedding-3-large',
  'llama-3.1-8b-instruct',
  'grok-3',
  'codellama-70b',
  'codellama-34b-instruct',
  'whisper-large-v3',
  'deepseek-coder-v2',
];

const ALL_MULTIMODAL = Object.entries(MULTIMODAL).flatMap(([family, ids]) =>
  ids.map((id) => [family, id] as const),
);

describe('vision coverage: models that CAN see', () => {
  it.each(ALL_MULTIMODAL)('%s: %s resolves to vision-capable', (_family, id) => {
    expect(resolveModelVision(id, undefined)).toBe(true);
  });

  it('covers every family with no gaps', () => {
    const gaps = ALL_MULTIMODAL.filter(([, id]) => resolveModelVision(id, undefined) !== true);
    expect(gaps).toEqual([]);
  });
});

describe('vision coverage: models that CANNOT see', () => {
  it.each(NOT_MULTIMODAL)('%s is never reported as vision-capable', (id) => {
    expect(resolveModelVision(id, undefined)).not.toBe(true);
  });
});

describe('resolution order', () => {
  it('lets the provider override everything, both ways', () => {
    // The provider knows its own models better than any database or name.
    expect(resolveModelVision('claude-sonnet-5', false)).toBe(false);
    expect(resolveModelVision('gpt-3.5-turbo', true)).toBe(true);
  });

  it('lets an unambiguous name beat a catalog "text-only" majority', () => {
    // phi-4-multimodal-instruct: 3 models.dev listings, 1 declares image input,
    // so the majority says text-only about a model named "multimodal". Before
    // the marker tier this was a hard block the user could not override.
    expect(catalogVision('phi-4-multimodal-instruct')).toBe(false);
    expect(hasStrongVisionMarker('phi-4-multimodal-instruct')).toBe(true);
    expect(resolveModelVision('phi-4-multimodal-instruct', undefined)).toBe(true);
  });

  it('does not invent a marker where there is none', () => {
    for (const id of ['gpt-4o', 'claude-sonnet-5', 'gemma-3-27b-it', 'llava-1.5-7b-hf']) {
      expect(hasStrongVisionMarker(id)).toBe(false);
    }
  });

  it('treats a bare "-instruct" suffix as no evidence either way', () => {
    // `-instruct` is a tuning convention, not a modality. It used to be on the
    // text-only list, which hard-blocked any instruct-tuned VLM whose family
    // this file did not already recognise — and `effectiveVision` refuses to let
    // a user override a `false`.
    expect(detectVisionFromName('some-unknown-model-instruct')).toBe('unknown');
  });
});
