'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const staffingService = require('../../src/services/staffingService');
const { supabase } = require('../../src/services/supabase');

describe('staffingService (Phase 2)', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    const mock = require('../__mocks__/supabaseClient');
    if (mock._reset) mock._reset();
  });

  test('creates staffing agency, host employer client, and assignment', async () => {
    const agency = await staffingService.createAgency({
      tenantId,
      name: 'Apex Staffing Solutions',
      fein: '94-1234567',
      contactEmail: 'risk@apexstaffing.com',
    });

    expect(agency.id).toBeDefined();
    expect(agency.name).toBe('Apex Staffing Solutions');

    const hostEmployer = await staffingService.createHostEmployer({
      tenantId,
      agencyId: agency.id,
      name: 'BrightCare Logistics Facility 4',
      industryNaics: '493110',
      city: 'Ontario',
      state: 'CA',
    });

    expect(hostEmployer.id).toBeDefined();
    expect(hostEmployer.agency_id).toBe(agency.id);

    const assignment = await staffingService.createAssignment({
      tenantId,
      agencyId: agency.id,
      hostEmployerId: hostEmployer.id,
      employeeId: 'emp-001',
      jobTitle: 'Forklift Operator',
      classCode: '7219',
      hourlyWage: 22.50,
      startDate: '2026-01-15',
    });

    expect(assignment.id).toBeDefined();
    expect(assignment.hourly_wage).toBe(22.50);
  });

  test('adds claim body part and updates compensability', async () => {
    const bp = await staffingService.addClaimBodyPart({
      tenantId,
      claimId: 'claim-bp-test-01',
      bodyPartCode: '30_lumbar_spine',
      bodyPartName: 'Lumbar Spine',
      side: 'na',
    });

    expect(bp.compensability_status).toBe('pending_investigation');

    const accepted = await staffingService.updateBodyPartCompensability(bp.id, 'accepted', {
      actor: { id: 'adjuster@test.com', role: 'adjuster' },
    });

    expect(accepted.compensability_status).toBe('accepted');
    expect(accepted.accepted_at).toBeDefined();
  });
});
