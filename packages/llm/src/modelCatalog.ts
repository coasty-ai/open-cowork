/**
 * Model capability lookup: "can this model see images?"
 *
 * Answered from three sources, most authoritative first:
 *
 *   1. the live provider's own metadata (OpenRouter modalities, Ollama
 *      capabilities) — handled by the caller, never overridden here;
 *   2. this catalog — a committed snapshot of models.dev, optionally refreshed
 *      over the network for models released since the snapshot;
 *   3. name heuristics in `capabilities.ts` — the offline last resort.
 *
 * The snapshot is what makes the app correct with no network and on first run.
 * The refresh is what keeps it correct for a model released yesterday. Neither
 * is required: with both unavailable we fall through to heuristics and finally
 * to 'unknown', which the UI resolves with an explicit user override.
 *
 * Nothing here throws. A capability lookup must never be the reason a run
 * fails to start.
 */
import {
  CATALOG_STATS,
  CATALOG_TEXT_ONLY_MODELS,
  CATALOG_VISION_MODELS,
} from './modelCatalog.generated';

const MODELS_DEV_URL = 'https://models.dev/api.json';
/** A capability lookup is a UI nicety; it must not hang the Settings dialog. */
const DEFAULT_REFRESH_TIMEOUT_MS = 8_000;

/**
 * Normalize a model id so one catalog entry matches every spelling of the same
 * model: OpenRouter prefixes the vendor (`anthropic/claude-sonnet-5`), Ollama
 * suffixes a tag (`qwen2.5-vl:7b`), and casing varies by provider.
 *
 * Kept identical to the normalization in `scripts/update-model-catalog.mjs` —
 * if the two ever diverge, every lookup silently misses.
 */
export function normalizeModelId(id: string): string {
  return String(id ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/:[^:]*$/, '');
}

// Live additions layered over the generated snapshot. Kept separate so a
// refresh never mutates the imported constants.
const liveVision = new Set<string>();
const liveTextOnly = new Set<string>();

/**
 * Vision capability for a model id according to the catalog, or `'unknown'`
 * when the catalog has never heard of it (most local/finetuned models).
 */
export function catalogVision(modelId: string): boolean | 'unknown' {
  const id = normalizeModelId(modelId);
  if (!id) return 'unknown';
  if (liveVision.has(id) || CATALOG_VISION_MODELS.has(id)) return true;
  if (liveTextOnly.has(id) || CATALOG_TEXT_ONLY_MODELS.has(id)) return false;
  return 'unknown';
}

export interface CatalogRefreshResult {
  ok: boolean;
  /** Ids learned that the bundled snapshot did not already know. */
  added: number;
  /** Total models seen in the fetched catalog. */
  models: number;
  detail?: string;
}

interface ModelsDevModel {
  id?: string;
  modalities?: { input?: string[] };
}
interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

/**
 * Refresh the catalog from models.dev. Safe to call at any time and safe to
 * ignore: on any failure — offline, slow, rate-limited, malformed — the bundled
 * snapshot stays in force and this reports `ok: false` rather than throwing.
 */
export async function refreshCatalog(
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CatalogRefreshResult> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort);

  try {
    const res = await fetchImpl(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) return { ok: false, added: 0, models: 0, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as Record<string, ModelsDevProvider>;
    if (!body || typeof body !== 'object') {
      return { ok: false, added: 0, models: 0, detail: 'unexpected response shape' };
    }

    // Tally votes per id, exactly as scripts/update-model-catalog.mjs does:
    // the same model is listed by many gateways and they disagree. A single
    // aggregator claiming `gpt-3.5-turbo` takes images must not outvote the
    // eight that say otherwise.
    const votes = new Map<string, { image: number; text: number }>();
    let models = 0;
    for (const provider of Object.values(body)) {
      for (const model of Object.values(provider?.models ?? {})) {
        if (!model?.id) continue;
        models++;
        const inputs = model.modalities?.input;
        if (!Array.isArray(inputs) || inputs.length === 0) continue;
        const id = normalizeModelId(model.id);
        if (!id) continue;
        const tally = votes.get(id) ?? { image: 0, text: 0 };
        if (inputs.includes('image')) tally.image++;
        else tally.text++;
        votes.set(id, tally);
      }
    }

    const seenVision = new Set<string>();
    const seenTextOnly = new Set<string>();
    for (const [id, { image, text }] of votes) {
      // Strict majority; a tie stays unknown so the heuristic decides.
      if (image > text) seenVision.add(id);
      else if (text > image) seenTextOnly.add(id);
    }

    let added = 0;
    for (const id of seenVision) {
      if (!CATALOG_VISION_MODELS.has(id) && !liveVision.has(id)) added++;
      liveVision.add(id);
      liveTextOnly.delete(id);
    }
    for (const id of seenTextOnly) {
      if (liveVision.has(id) || CATALOG_VISION_MODELS.has(id)) continue;
      if (!CATALOG_TEXT_ONLY_MODELS.has(id) && !liveTextOnly.has(id)) added++;
      liveTextOnly.add(id);
    }
    return { ok: true, added, models };
  } catch (err) {
    const detail =
      err instanceof Error
        ? controller.signal.aborted
          ? `timed out after ${timeoutMs}ms`
          : err.message
        : 'unknown error';
    return { ok: false, added: 0, models: 0, detail };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Counts for diagnostics: what the bundled snapshot holds plus live additions. */
export function catalogStats(): {
  providers: number;
  models: number;
  vision: number;
  textOnly: number;
  liveVision: number;
  liveTextOnly: number;
} {
  return {
    ...CATALOG_STATS,
    liveVision: liveVision.size,
    liveTextOnly: liveTextOnly.size,
  };
}

/** Drop live additions (tests). The bundled snapshot is unaffected. */
export function resetCatalogRefresh(): void {
  liveVision.clear();
  liveTextOnly.clear();
}
