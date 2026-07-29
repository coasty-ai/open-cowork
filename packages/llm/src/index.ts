/**
 * @open-cowork/llm — bring-your-own-LLM provider abstraction. One
 * `InferenceProvider` contract over Coasty's CUA and every major vendor —
 * Anthropic, OpenAI, Google Gemini, OpenRouter, and any OpenAI-compatible
 * endpoint (Ollama / LM Studio / vLLM) via the Vercel AI SDK — each mapping a
 * screenshot+instruction to the agent loop's `CuaAction[]`.
 *
 * Desktop-only by design: importing this package pulls in the AI SDK, which must
 * never reach the web/mobile bundles.
 */
export type {
  InferenceProvider,
  ModelInfo,
  ProviderConfig,
  ProviderKind,
  PredictContext,
  BeginRunOptions,
  HealthResult,
} from './types';
export { PROVIDER_KINDS, BYO_PROVIDER_KINDS, isProviderKind } from './types';
export { BYO_PROVIDERS, providerMeta, providerEnvVar } from './registry';
export type { ProviderMeta } from './registry';
export {
  resolveProviderFromEnv,
  providersWithKeys,
  pickVisionModel,
  describeEnvConfig,
} from './envConfig';
export type { EnvBag, EnvProviderResolution } from './envConfig';
export { LlmProviderError, mapProviderError, redactKey } from './errors';
export type { ProviderErrorCode } from './errors';
export { detectVisionFromName, resolveModelVision, effectiveVision } from './capabilities';
export {
  catalogVision,
  refreshCatalog,
  catalogStats,
  normalizeModelId,
  resetCatalogRefresh,
} from './modelCatalog';
export type { CatalogRefreshResult } from './modelCatalog';
export { base64Bytes, guardImageSize, DEFAULT_MAX_IMAGE_BYTES } from './image';
export {
  MODEL_STEP_SCHEMA,
  toCuaAction,
  mapModelStep,
  coerceModelStep,
  coerceFromText,
  extractJson,
  normalizeStepShape,
} from './actionParser';
export type { ModelAction, ModelStep, ParsedStep } from './actionParser';
export { CoastyProvider } from './coastyProvider';
export type { CoastyProviderDeps } from './coastyProvider';
export { OpenAiCompatibleProvider } from './openaiCompatibleProvider';
export type { OpenAiCompatibleDeps } from './openaiCompatibleProvider';
export { makeProvider } from './factory';
export type { MakeProviderDeps } from './factory';
