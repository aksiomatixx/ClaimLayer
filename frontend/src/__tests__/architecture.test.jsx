/**
 * Architecture page smoke tests.
 *
 * Covers the (previously manual) release checklist:
 *   - header renders headline sentence + "Download as PDF" button
 *   - lifecycle SVG renders all 11 status boxes (new_claim … closed)
 *   - Agent Registry shows 5 cards with live "30d" decision counts
 *     (from the mocked /api/v1/ai-decisions/stats fetcher) and override %
 *   - "View prompt →" opens a modal with the prompt text loaded from
 *     the mocked /api/v1/prompts/:name fetcher
 *   - Guardrail Catalog shows ≥12 rows (Rule / Where / Why columns)
 *   - Human-in-the-Loop Checkpoints shows ≥9 rows
 *   - Regulatory Data Sources reads docs/regulatory/sources.json and
 *     renders ≥12 rows
 *   - each section's chevron toggles open/closed when clicked
 *   - "Download as PDF" fires window.print()
 *
 * The live-data fetchers (fetchAiDecisionStats / fetchAiDecisions /
 * fetchPromptText) are exported from App.jsx; they are mocked here so the
 * page renders without a backend and without pulling the whole App bundle.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import sourcesJson from '../../../docs/regulatory/sources.json';

const mockStats = {
  window_days: 30,
  by_type: {
    compensability: 42,
    rfa_mtus: 17,
    cnr_pricing: 5,
    msa_screening: 9,
    voice_extract: 11,
  },
};

// 4 compensability decisions, 1 overridden → auto 75% / overridden 25%
const mockFeed = {
  rows: [
    { id: 1, decision_type: 'compensability', human_decision: null },
    { id: 2, decision_type: 'compensability', human_decision: null },
    { id: 3, decision_type: 'compensability', human_decision: 'denied' },
    { id: 4, decision_type: 'compensability', human_decision: null },
  ],
};

const fetchAiDecisionStats = vi.fn(async () => mockStats);
const fetchAiDecisions = vi.fn(async () => mockFeed);
const fetchPromptText = vi.fn(async (name) => ({
  name,
  text: 'You are a California workers compensation compensability analyst…',
}));

vi.mock('../services/aiDecisions.js', () => ({
  fetchAiDecisionStats: (...a) => fetchAiDecisionStats(...a),
  fetchAiDecisions: (...a) => fetchAiDecisions(...a),
  fetchPromptText: (...a) => fetchPromptText(...a),
}));

import Architecture from '../Architecture.jsx';

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Architecture />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.print = vi.fn();
});

describe('Architecture page', () => {
  it('renders the page header with headline and Download as PDF button', () => {
    renderPage();
    expect(screen.getByText('System Architecture')).toBeInTheDocument();
    expect(
      screen.getByText(/AI-augmented California workers' compensation TPA/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Download as PDF/ })
    ).toBeInTheDocument();
  });

  it('fires window.print() when Download as PDF is clicked', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Download as PDF/ }));
    expect(window.print).toHaveBeenCalledTimes(1);
  });

  it('renders the lifecycle diagram with all 11 statuses', () => {
    renderPage();
    for (const status of [
      'new_claim', 'intake_complete', 'under_investigation', 'accepted',
      'active_medical', 'p_and_s', 'pd_evaluation', 'settlement_discussions',
      'litigated', 'denied', 'closed',
    ]) {
      expect(screen.getByText(status)).toBeInTheDocument();
    }
    // automation-kind legend
    expect(screen.getByText('AI-assisted')).toBeInTheDocument();
    expect(screen.getByText('Human-required')).toBeInTheDocument();
    expect(screen.getByText('Mechanical (no AI)')).toBeInTheDocument();
  });

  it('renders 6 agent registry cards', () => {
    renderPage();
    expect(screen.getByText('Agent Registry (6)')).toBeInTheDocument();
    for (const name of [
      'Compensability Analyst',
      'RFA / MTUS Evaluator',
      'C&R Pricing Engine',
      'MSA Screening Gate',
      'Voice Intake Extractor',
      'Document Classifier',
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('shows live 30d decision counts and override % from the stats endpoints', async () => {
    renderPage();
    // Pill on the Compensability Analyst card: "42 · 30d"
    expect(await screen.findByText('42 · 30d')).toBeInTheDocument();
    expect(await screen.findByText('17 · 30d')).toBeInTheDocument();
    expect(fetchAiDecisionStats).toHaveBeenCalledWith(30);
    expect(fetchAiDecisions).toHaveBeenCalledWith({ limit: 200 });
    // 1 of 4 compensability feed rows has a human_decision → 25% overridden / 75% auto
    await waitFor(() => {
      expect(screen.getByText('25%')).toBeInTheDocument();
      expect(screen.getByText('75%')).toBeInTheDocument();
    });
  });

  it('opens the prompt modal with text fetched from /prompts/:name', async () => {
    renderPage();
    // cards render in AGENTS order — the first "View prompt" button belongs
    // to the Compensability Analyst card
    fireEvent.click(screen.getAllByRole('button', { name: /View prompt/ })[0]);
    expect(fetchPromptText).toHaveBeenCalledWith('compensability_analysis');
    expect(
      await screen.findByText(/compensability analyst…/)
    ).toBeInTheDocument();
    expect(
      screen.getByText('compensability_analysis.txt')
    ).toBeInTheDocument();
    // close the modal
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(
      screen.queryByText('compensability_analysis.txt')
    ).not.toBeInTheDocument();
  });

  it('renders the Guardrail Catalog with at least 12 rows', () => {
    renderPage();
    const heading = screen.getByText(/Guardrail Catalog \((\d+)\)/);
    const count = Number(heading.textContent.match(/\((\d+)\)/)[1]);
    expect(count).toBeGreaterThanOrEqual(12);
    expect(
      screen.getByText('No auto-deny path anywhere in the system')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/AI may only return auto_approve or physician_review/)
    ).toBeInTheDocument();
  });

  it('renders Human-in-the-Loop Checkpoints with at least 9 rows', () => {
    renderPage();
    const heading = screen.getByText(/Human-in-the-Loop Checkpoints \((\d+)\)/);
    const count = Number(heading.textContent.match(/\((\d+)\)/)[1]);
    expect(count).toBeGreaterThanOrEqual(9);
    expect(
      screen.getByText('Compensability decision (accepted / denied)')
    ).toBeInTheDocument();
    expect(screen.getByText('EAMS filing')).toBeInTheDocument();
  });

  it('renders Regulatory Data Sources from docs/regulatory/sources.json (≥12 rows)', () => {
    renderPage();
    expect(sourcesJson.sources.length).toBeGreaterThanOrEqual(12);
    expect(
      screen.getByText(`Regulatory Data Sources (${sourcesJson.sources.length})`)
    ).toBeInTheDocument();
    // every source name from the JSON file appears in the table
    for (const s of sourcesJson.sources) {
      expect(screen.getAllByText(s.source).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('toggles a section closed and open via its chevron header', () => {
    renderPage();
    expect(screen.getByText('AI-assisted')).toBeInTheDocument(); // lifecycle legend visible
    const header = screen.getByText('Claim Lifecycle + Agent Touchpoints');
    fireEvent.click(header);
    expect(screen.queryByText('AI-assisted')).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.getByText('AI-assisted')).toBeInTheDocument();
  });
});
