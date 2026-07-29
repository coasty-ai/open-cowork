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
/**
 * Names that state multimodality outright. These are checked BEFORE the catalog
 * (see {@link resolveModelVision}) because the catalog's majority vote can be
 * dragged to the wrong answer by providers that under-report modalities.
 *
 * The case that forced this: `phi-4-multimodal-instruct` is listed by three
 * providers on models.dev and only one of them declares image input, so the
 * majority says "text-only" about a model whose name is literally
 * "multimodal" — and because a catalog `false` is authoritative, the user could
 * not even override it. A name containing "vision", "multimodal", a `-vl`
 * segment or "vlm" is stronger evidence than that vote.
 *
 * Deliberately narrow: each pattern requires the marker to be its own segment,
 * so a model merely *named* after something is not swept up.
 */
const STRONG_VISION_MARKERS: RegExp[] = [
  /(^|[-_.])vision([-_.]|$)/i, // moonshot-v1-128k-vision-preview
  /multimodal/i, // phi-4-multimodal-instruct
  /(^|[-_.])vlm?\d*([-_.]|$)/i, // mimo-vl-7b, deepseek-vl2, …-vlm
  /(^|[-_.])omni([-_.]|$)/i, // qwen2.5-omni
  /(^|[-_.])qvq([-_.]|$)/i, // Qwen QVQ visual reasoning
];

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
  // Grok is NOT uniformly multimodal, so this is enumerated rather than ranged:
  // every models.dev listing of plain `grok-3` (poe, helicone, github-models)
  // says text-only. A `grok-[2-9]` range claimed otherwise and would have sent a
  // blind screenshot. Vision arrives via the explicit `-vision` builds and the 4
  // line onward.
  /grok-[4-9]/i,
  /grok-(\d+-)?vision/i,

  // ── open-weight / local families ─────────────────────────────────────────
  // These matter most: the catalog covers hosted APIs well, but someone
  // running a finetune through Ollama (`my-qwen2.5-vl-tune:q4_K_M`) has an id
  // no database will ever list, so the family name is all we have.
  /llama-?3\.2-?(11b|90b)?-?vision/i,
  // Llama 4+ is multimodal, but the version digit must not be confused with a
  // PARAMETER COUNT. A bare `llama-?[4-9]` matched the "llama-7" inside
  // `codellama-70b` and reported a code model as vision-capable. Requiring a
  // separator (or end of id) after the version keeps `llama-4-scout` while
  // rejecting `llama-70b` / `llama-8b`.
  /llama-?[4-9](\.\d+)?([-_.]|$)/i,
  /llava/i,
  /qwen.*-?vl/i, // qwen2-vl, qwen2.5-vl, qwen3-vl, qwen-vl-max…
  /pixtral/i,
  /mistral-?small-?3\.\d+/i,
  /mistral-?medium-?3/i,
  /magistral/i,
  /devstral/i,
  /moondream/i,
  /minicpm-?[vo]/i, // MiniCPM-V and the omni-modal MiniCPM-O
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

/**
 * Families that are explicitly text-only, so we can say "no" rather than
 * "unknown". Every entry here must be evidence of a MODALITY, because a "no"
 * from this list is authoritative — {@link effectiveVision} refuses to let a
 * user override `vision === false`, on the grounds that a model which cannot see
 * cannot be talked into it.
 *
 * That makes a sloppy pattern here worse than no pattern at all. `-instruct$`
 * used to be on this list, which is a NAMING CONVENTION and not a modality:
 * `qwen2.5-vl-72b-instruct`, `llama-3.2-90b-vision-instruct` and
 * `phi-4-multimodal-instruct` are all instruct-tuned VLMs. They happened to be
 * rescued by matching a vision pattern first, but any vision model whose family
 * this file does not recognise was being hard-blocked with no way out. Removed.
 */
const TEXT_ONLY_PATTERNS: RegExp[] = [
  /text-embedding/i,
  /embed/i,
  /whisper/i,
  /(^|[-_.])tts([-_.]|$)/i,
  /^gpt-3\.5/i,
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
  if (hasStrongVisionMarker(id)) return true;
  if (VISION_PATTERNS.some((re) => re.test(id))) return true;
  if (TEXT_ONLY_PATTERNS.some((re) => re.test(id))) return false;
  return 'unknown';
}

/**
 * Does the id state multimodality outright? Used to outrank a catalog "no" —
 * see {@link STRONG_VISION_MARKERS} for the case that made this necessary.
 */
export function hasStrongVisionMarker(modelId: string): boolean {
  const id = String(modelId ?? '').trim();
  if (!id) return false;
  return STRONG_VISION_MARKERS.some((re) => re.test(id));
}

/**
 * Decide whether a model accepts image input, from the most authoritative
 * source available:
 *
 *   1. the live provider's own modality metadata — it knows its own models;
 *   2. an UNAMBIGUOUS name marker ("vision", "multimodal", a `-vl` segment) —
 *      see below for why this sits above the catalog rather than below it;
 *   3. the models.dev + LiteLLM catalog (bundled snapshot + optional live
 *      refresh) — recorded capability for ~6k models rather than a name guess;
 *   4. the family name heuristics — for local and finetuned models no catalog
 *      lists (`my-qwen2.5-vl-finetune:q4`);
 *   5. `'unknown'`, which the UI resolves with an explicit user override.
 *
 * Layer 3 exists because name guessing rots: the heuristic list once enumerated
 * Claude versions and stopped at 4, so every Claude 5 model became 'unknown' and
 * was blocked at the run gate.
 *
 * Layer 2 exists because layer 3 is a VOTE, and votes can lose for bad reasons.
 * `phi-4-multimodal-instruct` appears on models.dev under three providers, only
 * one of which declares image input — so the majority reports "text-only" for a
 * model named "multimodal", and a catalog `false` cannot be overridden by the
 * user. Ordering an explicit name claim above the vote fixes that class without
 * weakening the vote everywhere else.
 */
export function resolveModelVision(
  modelId: string,
  providerVision: boolean | 'unknown' | undefined,
): boolean | 'unknown' {
  if (providerVision === true || providerVision === false) return providerVision;
  if (hasStrongVisionMarker(modelId)) return true;
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
