/**
 * ReservesTab (CL-RSV1) — the itemized reserve worksheet UI: groups,
 * line items with qty × unit and basis notes, subtotals, grand total,
 * and the approval-status panel that routes through the M3 workflow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetchReserveWorksheet = vi.fn();
const approveReserves = vi.fn();
vi.mock('../services/claims.js', () => ({
  fetchReserveWorksheet: (...a) => fetchReserveWorksheet(...a),
  approveReserves: (...a) => approveReserves(...a),
}));

import ReservesTab from '../components/ReservesTab.jsx';

const WORKSHEET = {
  claim_id: 'claim_demo_003',
  items: {
    medical: [
      { id: 'rli1', category: 'medical', label: 'PTP office visits', shape: 'quantity', quantity: 5, unit_amount: 250, total: 1250, basis_note: 'PTP visits per PR-1 treatment plan (synthetic demo estimate)' },
      { id: 'rli2', category: 'medical', label: 'MRI — right shoulder', shape: 'quantity', quantity: 1, unit_amount: 1400, total: 1400, basis_note: null },
    ],
    indemnity: [
      { id: 'rli3', category: 'indemnity', label: 'Temporary disability', shape: 'weeks_rate', quantity: 6, unit_amount: 414, total: 2484, basis_note: 'Estimated 6 weeks TD at the claim TD rate' },
      { id: 'rli4', category: 'indemnity', label: 'Estimated permanent disability', shape: 'flat', flat_amount: 7500, total: 7500, basis_note: 'SYNTHETIC DEMO ESTIMATE' },
    ],
    expense: [
      { id: 'rli5', category: 'expense', label: 'Copy service / record retrieval', shape: 'quantity', quantity: 2, unit_amount: 85, total: 170, basis_note: null },
    ],
  },
  subtotals: { medical: 2650, indemnity: 9984, expense: 170 },
  grand_total: 12804,
  approved_reserves: { medical: 25000, indemnity: 18000, expense: 4500, approved_by: 'adjuster@test', approved_at: '2026-06-01', reason: 'initial' },
  proposal: { status: 'pending_approval', medical: 2650, indemnity: 9984, expense: 170, reason: 'Itemized reserve worksheet rollup' },
};

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReservesTab claimId="claim_demo_003" notify={() => {}} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchReserveWorksheet.mockReset().mockResolvedValue(WORKSHEET);
  approveReserves.mockReset().mockResolvedValue({});
});

describe('ReservesTab', () => {
  it('renders categories, line items with qty × unit shapes, and basis notes', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('PTP office visits')).toBeInTheDocument());

    expect(screen.getByText('Medical')).toBeInTheDocument();
    expect(screen.getByText('Indemnity')).toBeInTheDocument();
    expect(screen.getByText('Expense')).toBeInTheDocument();

    expect(screen.getByText('5 × $250')).toBeInTheDocument();          // quantity shape
    expect(screen.getByText('6 wks × $414')).toBeInTheDocument();      // weeks × rate shape
    expect(screen.getByText('flat')).toBeInTheDocument();              // flat shape
    expect(screen.getByText(/PR-1 treatment plan/)).toBeInTheDocument();
    expect(screen.getByText(/SYNTHETIC DEMO ESTIMATE/)).toBeInTheDocument();
  });

  it('shows category subtotals and the grand total', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('grand-total')).toHaveTextContent('$12,804'));
    expect(screen.getByTestId('subtotal-medical')).toHaveTextContent('$2,650');
    expect(screen.getByTestId('subtotal-indemnity')).toHaveTextContent('$9,984');
    expect(screen.getByTestId('subtotal-expense')).toHaveTextContent('$170');
  });

  it('a pending proposal routes through the M3 approval (approveReserves) — never a direct write', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText(/pending adjuster approval/i)).toBeInTheDocument());

    screen.getByText('Approve worksheet totals as reserves').click();
    await waitFor(() => expect(approveReserves).toHaveBeenCalledTimes(1));
    const [claimId, payload] = approveReserves.mock.calls[0];
    expect(claimId).toBe('claim_demo_003');
    expect(payload).toEqual({ medical: 2650, indemnity: 9984, expense: 170, reason: 'Itemized reserve worksheet rollup' });
  });

  it('an approved worksheet shows the matched state with no approve button', async () => {
    fetchReserveWorksheet.mockResolvedValue({
      ...WORKSHEET,
      approved_reserves: { medical: 2650, indemnity: 9984, expense: 170, approved_by: 'adjuster@test' },
      proposal: { ...WORKSHEET.proposal, status: 'approved' },
    });
    renderTab();
    await waitFor(() => expect(screen.getByText(/reserves match the worksheet/i)).toBeInTheDocument());
    expect(screen.queryByText('Approve worksheet totals as reserves')).toBeNull();
  });
});
