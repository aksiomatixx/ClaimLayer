'use strict';

/**
 * Unit tests — aiService audit-logging contract.
 *
 * Verifies that every public AI service function calls
 * aiDecisionsService.logDecision exactly once after a successful
 * Claude call, and that:
 *   - guardrail_actions captures the no_auto_deny rule for evaluateRFA
 *     (triggered:true when AI returns an unexpected denial; triggered:
 *     false otherwise).
 *   - logDecision insert failures DO NOT break the AI return value.
 */

// config caches the Anthropic key at module-load time, so set it
// BEFORE requiring aiService (which requires config).
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

// Mock the Anthropic SDK so we don't hit the network.
const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

const aiService = require('../../src/services/aiService');
const aid       = require('../../src/services/aiDecisionsService');
const { supabase } = require('../../src/services/supabase');

beforeEach(() => {
  mockMessagesCreate.mockReset();
  supabase._resetStore();
});

function mockClaudeResponse(body) {
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(body) }],
    usage: { input_tokens: 800, output_tokens: 600 },
  });
}

const baseClaim = {
  id: 'claim_test', claimNumber: 'HHW-TEST', dateOfInjury: '2025-06-15',
  bodyPart: 'Knee', injuryType: 'Slip & Fall', injuryDescription: 'fell',
  employee: { jobTitle: 'HHA' }, aww: 750, tdRate: 500,
};

describe('analyzeCompensability', () => {
  it('logs a compensability ai_decisions row after success', async () => {
    mockClaudeResponse({
      compensability: 'Likely Compensable', compensabilityScore: 88, priority: 'Medium',
      suggestedMedicalReserve: 25000, suggestedIndemnityReserve: 18000, suggestedExpenseReserve: 4500,
    });
    await aiService.analyzeCompensability(baseClaim);
    const { data: rows } = await supabase.from('ai_decisions').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].decision_type).toBe('compensability');
    expect(rows[0].prompt_name).toBe('compensability_analysis');
    expect(rows[0].confidence).toBe(88);
    expect(rows[0].input_tokens).toBe(800);
    expect(rows[0].output_tokens).toBe(600);
    expect(rows[0].guardrail_actions).toEqual([]);
  });

  it('still returns the AI result when logDecision insert fails', async () => {
    mockClaudeResponse({
      compensability: 'Likely Compensable', compensabilityScore: 88, priority: 'Medium',
      suggestedMedicalReserve: 25000, suggestedIndemnityReserve: 18000, suggestedExpenseReserve: 4500,
    });
    const spy = jest.spyOn(aid, 'logDecision').mockRejectedValue(new Error('boom'));
    const result = await aiService.analyzeCompensability(baseClaim);
    expect(result.compensability).toBe('Likely Compensable');
    spy.mockRestore();
  });
});

describe('evaluateRFA — guardrail capture', () => {
  it('emits no_auto_deny rule with triggered:false on a clean auto_approve', async () => {
    mockClaudeResponse({ recommendedAction: 'auto_approve', confidence: 90 });
    await aiService.evaluateRFA(
      { acceptedDiagnosis: 'low back', requestedTreatment: 'PT', requestedCptCodes: ['97110'], rfaReceivedDate: '2025-07-01' },
      baseClaim,
    );
    const { data: rows } = await supabase.from('ai_decisions').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].decision_type).toBe('rfa_mtus');
    expect(rows[0].guardrail_actions[0]).toEqual({ rule: 'no_auto_deny', triggered: false });
  });

  it('emits no_auto_deny rule with triggered:true and forced_to:physician_review when AI returns a denial', async () => {
    mockClaudeResponse({ recommendedAction: 'denied', confidence: 70 });
    const result = await aiService.evaluateRFA(
      { acceptedDiagnosis: 'low back', requestedTreatment: 'PT', requestedCptCodes: ['97110'], rfaReceivedDate: '2025-07-01' },
      baseClaim,
    );
    // The AI's "denied" must be collapsed by the guard
    expect(result.recommendedAction).toBe('physician_review');
    const { data: rows } = await supabase.from('ai_decisions').select('*');
    const guardrails = rows[0].guardrail_actions;
    expect(guardrails[0]).toEqual({
      rule: 'no_auto_deny', triggered: true, original: 'denied', forced_to: 'physician_review',
    });
  });
});
