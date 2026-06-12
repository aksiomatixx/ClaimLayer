/**
 * SupervisorAlerts panel (CL-SUP1): the daily digest banner + grouped
 * panel, ack flow, claim-row navigation, and the nothing-rendered
 * states (non-supervisor / no digest).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetchSupervisorAlert = vi.fn();
const acknowledgeSupervisorAlert = vi.fn();
vi.mock('../services/supervisor.js', () => ({
  fetchSupervisorAlert: (...a) => fetchSupervisorAlert(...a),
  acknowledgeSupervisorAlert: (...a) => acknowledgeSupervisorAlert(...a),
}));

import SupervisorAlerts from '../components/SupervisorAlerts.jsx';

const ALERT = {
  id: 'sva_1', alert_date: '2026-06-12',
  due_today_count: 1, overdue_count: 2,
  acknowledged_at: null, acknowledged_by: null,
  payload: {
    due_today: [{ adjuster: 'adjuster@homecaretpa.com', items: [{
      diary_id: 'dA', diary_type: 'TD_PAYMENT_REVIEW', claim_id: 'claim_demo_004',
      claim_number: 'HHW-2026-D04', worker: 'David Park', due_date: '2026-06-12', days_overdue: 0,
    }] }],
    overdue: [
      { adjuster: 'd.park@homecaretpa.com', items: [{
        diary_id: 'dB', diary_type: 'QME_REPORT_REVIEW', claim_id: 'claim_demo_006',
        claim_number: 'HHW-2026-D06', worker: 'Carlos Ruiz', due_date: '2026-06-06', days_overdue: 6,
      }] },
      { adjuster: 'j.lee@homecaretpa.com', items: [{
        diary_id: 'dC', diary_type: 'PR2_FOLLOW_UP', claim_id: 'claim_demo_005',
        claim_number: 'HHW-2026-D05', worker: 'Linda Chen', due_date: '2026-06-09', days_overdue: 3,
      }] },
    ],
  },
};

function renderPanel(onSelect = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SupervisorAlerts onSelect={onSelect} notify={() => {}} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchSupervisorAlert.mockReset();
  acknowledgeSupervisorAlert.mockReset().mockResolvedValue({ ...ALERT, acknowledged_at: 'now' });
});

describe('SupervisorAlerts', () => {
  it('renders the banner counts and the grouped digest', async () => {
    fetchSupervisorAlert.mockResolvedValue(ALERT);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('sup-counts')).toHaveTextContent('1 important due today · 2 overdue'));

    screen.getByText('View').click();
    await waitFor(() => expect(screen.getByText('David Park')).toBeInTheDocument());
    expect(screen.getByText('d.park@homecaretpa.com')).toBeInTheDocument(); // grouped by adjuster
    expect(screen.getByText('6d overdue')).toBeInTheDocument();
    expect(screen.getByText('3d overdue')).toBeInTheDocument();
  });

  it('rows link to the claim drawer', async () => {
    fetchSupervisorAlert.mockResolvedValue(ALERT);
    const onSelect = vi.fn();
    renderPanel(onSelect);
    await waitFor(() => screen.getByText('View'));
    screen.getByText('View').click();
    await waitFor(() => screen.getByTestId('sup-row-dB'));
    screen.getByTestId('sup-row-dB').click();
    expect(onSelect).toHaveBeenCalledWith('claim_demo_006');
  });

  it('acknowledge calls the service and is audited server-side', async () => {
    fetchSupervisorAlert.mockResolvedValue(ALERT);
    renderPanel();
    await waitFor(() => screen.getByText('Acknowledge'));
    screen.getByText('Acknowledge').click();
    await waitFor(() => expect(acknowledgeSupervisorAlert).toHaveBeenCalledWith('sva_1'));
  });

  it('renders nothing for non-supervisors or when no digest exists', async () => {
    fetchSupervisorAlert.mockResolvedValue(null); // 401/403 path returns null
    const { container } = renderPanel();
    await waitFor(() => expect(fetchSupervisorAlert).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });
});
