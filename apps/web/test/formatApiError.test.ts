/**
 * formatApiError: turns an ApiError into a single human-readable line. The
 * key behaviour for run-create failures is that Coasty's actionable
 * `suggestion` is surfaced (so "Could not create run." isn't a dead end), along
 * with the code, offending fields, and the upstream request id.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, formatApiError, isBackendUnreachable } from '../src/api/client';

describe('formatApiError', () => {
  it('surfaces the Coasty suggestion for an otherwise-opaque create failure', () => {
    const err = new ApiError(
      502,
      'RUN_CREATE_FAILED',
      'Could not create run.',
      undefined,
      'req_a5fff7de12c245ec27484e65',
      'The machine is still booting — wait until it reports running, then retry',
    );
    const out = formatApiError(err);
    expect(out).toContain('Could not create run.');
    expect(out).toContain('still booting'); // the actionable reason is shown
    expect(out).toContain('[RUN_CREATE_FAILED]');
    expect(out).toContain('req_a5fff7de12c245ec27484e65');
  });

  it('adds a trailing period to the suggestion when missing', () => {
    const err = new ApiError(
      402,
      'INSUFFICIENT_CREDITS',
      'Out of credits',
      undefined,
      undefined,
      'Top up your account',
    );
    expect(formatApiError(err)).toContain('Top up your account.');
  });

  it('omits the suggestion when none is provided', () => {
    const err = new ApiError(409, 'ESTIMATE_CHANGED', 'The cost estimate changed');
    const out = formatApiError(err);
    expect(out).toContain('The cost estimate changed');
    expect(out).toContain('[ESTIMATE_CHANGED]');
  });

  it('lists offending field paths from validation details', () => {
    const err = new ApiError(400, 'BAD_REQUEST', 'Request validation failed', [
      { path: 'machineId', message: 'required' },
      { path: 'task', message: 'required' },
    ]);
    expect(formatApiError(err)).toContain('fields: machineId, task');
  });

  it('returns connectivity errors bare (no code/id clutter)', () => {
    const err = new ApiError(
      0,
      'NETWORK_ERROR',
      'Cannot reach the open-cowork backend — is it running?',
    );
    expect(isBackendUnreachable(err)).toBe(true);
    expect(formatApiError(err)).toBe('Cannot reach the open-cowork backend — is it running?');
  });

  it('falls back gracefully for non-ApiError values', () => {
    expect(formatApiError(new Error('boom'))).toBe('boom');
    expect(formatApiError('weird')).toBe('Unexpected error');
  });
});
