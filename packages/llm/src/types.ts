/**
 * The provider abstraction. One {@link InferenceProvider} contract normalizes
 * Coasty's CUA and any BYO LLM (OpenAI-compatible / OpenRouter / Ollama) so the
 * agent loop is provider-agnostic: each `predict` returns the SAME
 * `PredictStepResult` shape `runAgentLoop` already consumes.
 */
import type { CuaVersion, PredictStepInput, PredictStepResult } from '@open-cowork/core';
import type { ProviderErrorCode } from './errors';

/** Which provider implementation backs a run. */
export type ProviderKind = 'coasty' | 'openai' | 'openai-compatible' | 'openrouter';

/** A model the user can pick, with its detected capabilities. */
export interface ModelInfo {
  id: string;
  label: string;
  /** `true`/`false` when known; `'unknown'` when the provider exposes no metadata. */
  vision: boolean | 'unknown';
  /** Whether the model supports tool/structured output, when known. */
  tools?: boolean;
}

/**
 * Persisted (non-secret) provider selection. The API key is NEVER stored here in
 * plaintext for transit/persistence — it's resolved at call time on the desktop
 * (Electron `safeStorage`) and attached only to the in-memory config the
 * provider instance holds.
 */
export interface ProviderConfig {
  kind: ProviderKind;
  /** OpenAI-compatible base URL (Ollama: http://localhost:11434/v1). */
  baseUrl?: string;
  model: string;
  /** Resolved key value — present only on the live, in-memory instance. */
  apiKey?: string;
  /** Detected vision capability for `model` (from listModels / heuristics). */
  vision?: boolean | 'unknown';
  /** User assertion when `vision` is `'unknown'`. */
  visionOverride?: boolean;
  /** Display label, e.g. "OpenRouter · anthropic/claude-3.5-sonnet". */
  label?: string;
}

/** One-time setup at run start (Coasty creates a session here). */
export interface BeginRunOptions {
  task: string;
  width: number;
  height: number;
  cuaVersion?: CuaVersion;
}

/** Per-step context handed to {@link InferenceProvider.predict}. */
export interface PredictContext {
  signal?: AbortSignal;
  /** Extra instructions appended to the provider's system prompt. */
  systemPrompt?: string;
}

export interface HealthResult {
  ok: boolean;
  detail?: string;
  code?: ProviderErrorCode;
}

/**
 * The contract every provider implements. The run path is
 * `beginRun → predict* → endRun`; `listModels`/`health` back the Settings UI.
 * A provider instance is created per run (it may hold session/trajectory state).
 */
export interface InferenceProvider {
  readonly kind: ProviderKind;
  readonly model: string;

  /** Models the user can pick (+ capabilities where the provider exposes them). */
  listModels(): Promise<ModelInfo[]>;
  /** Cheap reachability + auth probe for the Settings "Test connection" button. */
  health(): Promise<HealthResult>;

  /** Run setup. Throws {@link LlmProviderError} `NO_VISION` if the model can't see. */
  beginRun(opts: BeginRunOptions): Promise<void>;
  /** Predict the next action(s). Returns the loop's existing result shape. */
  predict(input: PredictStepInput, ctx?: PredictContext): Promise<PredictStepResult>;
  /** Teardown (Coasty deletes its session). Idempotent. */
  endRun(): Promise<void>;
}

export type { PredictStepInput, PredictStepResult };
