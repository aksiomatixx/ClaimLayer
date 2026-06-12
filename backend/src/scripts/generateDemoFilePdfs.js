'use strict';

/**
 * generateDemoFilePdfs.js — build the static "Open original" PDFs for
 * the website's interactive demo.
 *
 * The static demo serves each claim document at files/<doc_id>.pdf
 * (services/claims.js documentFileUrl under VITE_DEMO). This script
 * seeds the demo book into the in-memory test DB, then renders one PDF
 * per seeded claim document — title, claimant block, and a narrative
 * consistent with the document's AI summary — into
 * frontend/public-demo/files/ (vite's publicDir for the demo build).
 *
 * Run alongside captureDemoFixtures.js whenever the demo seed changes:
 *   node backend/src/scripts/generateDemoFilePdfs.js
 *
 * All content is synthetic; no statutory values are generated.
 */

process.env.NODE_ENV = 'test'; // in-memory DB only — no live backend touched

const fs   = require('fs');
const path = require('path');

const supaPath = require.resolve('../services/supabase');
const mockSupa = require('../../tests/__mocks__/supabaseClient');
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true, exports: mockSupa };

const { seedDemo }              = require('./seedDemo');
const { buildPdf, fmtDate, MUTED } = require('./pdfWriter');
const { supabase }              = mockSupa;

const OUT = path.resolve(__dirname, '../../../frontend/public-demo/files');

// Letterheads by document source; the MMI claim's PTP is Dr. Vasquez
// (per the seeded solicitation), everyone else treats at Pacific Crest.
function letterheadFor(doc, claim) {
  const provider = claim.id === 'claim_demo_011'
    ? ['Vasquez Spine & Occupational Health', '5757 Sepulveda Blvd, Van Nuys, CA 91411 · (818) 555-0152']
    : ['Pacific Crest Occupational Medicine', '4410 Wilshire Blvd, Los Angeles, CA 90010 · (213) 555-0190'];
  switch (doc.source) {
    case 'provider':        return [provider[0], 'Treating Physician Reports', provider[1]];
    case 'employer':        return [claim.employer_name, 'Workers\' Compensation — Employer Records', 'HR / Payroll Department'];
    case 'attorney':        return ['Goldstein & Marsh LLP', 'Applicant Attorneys — Workers\' Compensation', '3550 Wilshire Blvd, Suite 1800, Los Angeles, CA 90010 · (213) 555-0177'];
    case 'dwc':             return ['State of California — Division of Workers\' Compensation', 'Medical Unit', 'P.O. Box 71010, Oakland, CA 94612'];
    case 'internal':        return ['HomeCare TPA', 'Workers\' Compensation Administration', 'adjuster@homecaretpa.com'];
    case 'employee_portal': return ['ClaimLayer Worker Intake', 'Employee-submitted media & transcript', null];
    default:                return ['Inbound Mail — Claims Intake', 'HomeCare TPA document ingestion', null];
  }
}

// One or two filler paragraphs per category so each PDF reads like the
// document its title claims to be, beyond the captured summary.
const CATEGORY_BOILERPLATE = {
  medical: [
    'Examination performed in office. Objective findings, current work status, and the treatment plan are summarized above; complete chart notes are maintained by the practice and available on request.',
    'The opinions expressed are stated within reasonable medical probability and are based on the history provided, the records reviewed, and today\'s clinical examination.',
  ],
  state_form: [
    'This form is filed pursuant to the California Labor Code and Division of Workers\' Compensation regulations. Entries reflect the information available to the reporting party on the date signed.',
  ],
  wage: [
    'Figures are drawn from certified payroll records for the period shown. Overtime is included; expense reimbursements are excluded. Contact the payroll department for the underlying register.',
  ],
  work_status: [
    'This work status supersedes any prior status on file. The employer should contact the clinic with modified-duty availability questions; a new report will issue at the next re-evaluation.',
  ],
  legal: [
    'Service of this document is made on all parties of record per the attached proof of service. Responses, if any, are due within the statutory period applicable to the filing.',
  ],
  settlement: [
    'The figures referenced are negotiation positions and are not binding until reduced to an executed agreement approved by the Workers\' Compensation Appeals Board.',
  ],
  qme: [
    'Scheduling, records service, and report timelines are governed by 8 CCR §§30–35 and Labor Code §139.2. Contact the medical-legal coordinator with any conflicts at least 10 days before the appointment.',
  ],
  correspondence: [
    'Please direct any questions regarding this correspondence to the sender at the address or telephone number in the letterhead.',
  ],
};

async function main() {
  await seedDemo();

  const { data: claims } = await supabase.from('claims').select('*');
  const claimById = Object.fromEntries((claims || []).map(c => [c.id, c]));
  const { data: docs } = await supabase.from('claim_documents').select('*');
  const fileable = (docs || []).filter(d => d.claim_id && claimById[d.claim_id]);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const doc of fileable) {
    const claim = claimById[doc.claim_id];
    const emp   = claim.employee || {};
    const [name, sub, contact] = letterheadFor(doc, claim);

    const bytes = await buildPdf((w) => {
      w.letterhead(name, sub, contact);
      w.title(doc.title);
      w.fields([
        ['Patient / Employee', `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'On file'],
        ['Employer',           claim.employer_name],
        ['Claim Number',       claim.claim_number],
        ['Date of Injury',     fmtDate(claim.date_of_injury)],
        ['Document Date',      fmtDate(doc.received_at)],
        ['Pages',              String(doc.pages || 1)],
      ]);
      w.para(doc.ai_summary || 'Document content on file.');
      for (const p of CATEGORY_BOILERPLATE[doc.category] || []) w.para(p);
      w.para('This file is the demo stand-in for the original document: the static demo serves it wherever the drawer offers "Open original."', { size: 8.5, color: MUTED });
    }, 'SYNTHETIC DEMO DOCUMENT — ClaimLayer demo data, not a real claim');

    fs.writeFileSync(path.join(OUT, `${doc.id}.pdf`), bytes);
  }

  // eslint-disable-next-line no-console
  console.log(`✓ wrote ${fileable.length} demo document PDFs to ${OUT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('✗ generateDemoFilePdfs failed:', err.message);
  process.exit(1);
});
