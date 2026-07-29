/**
 * The single source of truth for BYO model providers: which vendors exist, what
 * each one needs, and which environment variable supplies its key.
 *
 * This lives in `core` — which has ZERO dependencies — precisely so both the
 * desktop (which also loads `@open-cowork/llm` and the AI SDK) and the web app
 * (which must never bundle the AI SDK) can read the SAME table. Before this,
 * `ProviderKind` was written out by hand in four places and drifted.
 *
 * Everything here is inert metadata. `envVar` is only the NAME of a variable;
 * no key value ever appears in this file.
 */

/**
 * Which provider implementation backs a run.
 *
 * `anthropic` and `google` are FIRST-CLASS, not `openai-compatible` aliases:
 * neither speaks the OpenAI dialect. Anthropic authenticates with `x-api-key`
 * plus a dated `anthropic-version` header and uses its own content shape;
 * Gemini uses `?key=` against generativelanguage.googleapis.com. Pointing the
 * OpenAI dialect at either base URL fails at the transport layer.
 */
export type ProviderKind =
  | 'coasty'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'openai-compatible';

/** Every BYO kind — i.e. everything except Coasty's built-in CUA. */
export const BYO_PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'openai-compatible',
] as const satisfies readonly ProviderKind[];

/** All kinds, Coasty included. Use for validating untrusted input. */
export const PROVIDER_KINDS = [
  'coasty',
  ...BYO_PROVIDER_KINDS,
] as const satisfies readonly ProviderKind[];

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface ProviderMeta {
  kind: ProviderKind;
  /** Human label for the Settings UI. */
  label: string;
  /** Environment variable that supplies this provider's API key. */
  envVar?: string;
  /** False only for endpoints commonly run unauthenticated (Ollama, LM Studio). */
  needsKey: boolean;
  /** Pre-filled base URL. Empty means "use the SDK's own default endpoint". */
  defaultBaseUrl: string;
  /** Whether the user is expected to edit the base URL. */
  baseUrlEditable: boolean;
  baseUrlHint: string;
  /**
   * A commonly-available vision model, used ONLY to pre-fill the input box and
   * as a preference when auto-selecting. Never assumed to exist: `listModels()`
   * is authoritative and the bootstrap verifies a model before choosing it.
   */
  suggestedModel?: string;
  /** Where to get a key. */
  docsUrl: string;
}

const META: Record<Exclude<ProviderKind, 'coasty'>, ProviderMeta> = {
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    envVar: 'ANTHROPIC_API_KEY',
    needsKey: true,
    defaultBaseUrl: '',
    baseUrlEditable: true,
    baseUrlHint: 'Uses https://api.anthropic.com by default — leave blank.',
    suggestedModel: 'claude-sonnet-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    needsKey: true,
    defaultBaseUrl: '',
    baseUrlEditable: true,
    baseUrlHint: 'Uses https://api.openai.com/v1 by default — leave blank.',
    suggestedModel: 'gpt-4o',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  google: {
    kind: 'google',
    label: 'Google (Gemini)',
    envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
    needsKey: true,
    defaultBaseUrl: '',
    baseUrlEditable: false,
    baseUrlHint: 'Uses Google’s Generative Language endpoint — leave blank.',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  openrouter: {
    kind: 'openrouter',
    label: 'OpenRouter (any model)',
    envVar: 'OPENROUTER_API_KEY',
    needsKey: true,
    defaultBaseUrl: '',
    baseUrlEditable: false,
    baseUrlHint: 'Uses https://openrouter.ai by default — leave blank.',
    docsUrl: 'https://openrouter.ai/keys',
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible (Ollama, LM Studio, vLLM…)',
    // A local endpoint usually needs no key, but hosted OpenAI-dialect gateways
    // (Together, Groq, Fireworks…) do — so a key is optional, not absent.
    envVar: 'COWORK_LLM_API_KEY',
    needsKey: false,
    defaultBaseUrl: 'http://localhost:11434/v1',
    baseUrlEditable: true,
    baseUrlHint: 'The /v1 endpoint, e.g. Ollama http://localhost:11434/v1',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
  },
};

/** Metadata for one BYO kind. Coasty is not a BYO provider and has no entry. */
export function providerMeta(kind: ProviderKind): ProviderMeta | null {
  return kind === 'coasty' ? null : META[kind];
}

/** Every BYO provider, in the order the Settings UI should present them. */
export const BYO_PROVIDERS: readonly ProviderMeta[] = BYO_PROVIDER_KINDS.map((k) => META[k]);

/** The env var that supplies a key for `kind`, when it has one. */
export function providerEnvVar(kind: ProviderKind): string | undefined {
  return providerMeta(kind)?.envVar;
}
