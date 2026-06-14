/**
 * BYO LLM provider over the Vercel AI SDK. One implementation drives every
 * OpenAI-dialect endpoint — OpenAI, OpenRouter, and any OpenAI-compatible base
 * URL (Ollama `/v1`, LM Studio, vLLM, Together, Groq…). It turns a screenshot +
 * instruction into `CuaAction[]` by asking the model for a structured step
 * (`generateObject`), with a free-text JSON fallback for models that ignore
 * structured output. Provider quirks (image format, model construction, usage
 * shape, error envelope) are isolated here; the loop sees only `PredictStepResult`.
 *
 * SECURITY: the API key lives only on this in-memory instance, is sent only to
 * the configured provider, and is scrubbed from any error via `mapProviderError`.
 */
import { generateObject, generateText, NoObjectGeneratedError, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Usage } from '@open-cowork/core';
import { LlmProviderError, mapProviderError } from './errors';
import { effectiveVision, resolveModelVision } from './capabilities';
import { coerceFromText, mapModelStep, MODEL_STEP_SCHEMA, type ParsedStep } from './actionParser';
import { DEFAULT_MAX_IMAGE_BYTES, guardImageSize } from './image';
import type {
  BeginRunOptions,
  HealthResult,
  InferenceProvider,
  ModelInfo,
  PredictContext,
  PredictStepInput,
  PredictStepResult,
  ProviderConfig,
} from './types';

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface OpenAiCompatibleDeps {
  config: ProviderConfig;
  /** For listModels/health (injectable in tests). */
  fetchImpl?: typeof fetch;
  /** Pre-built model (tests inject MockLanguageModelV2 to avoid the network). */
  model?: LanguageModel;
  maxImageBytes?: number;
  /** How many prior steps to summarize into the prompt. Default 6. */
  trajectoryWindow?: number;
}

interface HistoryEntry {
  step: number;
  reasoning?: string;
  actions: string;
}

export class OpenAiCompatibleProvider implements InferenceProvider {
  readonly kind: ProviderConfig['kind'];
  private readonly config: ProviderConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly maxImageBytes: number;
  private readonly trajectoryWindow: number;
  private lm: LanguageModel | null;
  private history: HistoryEntry[] = [];

  constructor(deps: OpenAiCompatibleDeps) {
    this.config = deps.config;
    this.kind = deps.config.kind;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.maxImageBytes = deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.trajectoryWindow = deps.trajectoryWindow ?? 6;
    this.lm = deps.model ?? null;
  }

  get model(): string {
    return this.config.model;
  }

  private languageModel(): LanguageModel {
    if (this.lm) return this.lm;
    this.lm = buildModel(this.config);
    return this.lm;
  }

  async beginRun(_opts: BeginRunOptions): Promise<void> {
    // A screenshot-driven run is impossible without vision — block up front.
    if (!effectiveVision({ vision: this.config.vision }, this.config.visionOverride)) {
      throw new LlmProviderError(
        'NO_VISION',
        `"${this.config.model}" can't see images, and computer control needs a vision-capable model. Pick a vision model or switch providers.`,
      );
    }
    this.history = [];
  }

  async predict(input: PredictStepInput, ctx?: PredictContext): Promise<PredictStepResult> {
    guardImageSize(input.screenshotB64, this.maxImageBytes);
    const system = buildSystemPrompt(input.width, input.height, ctx?.systemPrompt);
    const messages = this.buildMessages(input);

    let step: ParsedStep;
    let usage: Usage;
    try {
      const result = await generateObject({
        model: this.languageModel(),
        schema: MODEL_STEP_SCHEMA,
        system,
        messages,
        abortSignal: ctx?.signal,
      });
      step = mapModelStep(result.object);
      usage = toUsage(result.usage);
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        // The model couldn't emit a clean object — retry as free text and parse.
        try {
          const t = await generateText({
            model: this.languageModel(),
            system,
            messages,
            abortSignal: ctx?.signal,
          });
          step = coerceFromText(t.text);
          usage = toUsage(t.usage);
        } catch (err2) {
          throw mapProviderError(err2, this.config.apiKey);
        }
      } else {
        throw mapProviderError(err, this.config.apiKey);
      }
    }

    this.remember(input.stepIndex, step);
    return { status: step.status, actions: step.actions, reasoning: step.reasoning ?? null, usage };
  }

  async endRun(): Promise<void> {
    this.history = [];
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      if (this.config.kind === 'openrouter') return await this.listOpenRouterModels();
      return await this.listOpenAiModels();
    } catch (err) {
      throw mapProviderError(err, this.config.apiKey);
    }
  }

  async health(): Promise<HealthResult> {
    try {
      const models = await this.listModels();
      return { ok: true, detail: `${models.length} model(s) available.` };
    } catch (err) {
      const e = mapProviderError(err, this.config.apiKey);
      return { ok: false, code: e.code, detail: e.message };
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private buildMessages(input: PredictStepInput) {
    const historyText =
      this.history.length === 0
        ? 'This is the first step.'
        : 'Steps so far:\n' +
          this.history
            .map((h) => `  ${h.step + 1}. ${h.reasoning ? `${h.reasoning} ` : ''}→ ${h.actions}`)
            .join('\n');
    return [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: `Task: ${input.instruction}\n\n${historyText}\n\nCurrent screenshot (step ${input.stepIndex + 1}). Decide the next action(s) and respond with the JSON object.`,
          },
          { type: 'image' as const, image: `data:image/png;base64,${input.screenshotB64}` },
        ],
      },
    ];
  }

  private remember(stepIndex: number, step: ParsedStep): void {
    const actions =
      step.status === 'done'
        ? 'done'
        : step.status === 'fail'
          ? 'fail'
          : step.actions.map((a) => a.action_type).join(', ') || 'no-op';
    this.history.push({ step: stepIndex, reasoning: step.reasoning, actions });
    if (this.history.length > this.trajectoryWindow) {
      this.history.splice(0, this.history.length - this.trajectoryWindow);
    }
  }

  private modelsBaseUrl(): string {
    const base = (this.config.baseUrl ?? OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
    return `${base}/models`;
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {};
  }

  private async fetchJson(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, { headers: this.authHeaders() });
    if (!res.ok) throw mapProviderError({ statusCode: res.status, message: `HTTP ${res.status}` });
    try {
      return await res.json();
    } catch {
      throw new LlmProviderError('BAD_OUTPUT', 'The provider returned a non-JSON response.');
    }
  }

  private async listOpenAiModels(): Promise<ModelInfo[]> {
    const body = (await this.fetchJson(this.modelsBaseUrl())) as { data?: { id?: string }[] };
    const data = Array.isArray(body.data) ? body.data : [];
    return data
      .filter((m): m is { id: string } => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        label: m.id,
        vision: resolveModelVision(m.id, undefined),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async listOpenRouterModels(): Promise<ModelInfo[]> {
    const body = (await this.fetchJson(OPENROUTER_MODELS_URL)) as {
      data?: {
        id?: string;
        name?: string;
        architecture?: { input_modalities?: string[]; modality?: string };
      }[];
    };
    const data = Array.isArray(body.data) ? body.data : [];
    return data
      .filter(
        (
          m,
        ): m is {
          id: string;
          name?: string;
          architecture?: { input_modalities?: string[]; modality?: string };
        } => typeof m.id === 'string',
      )
      .map((m) => {
        const mods = m.architecture?.input_modalities;
        const modality = m.architecture?.modality ?? '';
        const vision =
          Array.isArray(mods) && mods.length > 0
            ? mods.includes('image')
            : modality
              ? modality.includes('image')
              : resolveModelVision(m.id, undefined);
        return { id: m.id, label: m.name ?? m.id, vision };
      });
  }
}

/** Build the AI-SDK language model for a config. */
function buildModel(config: ProviderConfig): LanguageModel {
  switch (config.kind) {
    case 'openai':
      return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl }).chat(config.model);
    case 'openrouter':
      return createOpenRouter({ apiKey: config.apiKey ?? '' }).chat(config.model);
    case 'openai-compatible':
      if (!config.baseUrl) {
        throw new LlmProviderError(
          'PROVIDER_ERROR',
          'An OpenAI-compatible provider needs a base URL.',
        );
      }
      return createOpenAICompatible({
        name: 'byo',
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
      })(config.model);
    case 'coasty':
      throw new LlmProviderError('PROVIDER_ERROR', 'Coasty is not an AI-SDK provider.');
  }
}

function toUsage(u: { inputTokens?: number; outputTokens?: number } | undefined): Usage {
  return {
    input_tokens: u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    // BYO runs don't bill Coasty credits; provider billing is the user's own.
    credits_charged: 0,
    cost_cents: 0,
  };
}

function buildSystemPrompt(width: number, height: number, extra?: string): string {
  return [
    "You are a computer-use agent. You see a screenshot of a screen and choose the next GUI action(s) to accomplish the user's task.",
    `The screenshot is ${width}x${height} pixels. All coordinates are PIXELS in that image, origin (0,0) at the TOP-LEFT, x right, y down.`,
    'Respond ONLY with a JSON object: { "reasoning": string, "status": "continue"|"done"|"fail", "actions": Action[] }.',
    'Each Action has a "type" and the fields it needs:',
    '  click|double_click|right_click|middle_click { x, y }',
    '  type { text }            // types text at the current focus',
    '  key { keys: string[] }   // press keys in order, e.g. ["enter"]',
    '  hotkey { keys: string[] }// chord, e.g. ["ctrl","c"]',
    '  scroll { x?, y?, direction: "up"|"down"|"left"|"right", amount }',
    '  drag { x, y, to_x, to_y }',
    '  move { x, y }   wait { ms }   done {}   fail { reason }',
    'Set status "done" when the task is complete (no further actions needed), "fail" if it is impossible, otherwise "continue".',
    'Prefer one decisive action per step. Use exact pixel coordinates from the screenshot.',
    extra?.trim() ? `Additional instructions: ${extra.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
