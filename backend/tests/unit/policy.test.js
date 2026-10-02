'use strict';

/**
 * Unit tests — action registry and authority policy (ADR-0004).
 *
 * The registry tests are deliberately strict: relaxing an action's agent
 * autonomy must fail a test and be a conscious, reviewed change.
 *
 * Run: npm test -- tests/unit/policy.test.js
 */

const { AUTONOMY, ACTIONS, getAction, catalog } = require('../../src/policy/actionRegistry');
const {
  evaluateAuthority, claimContext, normalizeRole, DEFAULT_AUTHORITY_POLICY,
} = require('../../src/policy/authorityPolicy');
const { humanPrincipal, agentPrincipal } = require('../../src/policy/principal');

const person = (role, extra = {}) => humanPrincipal({ email: `${role}@tpa.test`, role, ...extra });

describe('action registry — agent autonomy tiers', () => {
  test('every action declares a valid autonomy tier', () => {
    for (const a of Object.values(ACTIONS)) {
      expect(Object.values(AUTONOMY)).toContain(a.agentAutonomy);
    }
  });

  test.each([
    'claim.compensability.deny', 'medical.rfa.deny_or_modify', 'settlement.authority',
    'settlement.offer', 'litigation.filing', 'siu.referral', 'claim.reopen',
  ])('%s is analyze-only for agents (human-originated)', (id) => {
    expect(getAction(id).agentAutonomy).toBe(AUTONOMY.ANALYZE_ONLY);
  });

  test.each([
    'reserve.change', 'payment.issue', 'medical.rfa.approve', 'claim.compensability.accept',
    'claim.compensability.delay', 'benefit.td.start', 'benefit.td.stop', 'notice.send',
  ])('%s requires human approval when an agent proposes it', (id) => {
    expect(getAction(id).agentAutonomy).toBe(AUTONOMY.PREPARE_FOR_APPROVAL);
  });

  test('no financial action is ever autonomous for an agent', () => {
    const autonomousFinancial = Object.values(ACTIONS)
      .filter(a => a.financial && a.agentAutonomy === AUTONOMY.AUTONOMOUS);
    expect(autonomousFinancial).toEqual([]);
  });

  test('approving reserve changes and payments requires an MFA-elevated session', () => {
    expect(getAction('reserve.change').requiresMfa).toBe(true);
    expect(getAction('payment.issue').requiresMfa).toBe(true);
  });

  test('the registry cannot be mutated at runtime', () => {
    expect(Object.isFrozen(ACTIONS)).toBe(true);
    expect(Object.isFrozen(getAction('reserve.change'))).toBe(true);
    expect(() => { 'use strict'; ACTIONS['reserve.change'].agentAutonomy = AUTONOMY.AUTONOMOUS; }).toThrow();
  });

  test('unknown and prototype-chain lookups return null', () => {
    expect(getAction('claim.delete_everything')).toBeNull();
    expect(getAction('toString')).toBeNull();
    expect(getAction('__proto__')).toBeNull();
  });

  test('catalog exposes data only (no functions)', () => {
    const entry = catalog().find(a => a.id === 'reserve.change');
    expect(entry).toEqual({
      id: 'reserve.change', domain: 'financial', description: expect.any(String),
      agent_autonomy: 'prepare_for_approval', financial: true, requires_mfa: true,
    });
  });
});

describe('reserve.change payload validation', () => {
  const validate = (p) => getAction('reserve.change').validate(p);
  const ok = { medical_cents: 500000, indemnity_cents: 300000, expense_cents: 50000, reason: 'Worksheet v2' };

  test('accepts integer cents and normalizes the reason', () => {
    expect(validate({ ...ok, reason: '  Worksheet v2  ', extra: 'dropped' })).toEqual(ok);
  });

  test.each([
    ['fractional cents', { medical_cents: 100.5 }],
    ['negative amounts', { indemnity_cents: -1 }],
    ['dollar strings', { expense_cents: '500.00' }],
    ['missing bucket', { medical_cents: undefined }],
    ['implausible magnitude (unit error)', { medical_cents: 10_000_000_001 }],
    ['missing reason', { reason: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => validate({ ...ok, ...patch })).toThrow();
  });

  test('authority is measured on the resulting total reserve', () => {
    expect(getAction('reserve.change').amountCents(ok)).toBe(850000);
  });
});

describe('authority policy', () => {
  const evalReserve = (principal, amountCents, context = {}, extra = {}) =>
    evaluateAuthority({ actionId: 'reserve.change', principal, amountCents, context, ...extra });

  test('an adjuster acts within their own limit', () => {
    const r = evalReserve(person('adjuster'), 5_000_000);
    expect(r).toMatchObject({ withinAuthority: true, requiredRole: 'adjuster', actorLimitCents: 5_000_000 });
  });

  test('one cent over the adjuster limit requires a supervisor', () => {
    const r = evalReserve(person('adjuster'), 5_000_001);
    expect(r.withinAuthority).toBe(false);
    expect(r.requiredRole).toBe('supervisor');
    expect(r.reasons.join(' ')).toMatch(/exceeds adjuster limit/);
    expect(evalReserve(person('supervisor', { mfa: true }), 5_000_001).withinAuthority).toBe(true);
  });

  test('an amount above every limit has no required role (out of policy)', () => {
    const r = evalReserve(person('claims_manager'), 100_000_001);
    expect(r.withinAuthority).toBe(false);
    expect(r.requiredRole).toBeNull();
    expect(r.reasons.join(' ')).toMatch(/out-of-policy/);
  });

  test('litigation raises the floor to supervisor even for small amounts', () => {
    const r = evalReserve(person('adjuster'), 100_00, { litigated: true });
    expect(r.withinAuthority).toBe(false);
    expect(r.requiredRole).toBe('supervisor');
    expect(r.reasons.join(' ')).toMatch(/litigated_claim/);
  });

  test('representation requires a claims manager for settlement authority', () => {
    const r = evaluateAuthority({
      actionId: 'settlement.authority', principal: person('supervisor'), amountCents: 1_000_000,
      context: { represented: true },
    });
    expect(r.withinAuthority).toBe(false);
    expect(r.requiredRole).toBe('claims_manager');
  });

  test('an SIU risk flag escalates payments', () => {
    const r = evaluateAuthority({
      actionId: 'payment.issue', principal: person('adjuster'), amountCents: 10_000,
      context: { riskFlags: ['siu_referral'] },
    });
    expect(r.requiredRole).toBe('supervisor');
  });

  test('client overrides can tighten limits but never loosen them', () => {
    const policy = {
      ...DEFAULT_AUTHORITY_POLICY,
      clientOverrides: {
        'client-strict': { limits: { 'reserve.change': { adjuster: 2_500_000 } } },
        'client-loose':  { limits: { 'reserve.change': { adjuster: 99_000_000 } } },
      },
    };
    expect(evalReserve(person('adjuster'), 3_000_000, {}, { policy, clientId: 'client-strict' }).withinAuthority).toBe(false);
    expect(evalReserve(person('adjuster'), 6_000_000, {}, { policy, clientId: 'client-loose' }).withinAuthority).toBe(false);
    expect(evalReserve(person('adjuster'), 3_000_000, {}, { policy, clientId: 'unknown-client' }).withinAuthority).toBe(true);
  });

  test('an agent never holds authority, whatever the amount', () => {
    const r = evalReserve(agentPrincipal('reserve_analysis'), 1);
    expect(r.withinAuthority).toBe(false);
    expect(r.reasons).toContain('only a human may hold approval authority');
  });

  test('roles without claims authority (employer, employee, unknown) hold none', () => {
    for (const role of ['employer', 'employee', 'auditor', null]) {
      expect(evalReserve(person(role || 'nobody'), 1).withinAuthority).toBe(false);
    }
  });

  test('legacy admin carries claims-manager authority until roles are split (S-4)', () => {
    expect(normalizeRole('admin')).toBe('claims_manager');
    expect(evalReserve(person('admin'), 100_000_000).withinAuthority).toBe(true);
  });

  test('non-monetary actions use the minimum role', () => {
    const r = evaluateAuthority({ actionId: 'claim.close', principal: person('adjuster'), amountCents: null });
    expect(r).toMatchObject({ withinAuthority: false, requiredRole: 'supervisor', amountCents: null });
  });

  test('a monetary action without an amount is a programming error', () => {
    expect(() => evalReserve(person('adjuster'), null)).toThrow(/requires amountCents/);
    expect(() => evalReserve(person('adjuster'), 10.5)).toThrow(/requires amountCents/);
  });

  test('evaluation is deterministic and records the policy version', () => {
    const a = evalReserve(person('adjuster'), 7_000_000, { litigated: true });
    const b = evalReserve(person('adjuster'), 7_000_000, { litigated: true });
    expect(a).toEqual(b);
    expect(a.policyVersion).toBe(DEFAULT_AUTHORITY_POLICY.version);
  });
});

describe('claimContext', () => {
  test('derives litigation and representation from the claim', () => {
    expect(claimContext({ status: 'litigated', attorney_represented: true }))
      .toEqual({ litigated: true, represented: true, riskFlags: [] });
    expect(claimContext({ status: 'accepted', attorneyName: 'J. Doe' }).represented).toBe(true);
    expect(claimContext(null)).toEqual({ litigated: false, represented: false, riskFlags: [] });
  });
});
