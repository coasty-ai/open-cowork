/**
 * Bootstrap a BYO provider from the environment.
 *
 * The point: someone who puts `ANTHROPIC_API_KEY=...` in `.env` should get a
 * working agent from `pnpm desktop` with no clicking. Before this existed the
 * only way to configure a model was the Settings dialog, which is fine for an
 * app but wrong for a local open-source tool people script and fork.
 *
 * Resolution order, most explicit first:
 *
 *   1. `COWORK_LLM_PROVIDER` names the provider outright.
 *   2. Otherwise, exactly ONE provider key present in the env wins.
 *   3. Two or more keys and no explicit choice → refuse and say so. Silently
 *      picking one would make the agent's behaviour depend on table order,
 *      which is precisely the kind of surprise this file exists to avoid.
 *
 * The model is `COWORK_LLM_MODEL` when set. When it is not, the caller resolves
 * one from `listModels()` (see `pickVisionModel`) rather than this file
 * inventing an id that may not exist on the account.
 *
 * SECURITY: this reads key VALUES out of the environment and returns them on an
 * in-memory config. It never logs them, never persists them, and
 * `describeEnvConfig` renders a redacted summary for startup output.
 */
import { BYO_PROVIDERS, isProviderKind, providerMeta, type ProviderKind } from '@open-cowork/core';
import type { ProviderConfig } from './types';

/** A minimal env bag — `process.env` in practice, a literal in tests. */
export type EnvBag = Record<string, string | undefined>;

export interface EnvProviderResolution {
  /** The config to run with, or null when the env configures no BYO provider. */
  config: ProviderConfig | null;
  /**
   * Why there is no config, or a caveat about the one returned. Surfaced at
   * startup so a typo'd variable is visible instead of silently ignored.
   */
  note?: string;
  /** True when the env is ambiguous and the user must disambiguate. */
  ambiguous?: boolean;
}

function readKey(env: EnvBag, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const raw = env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Every BYO provider that has a usable key in this environment. */
export function providersWithKeys(env: EnvBag): ProviderKind[] {
  return BYO_PROVIDERS.filter((p) => readKey(env, p.envVar)).map((p) => p.kind);
}

/**
 * Resolve a {@link ProviderConfig} from environment variables.
 * Returns `{ config: null }` when the environment asks for nothing — that is
 * the normal case, not an error, and the caller falls back to Coasty or to a
 * key stored in the desktop keychain.
 */
export function resolveProviderFromEnv(env: EnvBag): EnvProviderResolution {
  const explicitRaw = env.COWORK_LLM_PROVIDER?.trim();
  const model = env.COWORK_LLM_MODEL?.trim() || undefined;
  const baseUrl = env.COWORK_LLM_BASE_URL?.trim() || undefined;

  if (explicitRaw) {
    if (!isProviderKind(explicitRaw) || explicitRaw === 'coasty') {
      const valid = BYO_PROVIDERS.map((p) => p.kind).join(', ');
      return {
        config: null,
        note: `COWORK_LLM_PROVIDER="${explicitRaw}" is not a BYO provider. Valid values: ${valid}.`,
      };
    }
    const meta = providerMeta(explicitRaw);
    const apiKey = readKey(env, meta?.envVar) ?? readKey(env, 'COWORK_LLM_API_KEY');
    if (meta?.needsKey && !apiKey) {
      return {
        config: null,
        note: `COWORK_LLM_PROVIDER=${explicitRaw} needs ${meta.envVar}, which is not set.`,
      };
    }
    return {
      config: buildConfig(explicitRaw, { apiKey, model, baseUrl }),
      note: model ? undefined : 'COWORK_LLM_MODEL is unset — a vision model will be auto-selected.',
    };
  }

  const withKeys = providersWithKeys(env);
  if (withKeys.length === 0) return { config: null };
  if (withKeys.length > 1) {
    return {
      config: null,
      ambiguous: true,
      note:
        `Multiple provider keys are set (${withKeys.join(', ')}). ` +
        'Set COWORK_LLM_PROVIDER to choose one — refusing to guess.',
    };
  }

  const kind = withKeys[0]!;
  const meta = providerMeta(kind);
  return {
    config: buildConfig(kind, { apiKey: readKey(env, meta?.envVar), model, baseUrl }),
    note: model ? undefined : 'COWORK_LLM_MODEL is unset — a vision model will be auto-selected.',
  };
}

function buildConfig(
  kind: ProviderKind,
  parts: { apiKey?: string; model?: string; baseUrl?: string },
): ProviderConfig {
  const meta = providerMeta(kind);
  return {
    kind,
    // An empty model is legal here: the caller fills it from listModels().
    model: parts.model ?? '',
    apiKey: parts.apiKey,
    baseUrl: parts.baseUrl ?? (meta?.defaultBaseUrl || undefined),
    label: meta?.label,
  };
}

/**
 * Choose a model when the environment did not name one: prefer an explicitly
 * vision-capable model, and fail loudly rather than returning a text-only model
 * that would break on the first screenshot.
 *
 * `suggestedModel` is honoured ONLY if the provider actually lists it — that is
 * what keeps the registry's hint from becoming a wrong hard-coded id.
 */
export function pickVisionModel(
  models: { id: string; vision: boolean | 'unknown' }[],
  suggested?: string,
): { model?: string; note?: string } {
  if (models.length === 0) return { note: 'The provider returned no models.' };
  const visionModels = models.filter((m) => m.vision === true);
  if (suggested) {
    const hit =
      visionModels.find((m) => m.id === suggested) ?? models.find((m) => m.id === suggested);
    if (hit) return { model: hit.id };
  }
  if (visionModels.length > 0) {
    return { model: visionModels[0]!.id };
  }
  const unknown = models.filter((m) => m.vision === 'unknown');
  if (unknown.length > 0) {
    return {
      model: unknown[0]!.id,
      note: `Could not confirm ${unknown[0]!.id} accepts images. Set COWORK_LLM_MODEL to a vision model if runs fail.`,
    };
  }
  return {
    note: 'No vision-capable model was found for this provider. Computer use needs one — set COWORK_LLM_MODEL explicitly.',
  };
}

/** A redacted one-line summary, safe to print at startup. */
export function describeEnvConfig(config: ProviderConfig): string {
  const meta = providerMeta(config.kind);
  const key = config.apiKey ? `${meta?.envVar ?? 'key'}=set` : 'no key';
  return `${meta?.label ?? config.kind} · ${config.model || '(model auto-select)'} · ${key}`;
}
