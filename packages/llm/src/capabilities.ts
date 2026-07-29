/**
 * Vision-capability detection. The computer-use loop is screenshot-driven, so a
 * model MUST be able to see images. We prefer provider metadata (OpenRouter
 * modalities, Ollama capabilities); where none exists we fall back to a small
 * name-pattern map, and ultimately to `'unknown'` (which the UI resolves with a
 * user override).
 */
import { catalogVision } from './modelCatalog';
import type { ModelInfo } from './types';

/**
 * Model families known to accept image input.
 *
 * These are deliberately VERSION-RANGED rather than enumerated. An earlier
 * version of this list spelled out `claude-3`, `claude-3.5`, `claude-3.7`,
 * `claude-4` — so the day Anthropic shipped a 5, every current Claude silently
 * fell through to `'unknown'` and got blocked at the run gate until the user
 * ticked an override. Matching a range means a new minor/major in an
 * all-vision family keeps working with no code change.
 */
const VISION_PATTERNS: RegExp[] = [
  /gpt-4o/i,
  /gpt-4\.\d/i,
  /gpt-4(\.\d+)?-?(turbo)?-?vision/i,
  /gpt-[5-9]/i, // every GPT line from 5 up is multimodal
  /o[134](-|$|\b)/i, // o1/o3/o4 reasoning models w/ vision
  // Claude 3 and up are all vision-capable, in both `claude-3-5-sonnet` and
  // `claude-sonnet-5` naming orders.
  /claude-[3-9]/i,
  /claude-(opus|sonnet|haiku|fable)-[3-9]/i,
  /gemini/i,
  /grok-[2-9]/i, // Grok 2 vision onward; the whole 4 line is multimodal
  /grok-(\d+-)?vision/i,

  // ── open-weight / local families ─────────────────────────────────────────
  // These matter most: the catalog covers hosted APIs well, but someone
  // running a finetune through Ollama (`my-qwen2.5-vl-tune:q4_K_M`) has an id
  // no database will ever list, so the family name is all we have.
  /llama-?3\.2-?(11b|90b)?-?vision/i,
  /llama-?[4-9]/i,
  /llava/i,
  /qwen.*-?vl/i, // qwen2-vl, qwen2.5-vl, qwen3-vl, qwen-vl-max…
  /pixtral/i,
  /mistral-?small-?3\.\d+/i,
  /mistral-?medium-?3/i,
  /magistral/i,
  /devstral/i,
  /moondream/i,
  /minicpm-?v/i,
  /internvl/i,
  /intern-?s1/i,
  /phi-?[34](\.\d+)?-?(vision|multimodal)/i,
  /phi-?4-?multimodal/i,
  /gemma-?3/i, // Gemma 3 (4B+) is multimodal
  /molmo/i,
  /aria/i,
  /cogvlm/i,
  /cogagent/i,
  /yi-?vl/i,
  /deepseek-?vl/i,
  /glm-?4(\.\d+)?v/i,
  /glm-?4v/i,
  /ovis/i,
  /idefics/i,
  /smolvlm/i,
  /nvlm/i,
  /florence-?2/i,
  /kimi-?vl/i,
  /step-?1o?-?v/i,
  /ernie.*-?vl/i,
  /marco-?vl/i,
  /paligemma/i,
  /fuyu/i,
  /bakllava/i,
  /obsidian/i,
  /granite.*vision/i,
  /pali-?gemma/i,
  /dots\.ocr/i,
  /got-?ocr/i,
  /ui-?tars/i, // purpose-built GUI-agent VLMs — exactly this use case
  /showui/i,
  /cogagent/i,
  /os-?atlas/i,
  /aguvis/i,
  /holo-?\d/i,
];

/** Families that are explicitly text-only (so we can say "no" rather than "unknown"). */
const TEXT_ONLY_PATTERNS: RegExp[] = [
  /text-embedding/i,
  /embed/i,
  /whisper/i,
  /tts/i,
  /^gpt-3\.5/i,
  /-instruct$/i,
  /codellama/i,
  /deepseek-coder/i,
];

/**
 * Best-effort vision detection from a model id when the provider gives no
 * modality metadata: a known vision family → `true`, a known text-only family →
 * `false`, otherwise `'unknown'`.
 */
export function detectVisionFromName(modelId: string): boolean | 'unknown' {
  const id = modelId.trim();
  if (VISION_PATTERNS.some((re) => re.test(id))) return true;
  if (TEXT_ONLY_PATTERNS.some((re) => re.test(id))) return false;
  return 'unknown';
}

/**
 * Decide whether a model accepts image input, from the most authoritative
 * source available:
 *
 *   1. the live provider's own modality metadata — it knows its own models;
 *   2. the models.dev catalog (bundled snapshot + optional live refresh) —
 *      recorded capability for ~6k models rather than a guess from a name;
 *   3. the name heuristic below — for local and finetuned models no catalog
 *      lists (`my-qwen2.5-vl-finetune:q4`);
 *   4. `'unknown'`, which the UI resolves with an explicit user override.
 *
 * Layer 2 exists because layer 3 is guesswork that rots: the heuristic list
 * once enumerated Claude versions and stopped at 4, so every Claude 5 model
 * became 'unknown' and was blocked at the run gate.
 */
export function resolveModelVision(
  modelId: string,
  providerVision: boolean | 'unknown' | undefined,
): boolean | 'unknown' {
  if (providerVision === true || providerVision === false) return providerVision;
  const fromCatalog = catalogVision(modelId);
  if (fromCatalog !== 'unknown') return fromCatalog;
  return detectVisionFromName(modelId);
}

/**
 * The effective vision decision for a run. A model the provider KNOWS is
 * text-only (`vision === false`) can never see, so it stays blocked even if an
 * override is set — an override only rescues the genuinely `'unknown'` case.
 * Otherwise an explicit override wins, then the detected capability; `'unknown'`
 * without an override resolves to `false` so we block rather than send a blind
 * request.
 */
export function effectiveVision(
  model: { vision?: ModelInfo['vision'] },
  override?: boolean,
): boolean {
  if (model.vision === false) return false; // authoritative: cannot be overridden
  if (override === true) return true;
  if (override === false) return false;
  return model.vision === true;
}
