'use strict';

const simulator = require('../../src/scripts/simulatePortfolio');

describe('simulatePortfolio (Phase 6 — Synthetic Actuarial Simulator)', () => {
  test('generates a single simulated claim with balanced financial ledger', () => {
    const claim = simulator.generateSimulatedClaim(1, 36);

    expect(claim).toBeDefined();
    expect(claim.claimNumber).toBe('CA-2024-00001');
    expect(claim.agency).toBeDefined();
    expect(claim.hostEmployer).toBeDefined();
    expect(claim.bodyPart).toBeDefined();
    expect(claim.tdRate).toBeGreaterThan(0);
    expect(claim.totalIncurred).toBeGreaterThanOrEqual(0);
    expect(claim.totalPaid).toBeGreaterThanOrEqual(0);
    expect(claim.totalReserves).toBeGreaterThanOrEqual(0);

    // Assert double-entry invariant: Incurred == Paid + Reserves
    expect(claim.ledgerBalanced).toBe(true);
  });

  test('runs portfolio simulation across 100 claims and verifies 100% balance integrity', () => {
    const sim = simulator.runPortfolioSimulation(100, 36);

    expect(sim.meta.claim_count).toBe(100);
    expect(sim.actuarial_summary.total_incurred).toBeGreaterThan(0);
    expect(sim.actuarial_summary.total_paid).toBeGreaterThan(0);
    expect(sim.financial_controls_integrity.double_entry_ledger_verified).toBe(true);
    expect(sim.financial_controls_integrity.balance_compliance_rate_pct).toBe(100);
    expect(sim.archetype_breakdown.length).toBe(5);
  });
});
