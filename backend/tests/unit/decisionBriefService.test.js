'use strict';

/**
 * Unit tests — decisionBriefService.
 *
 * The brief must be deterministic, plain-language, and explainable from
 * claim data: every open diary becomes an action with a "why" grounded in
 * the claim; related documents are linked by relevant_to; the summary
 * reflects status, AI assessment, and representation.
 */

const { buildBrief, PLAYBOOK } = require('../../src/services/decisionBriefService');

const baseClaim = {
  id: 'claim_x', status: 'under_investigation',
  dateOfInjury: '2026-05-01', injuryType: 'Slip & Fall', bodyPart: 'Knee',
  employee: { firstName: 'Rosa', lastName: 'Mendez' },
  tdRate: 500,
  aiAnalysis: { compensability: 'Likely Compensable', compensabilityScore: 82, priority: 'High' },
};

const diary = (type, due, extra = {}) => ({
  id: `diy_${type}`, diary_type: type, due_date: due, priority: 'HIGH', status: 'open', ...extra,
});

describe('buildBrief', () => {
  it('maps known diary types through the plain-language playbook', () => {
    const brief = buildBrief({
      claim: baseClaim,
      diaries: [diary('COMPENSABILITY_DECISION_DUE', '2026-07-01')],
    });
    expect(brief.actions).toHaveLength(1);
    expect(brief.actions[0].action).toBe(PLAYBOOK.COMPENSABILITY_DECISION_DUE.action);
    expect(brief.actions[0].why).toContain('LC §5402');
    expect(brief.actions[0].why).toContain('Likely Compensable');
    expect(brief.actions[0].why).toContain('82');
    expect(brief.actions[0].due_date).toBe('2026-07-01');
  });

  it('falls back to humanized type + diary notes for unknown types', () => {
    const brief = buildBrief({
      claim: baseClaim,
      diaries: [diary('SOME_NEW_THING', '2026-07-02', { notes: 'custom note' })],
    });
    expect(brief.actions[0].action).toBe('Some new thing');
    expect(brief.actions[0].why).toBe('custom note');
  });

  it('sorts actions by due date and excludes closed diaries', () => {
    const brief = buildBrief({
      claim: baseClaim,
      diaries: [
        diary('DWC7_NOTICE', '2026-07-09'),
        diary('DWC1_ISSUE', '2026-07-03'),
        diary('TD_PAYMENT_REVIEW', '2026-06-01', { status: 'completed' }),
      ],
    });
    expect(brief.actions.map(a => a.diary_id)).toEqual(['diy_DWC1_ISSUE', 'diy_DWC7_NOTICE']);
  });

  it('links documents to actions via relevant_to', () => {
    const brief = buildBrief({
      claim: baseClaim,
      diaries: [diary('COMPENSABILITY_DECISION_DUE', '2026-07-01')],
      documents: [
        { id: 'doc_a', relevant_to: ['COMPENSABILITY_DECISION_DUE'] },
        { id: 'doc_b', relevant_to: ['TD_PAYMENT_REVIEW'] },
        { id: 'doc_c', relevant_to: 'COMPENSABILITY_DECISION_DUE' },
      ],
    });
    expect(brief.actions[0].document_ids).toEqual(['doc_a', 'doc_c']);
  });

  it('summary covers worker, status, AI assessment, and queue size', () => {
    const brief = buildBrief({
      claim: baseClaim,
      diaries: [diary('COMPENSABILITY_DECISION_DUE', '2026-07-01')],
    });
    expect(brief.summary).toContain('Rosa Mendez');
    expect(brief.summary).toContain('under investigation');
    expect(brief.summary).toContain('Likely Compensable');
    expect(brief.summary).toContain('1 action is queued');
  });

  it('notes representation and routes settlement language through the attorney', () => {
    const brief = buildBrief({
      claim: { ...baseClaim, status: 'settlement_discussions', attorney_represented: true },
      diaries: [diary('CNR_OFFER_FOLLOWUP', '2026-07-01')],
    });
    expect(brief.summary).toContain('represented');
    expect(brief.actions[0].why).toContain('attorney');
  });

  it('states the operating contract and handles an empty queue', () => {
    const brief = buildBrief({ claim: baseClaim, diaries: [] });
    expect(brief.contract).toMatch(/timelines are met/i);
    expect(brief.summary).toContain('Nothing is queued');
    expect(brief.actions).toEqual([]);
  });
});
