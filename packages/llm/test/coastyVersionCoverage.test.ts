/**
 * `listModels` must offer every engine version, not a hand-maintained subset.
 *
 * It previously hard-coded `['v4','v3','v1']`, so `v5` was never offered — the same drift that
 * made #12 reject `v5` at the proxy. Asserting against `CUA_VERSIONS` means adding a version
 * cannot silently skip this list.
 */
import { describe, expect, it } from 'vitest';
import { CUA_VERSIONS } from '@open-cowork/core';
import { CoastyProvider } from '../src/coastyProvider';

describe('CoastyProvider.listModels covers every engine version', () => {
  it('offers all of CUA_VERSIONS', async () => {
    const p = new CoastyProvider({ backendUrl: 'http://b', getToken: () => 't' });
    const ids = (await p.listModels()).map((m) => m.id);
    expect([...ids].sort()).toEqual([...CUA_VERSIONS].sort());
  });

  it('offers v5 specifically — the version that was missing', async () => {
    const p = new CoastyProvider({ backendUrl: 'http://b', getToken: () => 't' });
    expect((await p.listModels()).map((m) => m.id)).toContain('v5');
  });
});
