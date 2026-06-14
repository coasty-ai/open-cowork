/**
 * Coasty as one {@link InferenceProvider} — the default. It wraps the SAME
 * backend inference proxy the desktop already uses for local runs
 * (`/api/proxy/sessions[/:id/predict]`), so selecting "Coasty" reproduces
 * today's behaviour exactly (the key stays server-side; we only hold the
 * short-lived session token). Vision is inherent to the CUA model, so it never
 * blocks. `listModels` reports the CUA versions.
 */
import type { CreateSessionResponse, CuaVersion, SessionPredictResponse } from '@open-cowork/core';
import { mapProviderError } from './errors';
import type {
  BeginRunOptions,
  HealthResult,
  InferenceProvider,
  ModelInfo,
  PredictContext,
  PredictStepInput,
  PredictStepResult,
} from './types';

export interface CoastyProviderDeps {
  /** open-cowork backend base URL, e.g. http://127.0.0.1:4000 */
  backendUrl: string;
  /** Short-lived session token getter (the renderer's signed-in session). */
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
  /** CUA engine version (the "model"). Default v3. */
  cuaVersion?: CuaVersion;
}

export class CoastyProvider implements InferenceProvider {
  readonly kind = 'coasty' as const;
  private readonly backendUrl: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly cuaVersion: CuaVersion;
  private sessionId: string | null = null;

  constructor(deps: CoastyProviderDeps) {
    this.backendUrl = deps.backendUrl.replace(/\/+$/, '');
    this.getToken = deps.getToken;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.cuaVersion = deps.cuaVersion ?? 'v3';
  }

  get model(): string {
    return this.cuaVersion;
  }

  async listModels(): Promise<ModelInfo[]> {
    return (['v4', 'v3', 'v1'] as CuaVersion[]).map((v) => ({
      id: v,
      label: `Coasty CUA ${v}`,
      vision: true,
      tools: true,
    }));
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: 'Coasty (managed) — key configured server-side.' };
  }

  async beginRun(opts: BeginRunOptions): Promise<void> {
    const session = await this.api<CreateSessionResponse>('/api/proxy/sessions', 'POST', {
      cuaVersion: opts.cuaVersion ?? this.cuaVersion,
      screenWidth: opts.width,
      screenHeight: opts.height,
    });
    this.sessionId = session.session_id;
  }

  async predict(input: PredictStepInput, ctx?: PredictContext): Promise<PredictStepResult> {
    if (!this.sessionId) {
      // Defensive: a caller that skipped beginRun still works (lazy session).
      await this.beginRun({ task: input.instruction, width: input.width, height: input.height });
    }
    const res = await this.api<SessionPredictResponse>(
      `/api/proxy/sessions/${this.sessionId}/predict`,
      'POST',
      { screenshot: input.screenshotB64, instruction: input.instruction },
      ctx?.signal,
    );
    return { status: res.status, actions: res.actions, reasoning: res.reasoning, usage: res.usage };
  }

  async endRun(): Promise<void> {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    try {
      await this.api(`/api/proxy/sessions/${id}`, 'DELETE');
    } catch {
      // Session cleanup is best-effort; it also expires server-side.
    }
  }

  private async api<T = unknown>(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.backendUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw mapProviderError(err);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const parsed = (await res.json()) as { error?: { message?: string } };
        detail = parsed.error?.message ?? '';
      } catch {
        // non-JSON error body
      }
      throw mapProviderError({ statusCode: res.status, message: detail || `HTTP ${res.status}` });
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
