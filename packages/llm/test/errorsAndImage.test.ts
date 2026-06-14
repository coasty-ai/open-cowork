import { describe, expect, it } from 'vitest';
import { LlmProviderError, mapProviderError, redactKey } from '../src/errors';
import { base64Bytes, DEFAULT_MAX_IMAGE_BYTES, guardImageSize } from '../src/image';

describe('mapProviderError', () => {
  it('passes an LlmProviderError through unchanged', () => {
    const e = new LlmProviderError('NO_VISION', 'x');
    expect(mapProviderError(e)).toBe(e);
  });
  it('401/403 → PROVIDER_AUTH', () => {
    expect(mapProviderError({ statusCode: 401 }).code).toBe('PROVIDER_AUTH');
    expect(mapProviderError({ status: 403 }).code).toBe('PROVIDER_AUTH');
  });
  it('404 / unknown-model text → MODEL_NOT_FOUND', () => {
    expect(mapProviderError({ statusCode: 404 }).code).toBe('MODEL_NOT_FOUND');
    expect(mapProviderError({ message: 'no such model: foo' }).code).toBe('MODEL_NOT_FOUND');
  });
  it('429 → RATE_LIMITED with parsed Retry-After', () => {
    const e = mapProviderError({ statusCode: 429, responseHeaders: { 'retry-after': '3' } });
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.retryAfterMs).toBe(3000);
  });
  it('408/504/abort → TIMEOUT', () => {
    expect(mapProviderError({ statusCode: 408 }).code).toBe('TIMEOUT');
    expect(mapProviderError({ statusCode: 504 }).code).toBe('TIMEOUT');
    expect(mapProviderError({ name: 'AbortError' }).code).toBe('TIMEOUT');
    expect(mapProviderError({ name: 'TimeoutError' }).code).toBe('TIMEOUT');
  });
  it('connection errors → PROVIDER_UNREACHABLE (Ollama-down case)', () => {
    expect(mapProviderError({ code: 'ECONNREFUSED' }).code).toBe('PROVIDER_UNREACHABLE');
    expect(mapProviderError({ cause: { code: 'ENOTFOUND' } }).code).toBe('PROVIDER_UNREACHABLE');
    expect(mapProviderError({ message: 'fetch failed' }).code).toBe('PROVIDER_UNREACHABLE');
  });
  it('structured-output failures → BAD_OUTPUT', () => {
    expect(mapProviderError({ name: 'AI_NoObjectGeneratedError' }).code).toBe('BAD_OUTPUT');
    expect(mapProviderError({ name: 'TypeValidationError' }).code).toBe('BAD_OUTPUT');
  });
  it('5xx → PROVIDER_ERROR; unknown → PROVIDER_ERROR', () => {
    expect(mapProviderError({ statusCode: 500 }).code).toBe('PROVIDER_ERROR');
    expect(mapProviderError(new Error('weird')).code).toBe('PROVIDER_ERROR');
    expect(mapProviderError(undefined).code).toBe('PROVIDER_ERROR');
  });
  it('never leaks the API key into the message', () => {
    const key = 'sk-supersecret-1234567890';
    const e = mapProviderError({ message: `bad request with token ${key}` }, key);
    expect(e.message).not.toContain(key);
    expect(e.message).toContain('***');
  });
  it('messages are user-safe strings', () => {
    expect(typeof mapProviderError({ statusCode: 401 }).message).toBe('string');
  });
});

describe('redactKey', () => {
  it('scrubs the key', () => {
    expect(redactKey('a sk-abcdef token', 'sk-abcdef')).toBe('a *** token');
  });
  it('no-ops on short/absent keys', () => {
    expect(redactKey('hello', undefined)).toBe('hello');
    expect(redactKey('hello', 'abc')).toBe('hello');
  });
});

describe('image size guard', () => {
  it('base64Bytes computes decoded length', () => {
    expect(base64Bytes('')).toBe(0);
    expect(base64Bytes(Buffer.from('hello').toString('base64'))).toBe(5);
    expect(base64Bytes(Buffer.from('hi').toString('base64'))).toBe(2);
  });
  it('passes a normal image', () => {
    expect(() => guardImageSize('A'.repeat(1000))).not.toThrow();
  });
  it('throws IMAGE_TOO_LARGE over the cap', () => {
    const huge = 'A'.repeat(Math.ceil((DEFAULT_MAX_IMAGE_BYTES + 1024) * 1.34));
    try {
      guardImageSize(huge);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LlmProviderError);
      expect((e as LlmProviderError).code).toBe('IMAGE_TOO_LARGE');
    }
  });
  it('respects a custom cap', () => {
    expect(() => guardImageSize('A'.repeat(100), 10)).toThrowError(/limit/);
  });
});
