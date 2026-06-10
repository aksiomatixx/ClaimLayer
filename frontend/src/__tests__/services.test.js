/**
 * Unit tests for the service-layer fetch contract — mocked fetch.
 *
 * Covers services/claims.js and services/pd.js: URL, HTTP method,
 * credentials: 'include', JSON body shape, and the non-ok error path
 * (body.error preferred, "HTTP <status>" fallback).
 *
 * Fuller claims.js coverage (filters, unwrapping, dev session) lives in
 * claims-service.test.js; this file owns the pd.js suite.
 */
import { vi } from 'vitest';
import { fetchClaims, fetchClaim, updateClaimStatus } from '../services/claims.js';
import {
  calculatePD,
  initiatePDAdvances,
  recordPDAdvancePayment,
  waivePDAdvance,
  createStipulation,
  sendStipToWorker,
  recordWorkerSignature,
  recordAdjusterSignature,
  recordEAMSFiled,
  fetchPDData,
} from '../services/pd.js';

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

describe('services/claims.js fetch contract', () => {
  it('fetchClaims GETs /api/v1/claims with credentials: include', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ claims: [{ id: 'WC-1' }] }));
    await expect(fetchClaims()).resolves.toEqual([{ id: 'WC-1' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/claims', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('updateClaimStatus PATCHes a JSON body with Content-Type header', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await updateClaimStatus('WC-9', 'denied');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/claims/WC-9/status', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'denied' }),
    });
  });

  it('throws body.error on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'claim not found' }, false, 404));
    await expect(fetchClaim('nope')).rejects.toThrow('claim not found');
  });

  it('falls back to "HTTP <status>" when the error body has no error key', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}, false, 500));
    await expect(fetchClaim('WC-1')).rejects.toThrow('HTTP 500');
  });
});

describe('services/pd.js fetch contract', () => {
  it('calculatePD POSTs pr4Id + apportionmentPercent to /pd/calculate/:claimId', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ pdPercent: 22 }));
    await expect(calculatePD('WC-7', 'pr4-1', 15)).resolves.toEqual({ pdPercent: 22 });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/pd/calculate/WC-7', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr4Id: 'pr4-1', apportionmentPercent: 15 }),
    });
  });

  it('calculatePD URL-encodes the claim id', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}));
    await calculatePD('WC 7/legacy', 'pr4-1', 0);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/pd/calculate/WC%207%2Flegacy');
  });

  it('initiatePDAdvances POSTs pdEvaluationId + tdEndDate to /pd/advances/:claimId', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ advances: [] }));
    await initiatePDAdvances('WC-7', 'eval-3', '2026-06-01');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/pd/advances/WC-7', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdEvaluationId: 'eval-3', tdEndDate: '2026-06-01' }),
    });
  });

  it('recordPDAdvancePayment PATCHes an empty JSON object body', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ paid: true }));
    await recordPDAdvancePayment('adv-12');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/pd/advances/adv-12/payment', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('waivePDAdvance PATCHes the waive reason', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ waived: true }));
    await waivePDAdvance('adv-12', 'worker returned to work');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/pd/advances/adv-12/waive', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'worker returned to work' }),
    });
  });

  it('createStipulation POSTs pdEvaluationId spread with opts', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 'stip-1' }));
    await createStipulation('WC-7', 'eval-3', { weeklyRate: 290, attorney: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/pd/stip/WC-7', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdEvaluationId: 'eval-3', weeklyRate: 290, attorney: false }),
    });
  });

  it.each([
    ['sendStipToWorker', sendStipToWorker, 'send'],
    ['recordWorkerSignature', recordWorkerSignature, 'worker-signature'],
    ['recordAdjusterSignature', recordAdjusterSignature, 'adjuster-signature'],
  ])('%s PATCHes /pd/stip/:id/%s with an empty body', async (_name, fn, path) => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await fn('stip-1');
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/pd/stip/stip-1/${path}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('recordEAMSFiled PATCHes the filed date', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ filed: true }));
    await recordEAMSFiled('stip-1', '2026-06-09');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/pd/stip/stip-1/eams-filed', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedDate: '2026-06-09' }),
    });
  });

  it('fetchPDData GETs /pd/claim/:claimId with credentials: include', async () => {
    const data = { evaluations: [], advances: [], stips: [] };
    fetchMock.mockResolvedValueOnce(jsonRes(data));
    await expect(fetchPDData('WC-7')).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/pd/claim/WC-7', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('throws body.error on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'PR-4 not found' }, false, 404));
    await expect(calculatePD('WC-7', 'missing', 0)).rejects.toThrow('PR-4 not found');
  });

  it('falls back to "HTTP <status>" when the error body is unparseable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    });
    await expect(fetchPDData('WC-7')).rejects.toThrow('HTTP 502');
  });
});
