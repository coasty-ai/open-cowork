/**
 * Provider metadata re-exported from `@open-cowork/core`.
 *
 * The table itself lives in core (which has zero dependencies) so the web app
 * can render the Settings UI from the SAME data without pulling the AI SDK into
 * its bundle. This module exists so provider-side code has one obvious import
 * (`@open-cowork/llm`) rather than reaching across packages.
 *
 * To add a provider: add an entry to `packages/core/src/providers.ts` and a
 * `buildModel` case in `openaiCompatibleProvider.ts`. Nothing else.
 */
export { BYO_PROVIDERS, providerMeta, providerEnvVar } from '@open-cowork/core';
export type { ProviderMeta } from '@open-cowork/core';
