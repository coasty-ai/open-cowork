/**
 * Vision-capability detection. The computer-use loop is screenshot-driven, so a
 * model MUST be able to see images. We prefer provider metadata (OpenRouter
 * modalities, Ollama capabilities); where none exists we fall back to a small
 * name-pattern map, and ultimately to `'unknown'` (which the UI resolves with a
 * user override).
 */
import type { ModelInfo } from './types';

/** Model families known to accept image input. */
const VISION_PATTERNS: RegExp[] = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4(\.\d+)?-?(turbo)?-?vision/i,
  /gpt-5/i,
  /o[134](-|$|\b)/i, // o1/o3/o4 reasoning models w/ vision
  /claude-3/i,
  /claude-3\.5/i,
  /claude-3\.7/i,
  /claude-(opus|sonnet|haiku)-4/i,
  /claude-4/i,
  /gemini/i,
  /llama-?3\.2-?(11b|90b)?-?vision/i,
  /llama-?4/i,
  /llava/i,
  /qwen.*-vl/i,
  /qwen2\.5-?vl/i,
  /pixtral/i,
  /mistral-?small-?3\.\d+/i,
  /moondream/i,
  /minicpm-?v/i,
  /internvl/i,
  /phi-?3\.5-?vision/i,
  /grok-(2-)?vision/i,
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
 * Merge provider-reported modality (authoritative when present) with the
 * name heuristic. Provider `true`/`false` always wins; only when the provider is
 * silent do we consult the name.
 */
export function resolveModelVision(
  modelId: string,
  providerVision: boolean | 'unknown' | undefined,
): boolean | 'unknown' {
  if (providerVision === true || providerVision === false) return providerVision;
  return detectVisionFromName(modelId);
}

/**
 * The effective vision decision for a run: an explicit user override wins,
 * otherwise the detected capability; `'unknown'` without an override resolves to
 * `false` so we block rather than send a blind request.
 */
export function effectiveVision(
  model: { vision?: ModelInfo['vision'] },
  override?: boolean,
): boolean {
  if (override === true) return true;
  if (override === false) return false;
  return model.vision === true;
}
