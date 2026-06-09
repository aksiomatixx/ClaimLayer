/**
 * Unit tests for src/services/claims.js — mocked fetch.
 */
import { vi } from 'vitest';
import {
  fetchClaims,
  fetchClaim,
  updateClaimStatus,
  approveReserves,
  triggerAnalysis,
  fetchDiaries,
  ensureDevSession,
} from '../services/claims.js';

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

describe('claims service', () => {
  it('fetchClaims GETs /api/v1/claims with credentials and unwraps claims', async () => {
    const claims = [{ id: 'WC-1' }, { id: 'WC-2' }];
    fetchMock.mockResolvedValueOnce(jsonRes({ claims }));

    await expect(fetchClaims()).resolves.toEqual(claims);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/claims', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('fetchClaims serializes filters into the query string, dropping null/undefined', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ claims: [] }));
    await fetchClaims({ status: 'accepted', employer: undefined, priority: null });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/claims?status=accepted', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('fetchClaims returns [] when the response has no claims key', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}));
    await expect(fetchClaims()).resolves.toEqual([]);
  });

  it('fetchClaim GETs /api/v1/claims/:id', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'WC-7' }));
    await expect(fetchClaim('WC-7')).resolves.toEqual({ id: 'WC-7' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/claims/WC-7', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('updateClaimStatus PATCHes a JSON status body', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await updateClaimStatus('WC-7', 'accepted');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/claims/WC-7/status', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'accepted' }),
    });
  });

  it('approveReserves PATCHes the reserves body', async () => {
    const reserves = { medical: 12000, indemnity: 8000, expense: 1500 };
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await approveReserves('WC-7', reserves);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/claims/WC-7/reserves', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reserves),
    });
  });

  it('triggerAnalysis POSTs without a body', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ queued: true }));
    await triggerAnalysis('WC-7');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/claims/WC-7/analyze', {
      method: 'POST',
      credentials: 'include',
    });
  });

  it('fetchDiaries unwraps diaries and defaults to []', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ diaries: [{ id: 1 }] }));
    await expect(fetchDiaries('WC-7')).resolves.toEqual([{ id: 1 }]);
    fetchMock.mockResolvedValueOnce(jsonRes({}));
    await expect(fetchDiaries('WC-7')).resolves.toEqual([]);
  });

  it('throws body.error on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'claim not found' }, false, 404));
    await expect(fetchClaim('nope')).rejects.toThrow('claim not found');
  });

  it('falls back to "HTTP <status>" when the error body is unparseable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => { throw new Error('bad json'); },
    });
    await expect(fetchClaims()).rejects.toThrow('HTTP 503');
  });

  it('ensureDevSession swallows failures (non-fatal in production)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(ensureDevSession()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/dev-session', {
      method: 'GET',
      credentials: 'include',
    });
  });
});
