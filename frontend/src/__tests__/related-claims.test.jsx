/**
 * RelatedClaims (CL-DEMO2) — linked claims render as clickable rows
 * carrying the linked claim's facts and navigating to its drawer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetchClaimLinks = vi.fn();
vi.mock('../services/claims.js', () => ({
  fetchClaimLinks: (...a) => fetchClaimLinks(...a),
}));

import RelatedClaims from '../components/RelatedClaims.jsx';

const LINKS = [{
  link_id: 'clk1',
  relation_type: 'prior_claim_same_worker',
  note: 'Same worker (DEMO-3). Compare PR-1 findings.',
  linked_claim: {
    id: 'claim_demo_009', claim_number: 'HHW-2024-D09',
    date_of_injury: '2024-03-12', body_part: 'Shoulder', status: 'closed',
  },
}];

function renderSection(onOpenClaim = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RelatedClaims claimId="claim_demo_003" onOpenClaim={onOpenClaim} />
    </QueryClientProvider>
  );
}

beforeEach(() => fetchClaimLinks.mockReset());

describe('RelatedClaims', () => {
  it('renders the linked claim with number, relation, body part, DOI, and status', async () => {
    fetchClaimLinks.mockResolvedValue(LINKS);
    renderSection();
    await waitFor(() => expect(screen.getByText('HHW-2024-D09')).toBeInTheDocument());
    expect(screen.getByText(/Prior claim — same worker/)).toBeInTheDocument();
    expect(screen.getByText(/Shoulder/)).toBeInTheDocument();
    expect(screen.getByText(/DOI 2024-03-12/)).toBeInTheDocument();
    expect(screen.getByText('closed')).toBeInTheDocument();
    expect(screen.getByText(/Compare PR-1 findings/)).toBeInTheDocument();
  });

  it('clicking a row navigates to the linked claim\'s drawer', async () => {
    fetchClaimLinks.mockResolvedValue(LINKS);
    const onOpenClaim = vi.fn();
    renderSection(onOpenClaim);
    await waitFor(() => expect(screen.getByTestId('related-claim-claim_demo_009')).toBeInTheDocument());

    screen.getByTestId('related-claim-claim_demo_009').click();
    expect(onOpenClaim).toHaveBeenCalledWith('claim_demo_009');
  });

  it('renders nothing when the claim has no links', async () => {
    fetchClaimLinks.mockResolvedValue([]);
    const { container } = renderSection();
    await waitFor(() => expect(fetchClaimLinks).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Related Claims')).toBeNull();
  });
});
