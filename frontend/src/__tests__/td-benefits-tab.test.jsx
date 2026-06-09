/**
 * Benefits tab — TD period API layer tests.
 *
 * The TD components (TdSummaryCard / TdTimeline / TdPeriodsTable /
 * StartTdModal) live inside App.jsx and are not exported, so the
 * remaining UI checks from the original manual checklist (modal
 * defaults, auto-close warning banner) stay manual for now. What IS
 * exported — and what every one of those components feeds from — is the
 * TD period API layer (fetchTdPeriods / fetchTdSummary / createTdPeriod /
 * closeTdPeriod / reinstateTdPeriod), tested here with a mocked fetch:
 *
 *   - correct URL / method / credentials: 'include' on every call
 *   - JSON body + Content-Type header on writes (start / close / reinstate)
 *   - empty-state contract: no td_periods → [] (drives "None Active" /
 *     "0 weeks paid" / "0 / 104" + the empty-state placeholder)
 *   - error propagation: non-ok responses throw body.error or HTTP <status>
 */
import { vi } from 'vitest';
import {
  fetchTdPeriods,
  fetchTdSummary,
  createTdPeriod,
  closeTdPeriod,
  reinstateTdPeriod,
} from '../App.jsx';

function jsonRes(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TD period API helpers (Benefits tab data layer)', () => {
  it('fetchTdPeriods GETs /claims/:id/td-periods with credentials and unwraps periods', async () => {
    const periods = [{ id: 'p1', td_type: 'TTD', start_date: '2026-01-05' }];
    fetchMock.mockResolvedValueOnce(jsonRes({ periods }));

    await expect(fetchTdPeriods('claim-123')).resolves.toEqual(periods);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/claims/claim-123/td-periods',
      { method: 'GET', credentials: 'include' }
    );
  });

  it('fetchTdPeriods returns [] when the claim has no td_periods (empty Benefits tab state)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}));
    await expect(fetchTdPeriods('claim-123')).resolves.toEqual([]);
  });

  it('fetchTdSummary GETs /claims/:id/td-summary and returns the summary object', async () => {
    const summary = { active_period: null, weeks_paid: 0, cap_weeks: 104 };
    fetchMock.mockResolvedValueOnce(jsonRes(summary));

    await expect(fetchTdSummary('claim-9')).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/claims/claim-9/td-summary',
      { method: 'GET', credentials: 'include' }
    );
  });

  it('createTdPeriod POSTs a JSON body ("Start TD Period" modal submit)', async () => {
    const body = { td_type: 'TTD', start_date: '2026-06-09', weekly_rate: 500.5 };
    fetchMock.mockResolvedValueOnce(jsonRes({ period: { id: 'p2', ...body } }));

    const out = await createTdPeriod('claim-123', body);
    expect(out.period.id).toBe('p2');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/claims/claim-123/td-periods',
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
  });

  it('closeTdPeriod PATCHes /td-periods/:id/close with the end date', async () => {
    const body = { end_date: '2026-06-08', end_reason: 'rtw_full_duty' };
    fetchMock.mockResolvedValueOnce(jsonRes({ period: { id: 'p1', ...body } }));

    await closeTdPeriod('p1', body);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/td-periods/p1/close', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  });

  it('reinstateTdPeriod PATCHes /td-periods/:id/reinstate', async () => {
    const body = { start_date: '2026-06-10' };
    fetchMock.mockResolvedValueOnce(jsonRes({ period: { id: 'p3' } }));

    await reinstateTdPeriod('p1', body);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/td-periods/p1/reinstate', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  });

  it('throws the backend error message on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'overlapping TD period' }, false, 422)
    );
    await expect(createTdPeriod('claim-123', {})).rejects.toThrow(
      'overlapping TD period'
    );
  });

  it('falls back to "HTTP <status>" when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(fetchTdSummary('claim-123')).rejects.toThrow('HTTP 500');
  });
});
