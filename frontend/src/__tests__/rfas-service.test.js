/**
 * Unit tests for src/services/rfas.js — mocked fetch.
 */
import { vi } from 'vitest';
import { fetchRFAs, fetchRFA, submitRFA, approveRFA, routeToURO } from '../services/rfas.js';

function jsonRes(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rfas service', () => {
  it('fetchRFAs GETs /api/v1/rfas with credentials and unwraps rfas', async () => {
    const rfas = [{ id: 'rfa-1' }];
    fetchMock.mockResolvedValueOnce(jsonRes({ rfas }));
    await expect(fetchRFAs()).resolves.toEqual(rfas);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/rfas', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('fetchRFAs drops null and empty-string filters from the query string', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ rfas: [] }));
    await fetchRFAs({ decision: 'pending_adjuster_review', claimId: '', urgency: null });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/rfas?decision=pending_adjuster_review',
      { method: 'GET', credentials: 'include' }
    );
  });

  it('fetchRFAs returns [] when the response has no rfas key', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}));
    await expect(fetchRFAs()).resolves.toEqual([]);
  });

  it('fetchRFA GETs /api/v1/rfas/:id', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'rfa-9' }));
    await expect(fetchRFA('rfa-9')).resolves.toEqual({ id: 'rfa-9' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/rfas/rfa-9', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('submitRFA POSTs claimId merged with the RFA payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'rfa-new' }));
    await submitRFA('WC-7', { treatment: 'PT x6', cptCodes: ['97110'] });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/rfas', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimId: 'WC-7', treatment: 'PT x6', cptCodes: ['97110'] }),
    });
  });

  it('approveRFA POSTs to /rfas/:id/approve without a body', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await approveRFA('rfa-9');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/rfas/rfa-9/approve', {
      method: 'POST',
      credentials: 'include',
    });
  });

  it('routeToURO POSTs the routing reason', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await routeToURO('rfa-9', 'surgical CPT requires physician review');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/rfas/rfa-9/route-to-uro', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'surgical CPT requires physician review' }),
    });
  });

  it('throws body.error on a non-ok response, with HTTP fallback', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'RFA already decided' }, false, 409));
    await expect(approveRFA('rfa-9')).rejects.toThrow('RFA already decided');

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => { throw new Error('bad json'); },
    });
    await expect(fetchRFAs()).rejects.toThrow('HTTP 500');
  });
});
