import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, getToken, setToken } from '../src/api';
import { bodyOf, findCall, jsonRes, stubFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

describe('token store', () => {
  it('holds the session token at module level', () => {
    expect(getToken()).toBeNull();
    setToken('tok_1');
    expect(getToken()).toBe('tok_1');
    setToken(null);
    expect(getToken()).toBeNull();
  });
});

describe('api client', () => {
  it('sends the bearer token and content-type on every request', async () => {
    setToken('tok_99');
    const fetchMock = stubFetch(() => jsonRes({ runs: [] }));
    await api.listRuns();

    const call = findCall(fetchMock, '/api/runs');
    expect(call).toBeDefined();
    const headers = call!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_99');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits the Authorization header when signed out', async () => {
    const fetchMock = stubFetch(() => jsonRes({ runs: [] }));
    await api.listRuns();
    const headers = findCall(fetchMock, '/api/runs')!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('pollRunEvents builds the events.json cursor URL', async () => {
    const fetchMock = stubFetch(() => jsonRes({ events: [], done: false }));
    await api.pollRunEvents('r_42', 17);
    expect(findCall(fetchMock, '/api/runs/r_42/events.json?after=17')).toBeDefined();
  });

  it('resumeWorkflowRun posts {approved, note}', async () => {
    const fetchMock = stubFetch(() => jsonRes({ id: 'wfr_1' }));
    await api.resumeWorkflowRun('wfr_1', { approved: false, note: 'not today' });
    const call = findCall(fetchMock, '/api/workflows/runs/wfr_1/resume');
    expect(call!.init?.method).toBe('POST');
    expect(bodyOf(call!.init)).toEqual({ approved: false, note: 'not today' });
  });

  it('maps the backend error envelope to ApiError', async () => {
    stubFetch(() =>
      jsonRes({ error: { code: 'BUDGET_EXCEEDED', message: 'Cap exceeded' } }, 422),
    );
    const err = await api.getRun('r_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe('BUDGET_EXCEEDED');
    expect((err as ApiError).message).toBe('Cap exceeded');
  });

  it('maps network failures to ApiError NETWORK_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await api.wallet().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).code).toBe('NETWORK_ERROR');
  });
});
