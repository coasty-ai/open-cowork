/**
 * @open-cowork/llm — bring-your-own-LLM provider abstraction. One
 * `InferenceProvider` contract over Coasty's CUA and any OpenAI-dialect model
 * (OpenAI / OpenRouter / Ollama / LM Studio / vLLM via the Vercel AI SDK), each
 * mapping a screenshot+instruction to the agent loop's `CuaAction[]`.
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
export { LlmProviderError, mapProviderError, redactKey } from './errors';
export type { ProviderErrorCode } from './errors';
export { detectVisionFromName, resolveModelVision, effectiveVision } from './capabilities';
export { base64Bytes, guardImageSize, DEFAULT_MAX_IMAGE_BYTES } from './image';
export {
  MODEL_STEP_SCHEMA,
  toCuaAction,
  mapModelStep,
  coerceModelStep,
  coerceFromText,
  extractJson,
} from './actionParser';
export type { ModelAction, ModelStep, ParsedStep } from './actionParser';
export { CoastyProvider } from './coastyProvider';
export type { CoastyProviderDeps } from './coastyProvider';
export { OpenAiCompatibleProvider } from './openaiCompatibleProvider';
export type { OpenAiCompatibleDeps } from './openaiCompatibleProvider';
export { makeProvider } from './factory';
export type { MakeProviderDeps } from './factory';
