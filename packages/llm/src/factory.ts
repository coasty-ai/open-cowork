/**
 * Build the right {@link InferenceProvider} for a {@link ProviderConfig}. Coasty
 * is the default and needs the backend handle; BYO providers are self-contained.
 */
import type { LanguageModel } from 'ai';
import type { CuaVersion } from '@open-cowork/core';
import { CoastyProvider } from './coastyProvider';
import { OpenAiCompatibleProvider } from './openaiCompatibleProvider';
import type { InferenceProvider, ProviderConfig } from './types';

export interface MakeProviderDeps {
  /** Required for the Coasty provider. */
  backendUrl?: string;
  getToken?: () => string | null;
  /** Used by Coasty's proxy calls and BYO's listModels/health. */
  fetchImpl?: typeof fetch;
  /** Test seam: a pre-built AI-SDK model for BYO providers. */
  model?: LanguageModel;
  maxImageBytes?: number;
}

export function makeProvider(
  config: ProviderConfig,
  deps: MakeProviderDeps = {},
): InferenceProvider {
  if (config.kind === 'coasty') {
    if (!deps.backendUrl || !deps.getToken) {
      throw new Error('CoastyProvider needs backendUrl + getToken');
    }
    return new CoastyProvider({
      backendUrl: deps.backendUrl,
      getToken: deps.getToken,
      fetchImpl: deps.fetchImpl,
      cuaVersion: (config.model as CuaVersion) || 'v3',
    });
  }
  return new OpenAiCompatibleProvider({
    config,
    fetchImpl: deps.fetchImpl,
    model: deps.model,
    maxImageBytes: deps.maxImageBytes,
  });
}
