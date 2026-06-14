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
import {
  coerceFromText,
  extractJson,
  mapModelStep,
  MODEL_STEP_SCHEMA,
  normalizeStepShape,
  type ParsedStep,
} from './actionParser';
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
/** Per-step reasoning kept in the in-prompt trajectory is capped so a chatty
 *  (e.g. chain-of-thought) model can't grow the prompt/memory without bound. */
const MAX_REASONING_CHARS = 500;

const JSON_ONLY_REMINDER =
  'IMPORTANT: Output ONLY the JSON object — no prose, no explanation, no markdown, no backticks. Your entire reply must start with "{" and end with "}".';

const JSON_REPAIR_SYSTEM =
  'You convert an assistant message into ONE JSON object for a computer-use agent, with keys "reasoning" (string), "status" ("continue"|"done"|"fail"), and "actions" (array of {type, ...}). Output ONLY the JSON object — no prose, no markdown.';

const JSON_REPAIR_USER =
  'Convert the following answer into that single JSON object. Output ONLY the JSON.\n\nAnswer to convert:';

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
    const signal = ctx?.signal;

    let step: ParsedStep;
    let usage: Usage;
    try {
      const result = await generateObject({
        model: this.languageModel(),
        schema: MODEL_STEP_SCHEMA,
        system,
        messages,
        abortSignal: signal,
        // Recover JSON the model wrapped in prose / fences / arrays (or emitted as
        // a bare action) before the SDK gives up — structured output then succeeds
        // for far more models without a second round-trip.
        experimental_repairText: async ({ text }) => repairToStepJson(text),
      });
      step = mapModelStep(result.object);
      usage = toUsage(result.usage);
    } catch (err) {
      // An abort is a cancellation, not a parse failure — surface immediately.
      if (signal?.aborted) throw mapProviderError(err, this.config.apiKey);
      // Fall back to free text when the model gave no clean object OR the endpoint
      // rejected structured output (common for local / OpenAI-compatible servers).
      if (!canFallBackToText(err)) throw mapProviderError(err, this.config.apiKey);
      ({ step, usage } = await this.predictViaText(system, messages, signal));
    }

    this.remember(input.stepIndex, step);
    return { status: step.status, actions: step.actions, reasoning: step.reasoning ?? null, usage };
  }

  /**
   * Free-text recovery for models that won't (or can't) honor structured output.
   * Escalates: (1) re-ask with a forceful "JSON only" reminder, then (2) a repair
   * turn that hands the model its own prose back and asks it to convert it to JSON.
   * Only if BOTH yield nothing parseable do we fail — with an actionable message.
   */
  private async predictViaText(
    system: string,
    messages: ReturnType<OpenAiCompatibleProvider['buildMessages']>,
    signal?: AbortSignal,
  ): Promise<{ step: ParsedStep; usage: Usage }> {
    const model = this.languageModel();
    let lastText = '';
    // Pass 1 — re-ask, JSON only.
    try {
      const t = await generateText({
        model,
        system: `${system}\n\n${JSON_ONLY_REMINDER}`,
        messages,
        abortSignal: signal,
      });
      lastText = t.text;
      return { step: coerceFromText(t.text), usage: toUsage(t.usage) };
    } catch (err) {
      if (signal?.aborted) throw mapProviderError(err, this.config.apiKey);
      if (!(err instanceof LlmProviderError && err.code === 'BAD_OUTPUT')) {
        throw mapProviderError(err, this.config.apiKey);
      }
    }
    // Pass 2 — repair turn: resend the model's own answer and demand JSON only.
    try {
      const r = await generateText({
        model,
        system: JSON_REPAIR_SYSTEM,
        messages: [{ role: 'user' as const, content: `${JSON_REPAIR_USER}\n\n${lastText}` }],
        abortSignal: signal,
      });
      return { step: coerceFromText(r.text), usage: toUsage(r.usage) };
    } catch (err) {
      if (signal?.aborted) throw mapProviderError(err, this.config.apiKey);
      if (err instanceof LlmProviderError && err.code === 'BAD_OUTPUT') {
        throw new LlmProviderError(
          'BAD_OUTPUT',
          "The model didn't return a usable JSON action after retries — it may not reliably follow JSON instructions. Try a more capable, instruction-tuned vision model (e.g. a 7B+ '-vl' / 'vision' model) or a hosted provider.",
        );
      }
      throw mapProviderError(err, this.config.apiKey);
    }
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
            text: `Task: ${input.instruction}\n\n${historyText}\n\nCurrent screenshot (step ${input.stepIndex + 1}) — ${input.width}x${input.height} px. Choose the next action(s); give coordinates as absolute pixels within THIS image. Respond with the JSON object.`,
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
    const reasoning =
      step.reasoning && step.reasoning.length > MAX_REASONING_CHARS
        ? step.reasoning.slice(0, MAX_REASONING_CHARS)
        : step.reasoning;
    this.history.push({ step: stepIndex, reasoning, actions });
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
        // An `input_modalities` array is authoritative even when empty (the model
        // explicitly accepts no images → not vision); only fall back to the
        // modality string (token-matched, not substring) or the name heuristic
        // when OpenRouter exposes no modalities array at all.
        const vision = Array.isArray(mods)
          ? mods.includes('image')
          : modality
            ? modality
                .split(',')
                .map((s) => s.trim())
                .includes('image')
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

/** True when a structured-output failure is worth retrying as free text. */
function canFallBackToText(err: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(err)) return true;
  if (err instanceof LlmProviderError) return err.code === 'BAD_OUTPUT';
  const o = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const status = (o.statusCode ?? o.status) as number | undefined;
  // 400/422 here usually means the endpoint rejected response_format / tools.
  return status === 400 || status === 422;
}

/** Repair hook for generateObject: pull a step-shaped object out of raw text. */
function repairToStepJson(text: string): string | null {
  try {
    return JSON.stringify(normalizeStepShape(extractJson(text)));
  } catch {
    return null;
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
    `The screenshot is EXACTLY ${width}x${height} pixels.`,
    `Coordinates are ABSOLUTE INTEGER PIXELS in that image: x in [0, ${width - 1}], y in [0, ${height - 1}], origin (0,0) at the TOP-LEFT (x increases right, y increases down). Do NOT output normalized (0-1), percentage, or 0-1000-scaled coordinates, and do NOT assume any other resolution. Target the CENTER of the element you want to act on.`,
    'Respond with a SINGLE JSON object and NOTHING else — no prose, no explanation, no <think> notes, no markdown code fences. Your entire reply must start with "{" and end with "}".',
    'Schema: { "reasoning": string, "status": "continue"|"done"|"fail", "actions": Action[] }.',
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
    'Example of a valid reply (match this format exactly):',
    '{"reasoning":"The search box is near the top center.","status":"continue","actions":[{"type":"click","x":640,"y":48}]}',
    extra?.trim() ? `Additional instructions: ${extra.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
