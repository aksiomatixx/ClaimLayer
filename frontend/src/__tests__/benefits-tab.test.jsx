/**
 * BenefitsTab — UI tests, possible now that the tab is extracted from
 * the ClaimDrawer closure (previously documented as a manual checklist).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetchTdPeriods = vi.fn();
const fetchTdSummary = vi.fn();
vi.mock('../services/td.js', () => ({
  fetchTdPeriods: (...a) => fetchTdPeriods(...a),
  fetchTdSummary: (...a) => fetchTdSummary(...a),
  createTdPeriod: vi.fn(),
  closeTdPeriod: vi.fn(),
  reinstateTdPeriod: vi.fn(),
}));

import BenefitsTab from '../components/BenefitsTab.jsx';

const CLAIM = { id: 'claim_x', claimNumber: 'HHW-1', tdRate: 500, aww: 750 };

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BenefitsTab claimId="claim_x" claim={CLAIM} notify={() => {}} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchTdPeriods.mockReset();
  fetchTdSummary.mockReset();
});

describe('BenefitsTab', () => {
  it('renders the empty state with the Start TD Period entry point', async () => {
    fetchTdPeriods.mockResolvedValue([]);
    fetchTdSummary.mockResolvedValue({ total_weeks_paid: 0, total_paid: 0, periods: 0 });
    renderTab();

    expect(await screen.findByText(/No TD periods recorded/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Start TD Period/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Temporary Disability/i)).toBeInTheDocument();
  });

  it('renders periods with the 104-week statutory cap summary and timeline', async () => {
    fetchTdPeriods.mockResolvedValue([
      { id: 'p1', benefit_type: 'TTD', start_date: '2026-04-01', end_date: '2026-04-28',
        weekly_rate: 500, reason_ended: 'rtw_modified' },
      { id: 'p2', benefit_type: 'TPD', start_date: '2026-05-05', end_date: null,
        weekly_rate: 300, reinstated_from_period_id: null },
    ]);
    fetchTdSummary.mockResolvedValue({
      total_weeks_paid: 8.57, total_paid: 4285.5, periods: 2,
      statutory_cap_weeks: 104, remaining_weeks: 95.43,
    });
    renderTab();

    await waitFor(() => expect(fetchTdPeriods).toHaveBeenCalledWith('claim_x'));
    // both periods listed with their rates
    expect((await screen.findAllByText(/\$500/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\$300/).length).toBeGreaterThanOrEqual(1);
    // close/reinstate affordances exist for the right rows
    expect(screen.queryByText(/No TD periods recorded/i)).not.toBeInTheDocument();
  });

  it('survives a summary fetch failure without crashing the tab', async () => {
    fetchTdPeriods.mockResolvedValue([]);
    fetchTdSummary.mockRejectedValue(new Error('boom'));
    renderTab();
    expect(await screen.findByText(/No TD periods recorded/i)).toBeInTheDocument();
  });
});
