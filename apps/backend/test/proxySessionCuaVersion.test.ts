/**
 * The inference proxy must accept every engine version in `CUA_VERSIONS`.
 *
 * It validated against a hand-typed copy of the list that had drifted, so `v5` — valid
 * everywhere else, and the default for submit-and-forget tasks — was rejected here (#12).
 * Driving the real route rather than the schema in isolation, since the schema is defined
 * inline and a unit test would not have caught the drift.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CUA_VERSIONS } from '@open-cowork/core';
import { startHarness, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('POST /api/proxy/sessions accepts every engine version', () => {
  it.each([...CUA_VERSIONS])('accepts cuaVersion %s', async (version) => {
    h = await startHarness();
    const res = await h.api('/api/proxy/sessions', {
      method: 'POST',
      body: JSON.stringify({ cuaVersion: version, screenWidth: 1280, screenHeight: 720 }),
    });
    expect(res.status).toBe(200);
  });
});
