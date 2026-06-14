/**
 * Screenshot payload guard. True downscaling needs a native image lib (sharp),
 * which we deliberately avoid for footprint; instead we cap the payload and
 * surface a clear {@link LlmProviderError} `IMAGE_TOO_LARGE` if a screenshot
 * exceeds a provider's limit, rather than firing a multi-MB request that the
 * provider rejects opaquely. Realistic 1080p/4K PNG screenshots pass the
 * generous default. (Future: optional `sharp` downscale.)
 */
import { LlmProviderError } from './errors';

/** Default cap on the decoded image size (~12 MB) — well above a 4K PNG. */
export const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Decoded byte length of a base64 string (without allocating the buffer). */
export function base64Bytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

/** Throw IMAGE_TOO_LARGE if a base64 image exceeds `maxBytes`. */
export function guardImageSize(base64: string, maxBytes: number = DEFAULT_MAX_IMAGE_BYTES): void {
  const bytes = base64Bytes(base64);
  if (bytes > maxBytes) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const capMb = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new LlmProviderError(
      'IMAGE_TOO_LARGE',
      `The screenshot is ${mb} MB, over the ${capMb} MB limit for this provider. Lower the screen resolution or pick a provider with a higher limit.`,
    );
  }
}
