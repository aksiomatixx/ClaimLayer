'use strict';

/**
 * generateTestDocuments.js — realistic inbound claim documents (PDFs)
 * for exercising the document-ingestion pipeline against the demo seed.
 *
 *   npm run gen:test-docs            (from backend/)
 *   npm run gen:test-docs -- ./out   (custom output directory)
 *
 * Every PDF is built from the SAME personas / lifecycle plans the demo
 * seeder uses, so claim numbers (HHW-<year>-DXX), claimant names, DOIs,
 * employers, and body parts always match a fresh `npm run seed:demo`.
 * Because DOIs are computed relative to today, regenerate the PDFs
 * whenever you re-seed.
 *
 * Each document is the natural NEXT inbound document for its claim's
 * lifecycle stage — upload one through the drawer or
 * POST /api/v1/documents/ingest-file and watch it classify, match by
 * extracted claim number, file, and queue its action diary. One file
 * deliberately carries no claim number so it lands in the human triage
 * queue (the pipeline's core guardrail).
 *
 * pdf-lib draws a real text layer, so these exercise the text-layer
 * extraction path (extraction_method 'text_layer'), not the
 * document-vision fallback.
 *
 * All content is synthetic. Names, providers, and phone numbers are
 * fake (555 exchanges); no statutory or fee-schedule values are
 * synthesized beyond the seed's own placeholder figures.
 */

const fs   = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { PERSONAS, LIFECYCLE_PLANS, makeClaimId, makeClaimNumber, dateDaysAgo } = require('./demoData');

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;

const INK   = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.40, 0.40, 0.45);
const RULE  = rgb(0.72, 0.72, 0.76);

function fmtDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

function money(n) {
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

// ── Tiny page-cursor writer over pdf-lib ─────────────────────────────────────

class Writer {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.page = null;
    this.y = 0;
    this._newPage();
  }
  _newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }
  _ensure(height) {
    if (this.y - height < MARGIN) this._newPage();
  }
  _wrap(text, font, size, width) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(probe, size) > width && line) {
        lines.push(line);
        line = w;
      } else {
        line = probe;
      }
    }
    if (line) lines.push(line);
    return lines;
  }
  rule(gap = 10) {
    this._ensure(gap);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.6, color: RULE,
    });
    this.y -= gap;
  }
  letterhead(name, sub, contact) {
    this.text(name, { font: 'bold', size: 15 });
    if (sub) this.text(sub, { size: 9, color: MUTED });
    if (contact) this.text(contact, { size: 8.5, color: MUTED });
    this.y -= 4;
    this.rule(16);
  }
  title(text) {
    this._ensure(26);
    this.text(text.toUpperCase(), { font: 'bold', size: 12.5 });
    this.y -= 6;
  }
  text(text, { font = 'regular', size = 10, color = INK, indent = 0 } = {}) {
    const f = this.fonts[font];
    const width = PAGE_W - 2 * MARGIN - indent;
    for (const line of this._wrap(text, f, size, width)) {
      this._ensure(size + 4);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font: f, color });
      this.y -= size + 4;
    }
  }
  para(text, opts = {}) {
    this.text(text, opts);
    this.y -= 6;
  }
  fields(pairs) {
    const labelW = 150;
    for (const [label, value] of pairs) {
      this._ensure(14);
      this.page.drawText(`${label}:`, { x: MARGIN, y: this.y - 10, size: 9, font: this.fonts.bold, color: MUTED });
      const f = this.fonts.regular;
      const lines = this._wrap(value, f, 10, PAGE_W - 2 * MARGIN - labelW);
      for (let i = 0; i < lines.length; i++) {
        this._ensure(14);
        this.page.drawText(lines[i], { x: MARGIN + labelW, y: this.y - 10, size: 10, font: f, color: INK });
        this.y -= 14;
      }
    }
    this.y -= 6;
  }
  mono(lines, size = 8.5) {
    for (const line of lines) {
      this._ensure(size + 3.5);
      this.page.drawText(line, { x: MARGIN, y: this.y - size, size, font: this.fonts.mono, color: INK });
      this.y -= size + 3.5;
    }
    this.y -= 6;
  }
  checkbox(checked, label) {
    this._ensure(14);
    this.page.drawRectangle({
      x: MARGIN, y: this.y - 10, width: 8, height: 8,
      borderWidth: 0.8, borderColor: INK,
    });
    if (checked) {
      this.page.drawText('X', { x: MARGIN + 1.4, y: this.y - 9, size: 8, font: this.fonts.bold, color: INK });
    }
    this.page.drawText(label, { x: MARGIN + 14, y: this.y - 9.5, size: 9.5, font: this.fonts.regular, color: INK });
    this.y -= 15;
  }
  signature(name, role, date) {
    this.y -= 14;
    this._ensure(40);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y }, end: { x: MARGIN + 200, y: this.y },
      thickness: 0.8, color: INK,
    });
    this.y -= 12;
    this.text(`${name}${role ? ` — ${role}` : ''}`, { size: 9.5 });
    if (date) this.text(`Date: ${date}`, { size: 9.5, color: MUTED });
  }
  footer(note) {
    for (let i = 0; i < this.pdf.getPageCount(); i++) {
      const p = this.pdf.getPage(i);
      p.drawText(`${note}  —  page ${i + 1} of ${this.pdf.getPageCount()}`, {
        x: MARGIN, y: MARGIN - 22, size: 7.5, font: this.fonts.regular, color: MUTED,
      });
    }
  }
}

async function buildPdf(build) {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold:    await pdf.embedFont(StandardFonts.HelveticaBold),
    mono:    await pdf.embedFont(StandardFonts.Courier),
  };
  const w = new Writer(pdf, fonts);
  build(w);
  w.footer('SYNTHETIC TEST DOCUMENT — ClaimLayer demo data, not a real claim');
  return pdf.save();
}

// ── Shared claim context ─────────────────────────────────────────────────────

function ctx(idx) {
  const plan = LIFECYCLE_PLANS[idx];
  const p    = PERSONAS[plan.persona];
  return {
    plan,
    persona:     p,
    name:        `${p.first} ${p.last}`,
    claimId:     makeClaimId(idx),
    claimNumber: makeClaimNumber(idx),
    doi:         dateDaysAgo(plan.daysAgo),
    employer:    p.employer.name,
  };
}

function patientBlock(w, c, reportDateIso, extra = []) {
  w.fields([
    ['Patient / Employee', c.name],
    ['Date of Birth',      fmtDate(c.persona.dob)],
    ['Employer',           c.employer],
    ['Claim Number',       c.claimNumber],
    ['Date of Injury',     fmtDate(c.doi)],
    ['Report Date',        fmtDate(reportDateIso)],
    ...extra,
  ]);
}

// ── Document builders ────────────────────────────────────────────────────────
// Each returns { filename, expected, bytesPromise }.

function dwc1ClaimForm() {
  const c = ctx(0); // Maria Santos — new_claim, lumbar
  const today = dateDaysAgo(0);
  return {
    filename: `DWC1-claim-form_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'state_form', routing: 'STATE_FORM_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('State of California — Division of Workers\' Compensation',
        'DWC 1 — Workers\' Compensation Claim Form & Notice of Potential Eligibility',
        'Employee completes the "Employee" section and returns the form to the employer');
      w.title('DWC 1 — Employee Claim Form (completed and returned)');
      patientBlock(w, c, today, [
        ['Job Title', c.persona.title],
        ['Phone',     c.persona.phone],
      ]);
      w.para('1. Description of injury and part of body affected: Sharp pain in my lower back while transferring a patient from bed to wheelchair. Lumbar spine / lower back.');
      w.para(`2. Date of injury: ${fmtDate(c.doi)}. Time: approximately 10:15 a.m. Address where injury occurred: patient residence on assigned route, Los Angeles, CA.`);
      w.para('3. The injury was reported to my supervisor the same day. I received first aid on site and was referred to the MPN clinic for evaluation.');
      w.para(`Employer section — completed by ${c.employer}: claim form received from the employee; claim number ${c.claimNumber} assigned; claims administrator HomeCare TPA notified.`);
      w.signature(c.name, 'Employee', fmtDate(today));
      w.signature('R. Delgado', `Supervisor, ${c.employer}`, fmtDate(today));
    }),
  };
}

function pr1InitialReport() {
  const c = ctx(1); // James Lee — intake_complete, wrist
  const today = dateDaysAgo(0);
  return {
    filename: `PR1-initial-report_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'medical', routing: 'MED_REPORT_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('Pacific Crest Occupational Medicine',
        'Primary Treating Physician — Doctor\'s First Report of Occupational Injury (Form 5021 / PR-1)',
        '4410 Wilshire Blvd, Los Angeles, CA 90010 · (213) 555-0190 · fax (213) 555-0191');
      w.title('Doctor\'s First Report — initial evaluation');
      patientBlock(w, c, today, [['Treating Physician', 'Samuel Reyes, M.D.']]);
      w.para('History: 47-year-old LVN with gradual-onset right wrist and volar forearm pain after repetitive injection draws across a long shift. No single acute event. Pain 5/10, worse with gripping and wrist flexion.');
      w.para('Objective findings: Tenderness over the flexor carpi radialis and pronator teres. Negative Tinel\'s and Phalen\'s. Full ROM with pain at end-range flexion. No swelling or deformity. Grip strength reduced on the right (28 kg vs 41 kg left).');
      w.para('Diagnosis: Right wrist/forearm flexor strain, repetitive use (ICD-10 S66.811A). Causation: within reasonable medical probability, the condition arose out of and in the course of employment as described.');
      w.para('Treatment plan: NSAIDs, volar wrist splint, activity modification. Re-evaluate in 14 days. Physical therapy to be requested if not improving.');
      w.para('Work status: Modified duty — no forceful gripping with the right hand, no repetitive wrist flexion/extension, lifting limited to 5 lbs with the right hand. If modified duty is not available, the employee should remain off work.');
      w.signature('Samuel Reyes, M.D.', 'Primary Treating Physician', fmtDate(today));
    }),
  };
}

function wageStatement() {
  const c = ctx(2); // Rosa Mendez — under_investigation, AWW verification
  const today = dateDaysAgo(0);
  const weeks = [];
  for (let i = 13; i >= 1; i--) {
    const weekEnd = dateDaysAgo(c.plan.daysAgo + i * 7);
    const gross = (i === 6 || i === 11) ? 0 : 621.0 + ((i * 37) % 90) - 45; // two scheduled-leave gaps
    weeks.push([weekEnd, Math.max(gross, 0)]);
  }
  return {
    filename: `Wage-statement_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'wage', routing: 'AWW_RECALC_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead(c.employer, 'Payroll Department — Wage Statement for Claims Administration',
        '1800 W 6th St, Los Angeles, CA 90057 · payroll (213) 555-0180');
      w.title('Wage statement — 13 weeks preceding date of injury');
      patientBlock(w, c, today, [
        ['Job Title',   c.persona.title],
        ['Pay Basis',   'Hourly, biweekly payroll'],
      ]);
      w.para(`Provided at the request of HomeCare TPA for AWW verification on claim ${c.claimNumber}. Gross wages by week ending date (overtime included, mileage reimbursements excluded):`);
      w.mono([
        'WEEK ENDING      GROSS WAGES   HOURS   NOTES',
        '-----------      -----------   -----   -----',
        ...weeks.map(([d, g]) =>
          `${fmtDate(d)}       ${money(g).padStart(10)}   ${g === 0 ? ' 0.0' : '38.5'}   ${g === 0 ? 'scheduled unpaid leave' : ''}`),
        '',
        `13-WEEK GROSS:   ${money(weeks.reduce((s, [, g]) => s + g, 0)).padStart(10)}`,
      ]);
      w.para('Two zero-wage weeks reflect pre-approved unpaid leave, not disputed time. Certified payroll export attached to the original transmission.');
      w.signature('L. Fuentes', `Payroll Administrator, ${c.employer}`, fmtDate(today));
    }),
  };
}

function rfaForm() {
  const c = ctx(3); // David Park — active_medical, knee
  const today = dateDaysAgo(0);
  return {
    filename: `DWC-Form-RFA_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'rfa', routing: 'RFA_INTAKE_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('State of California — Division of Workers\' Compensation',
        'DWC Form RFA — Request for Authorization for Medical Treatment (8 CCR §9785.5)',
        'Attach the supporting PR-2 or equivalent narrative report');
      w.title('Request for Authorization');
      w.checkbox(true,  'New request');
      w.checkbox(false, 'Resubmission — change in material facts');
      w.checkbox(false, 'Expedited review: check box if employee faces an imminent and serious threat to his or her health');
      w.y -= 6;
      patientBlock(w, c, today, [
        ['Requesting Physician', 'Samuel Reyes, M.D. — Pacific Crest Occupational Medicine'],
        ['Specialty',            'Occupational Medicine'],
        ['Phone / Fax',          '(213) 555-0190 / (213) 555-0191'],
      ]);
      w.para('Requested treatment (list each specific service, good, or item with applicable codes):');
      w.mono([
        'DIAGNOSIS (ICD-10)        SERVICE REQUESTED                 CPT       FREQ/DURATION',
        '------------------        -----------------                 ---       -------------',
        'S83.241A  Medial meniscus Therapeutic exercise — continued  97110     2x/week x 3 weeks',
        '          tear, right knee physical therapy, 6 visits',
      ]);
      w.para('Clinical rationale: Worker is progressing in PT following a twisting injury to the right knee with persistent medial joint-line pain. Objective gains in quadriceps strength and ROM over the first 12 visits; an additional 6 visits are requested to reach plateau and transition to a home exercise program, consistent with the MTUS knee chapter.');
      w.signature('Samuel Reyes, M.D.', 'Requesting Physician', fmtDate(today));
      w.para('Claims administrator response section (to be completed by UR): approved / modified / denied — see attached determination.', { size: 8.5, color: MUTED });
    }),
  };
}

function workStatusReport() {
  const c = ctx(4); // Linda Chen — active_medical, cervical MVA
  const today = dateDaysAgo(0);
  return {
    filename: `Work-status-report_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'work_status', routing: 'TD_PAYMENT_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('Westlake Spine & Rehabilitation Center',
        'Work Status Report', '2901 Beverly Blvd, Los Angeles, CA 90057 · (213) 555-0144');
      w.title('Work status report');
      patientBlock(w, c, today, [['Treating Physician', 'Anita Krishnan, M.D.']]);
      w.para('The above patient was seen in follow-up today for cervical strain sustained in a motor vehicle accident while driving her assigned home-health route.');
      w.checkbox(true,  `OFF WORK — patient remains temporarily totally disabled from ${fmtDate(today)} through the next re-evaluation (14 days).`);
      w.checkbox(false, 'MODIFIED DUTY — may return to work with the restrictions listed below.');
      w.checkbox(false, 'FULL DUTY — released to usual and customary occupation without restriction.');
      w.y -= 4;
      w.para('Basis: Persistent cervical paraspinal spasm and reduced rotation (45 degrees bilaterally); MRI of the cervical spine remains pending authorization. Driving duties are specifically precluded by ongoing muscle relaxant use.');
      w.para('Next appointment: re-evaluation in 14 days. A new work status report will issue at that visit.');
      w.signature('Anita Krishnan, M.D.', 'Treating Physician', fmtDate(today));
    }),
  };
}

function pr4Report() {
  const c = ctx(5); // Carlos Ruiz — p_and_s, lumbar
  const today = dateDaysAgo(0);
  return {
    filename: `PR4-PandS-report_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'medical', signals: ['p_and_s'], routing: 'PR4_RECEIVED_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('Pacific Crest Occupational Medicine',
        'PR-4 — Primary Treating Physician\'s Permanent and Stationary Report (8 CCR §9785)',
        '4410 Wilshire Blvd, Los Angeles, CA 90010 · (213) 555-0190');
      w.title('Permanent and Stationary report (PR-4)');
      patientBlock(w, c, today, [['Treating Physician', 'Samuel Reyes, M.D.']]);
      w.para(`Disability status: The patient is declared PERMANENT AND STATIONARY as of ${fmtDate(dateDaysAgo(4))}, having reached maximum medical improvement for the industrial lumbar strain. No further functional improvement is anticipated from additional conservative care.`);
      w.para('Impairment rating (AMA Guides 5th Edition): DRE Lumbar Category II — 8% whole person impairment (WPI), based on documented muscle guarding and asymmetric loss of range of motion without verifiable radiculopathy.');
      w.para('Apportionment: 90% of the permanent impairment is attributable to the industrial injury; 10% to pre-existing degenerative disc disease evident on imaging (LC §4663 analysis attached).');
      w.para('Future medical care: PRN flare-up management — up to 6 physician visits and one short course of physical therapy per year, plus NSAIDs as needed.');
      w.para('Work restrictions (permanent): no lifting over 25 lbs, no repetitive bending at the waist. The patient may return to modified duty within these restrictions; vocational feasibility deferred to the claims administrator.');
      w.signature('Samuel Reyes, M.D.', 'Primary Treating Physician', fmtDate(today));
    }),
  };
}

function qmeAppointmentNotice() {
  const c = ctx(6); // Emily Tran — pd_evaluation, shoulder
  const today = dateDaysAgo(0);
  const appt  = dateDaysAgo(-21);
  return {
    filename: `QME-appointment-notice_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'qme', routing: 'QME_REPORT_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('Harbor Orthopedic Medical Group',
        'Qualified Medical Evaluator — Appointment Notification (8 CCR §34)',
        '1124 W Carson St, Torrance, CA 90502 · scheduling (310) 555-0163');
      w.title('Notice of QME appointment');
      patientBlock(w, c, today, [
        ['QME',            'Marcus Feld, M.D. — Orthopedic Surgery (QME #934412)'],
        ['Panel Number',   'PAN-2026-118203'],
        ['Appointment',    `${fmtDate(appt)} at 1:30 p.m.`],
        ['Location',       '1124 W Carson St, Suite 300, Torrance, CA 90502'],
      ]);
      w.para(`This confirms the comprehensive medical-legal evaluation of the above employee in connection with claim ${c.claimNumber} (right shoulder, repetitive motion). The evaluation will address permanent impairment, apportionment, and future medical care.`);
      w.para('The employee should bring photo identification and arrive 20 minutes early. Records received from the parties to date are listed on the enclosed inventory; any additional records must be served per 8 CCR §35 no later than 20 days before the evaluation.');
      w.para('The report will be served on the parties within 30 days of the evaluation per LC §139.2(j)(1).');
      w.signature('S. Whitfield', 'Medical-Legal Coordinator', fmtDate(today));
    }),
  };
}

function settlementCounter() {
  const c = ctx(7); // Marcus Williams — settlement_discussions, knee
  const today = dateDaysAgo(0);
  return {
    filename: `CR-counteroffer_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'settlement', routing: 'SETTLEMENT_DOC_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('Goldstein & Marsh LLP', 'Applicant Attorneys — Workers\' Compensation',
        '3550 Wilshire Blvd, Suite 1800, Los Angeles, CA 90010 · (213) 555-0177');
      w.title('Compromise & Release — counter-proposal');
      patientBlock(w, c, today, [
        ['Applicant Attorney', 'Aaron Goldstein, Esq. (SBN 555012)'],
        ['Re',                 `Counter-proposal to the draft C&R served on our office`],
      ]);
      w.para(`Dear Claims Administrator: We are in receipt of your draft Compromise & Release (DWC-CA 10214c) on claim ${c.claimNumber}. Our client authorizes the following counter-proposal: a gross C&R amount of $32,500, inclusive of permanent disability and a buyout of future medical care for the left knee.`);
      w.para('The counter reflects (1) the 24% PD rating per the PR-4 and rating strings previously exchanged, (2) projected arthroscopic revision exposure identified in the operative report, and (3) the parties\' agreement that no Medicare interest requires a set-aside, per the screening summary your office provided — our client is under 65 and has no SSDI application pending or anticipated.');
      w.para('Should the carrier agree, we will sign and walk the documents through at the Van Nuys board. This proposal remains open for 21 days, after which we will file a Declaration of Readiness on the PD issue.');
      w.signature('Aaron Goldstein, Esq.', 'Attorney for Applicant', fmtDate(today));
    }),
  };
}

function providerBill() {
  const c = ctx(8); // Aisha Thompson — accepted, on TD payments, ankle
  const today = dateDaysAgo(0);
  return {
    filename: `Provider-bill_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'bill', routing: 'BILL_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('Pacific Crest Occupational Medicine',
        'Statement for Professional Services — Workers\' Compensation (CMS-1500 data summary)',
        'Billing: PO Box 51440, Los Angeles, CA 90051 · (213) 555-0195 · TIN 95-555 0123');
      w.title('Itemized statement');
      patientBlock(w, c, today, [
        ['Billing Provider', 'Pacific Crest Occupational Medicine — Samuel Reyes, M.D., NPI 1558 555 012'],
        ['Bill Type',        'Original bill — professional services'],
      ]);
      w.mono([
        'DOS          CPT     MOD  DESCRIPTION                          UNITS    CHARGE',
        '---          ---     ---  -----------                          -----    ------',
        `${fmtDate(dateDaysAgo(14))}   99203        Office visit, new patient, level 3     1    $185.00`,
        `${fmtDate(dateDaysAgo(14))}   73610        X-ray, ankle, complete                  1    $ 96.00`,
        `${fmtDate(dateDaysAgo(7))}   99213        Office visit, established, level 3      1    $115.00`,
        `${fmtDate(dateDaysAgo(7))}   29515        Application of short leg splint         1    $142.00`,
        '',
        '                                                       TOTAL CHARGES:   $538.00',
      ]);
      w.para(`Services rendered for the industrial left ankle injury under claim ${c.claimNumber}. Submit payment per the Official Medical Fee Schedule; supporting chart notes accompany this statement. Please remit within 45 working days of receipt (LC §4603.2).`);
      w.signature('Billing Department', 'Pacific Crest Occupational Medicine', fmtDate(today));
    }),
  };
}

function pr4Response() {
  const c = ctx(9); // Daniel Kim — MMI solicited, lumbar — the solicited PR-4 arrives
  const today = dateDaysAgo(0);
  return {
    filename: `PR4-response_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'medical', signals: ['p_and_s'], routing: 'PR4_RECEIVED_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('Vasquez Spine & Occupational Health',
        'PR-4 — Primary Treating Physician\'s Permanent and Stationary Report (8 CCR §9785)',
        '5757 Sepulveda Blvd, Van Nuys, CA 91411 · (818) 555-0152');
      w.title('Permanent and Stationary report (PR-4) — response to solicitation');
      patientBlock(w, c, today, [['Treating Physician', 'Elena Vasquez, M.D.']]);
      w.para(`This report responds to the claims administrator's PR-4 solicitation dated ${fmtDate(dateDaysAgo(6))} on claim ${c.claimNumber}.`);
      w.para(`Disability status: The patient is declared PERMANENT AND STATIONARY as of ${fmtDate(today)}. The lumbar strain has plateaued: the last two months of treatment produced no further functional gains, and the patient has transitioned to an independent home exercise program.`);
      w.para('Impairment rating (AMA Guides 5th Edition): DRE Lumbar Category II — 7% whole person impairment (WPI), based on documented muscle guarding and non-verifiable radicular complaints.');
      w.para('Apportionment: None. There is no evidence of pre-existing lumbar pathology or prior injury; 100% of the impairment is industrial.');
      w.para('Future medical care: home exercise program; up to 4 physician visits per year for flare-ups; one contingency course of physical therapy (6 visits) per year.');
      w.para('Work restrictions (permanent): no lifting over 35 lbs, no sustained extreme flexion. The patient may return to his usual occupation with these restrictions; temporary total disability ends as of the P&S date.');
      w.signature('Elena Vasquez, M.D.', 'Primary Treating Physician', fmtDate(today));
    }),
  };
}

function pharmacyStatement() {
  const c = ctx(10); // Sofia Alvarez — future_medical_only, wrist
  const today = dateDaysAgo(0);
  return {
    filename: `Pharmacy-statement_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'pharmacy', routing: 'BILL_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('CarePoint Pharmacy #214', 'Workers\' Compensation Prescription Statement',
        '6212 Van Nuys Blvd, Van Nuys, CA 91401 · (818) 555-0136 · NCPDP 5550214');
      w.title('Prescription statement');
      patientBlock(w, c, today, [
        ['Prescriber', 'Samuel Reyes, M.D. — Pacific Crest Occupational Medicine'],
        ['Carrier/TPA', 'HomeCare TPA'],
      ]);
      w.mono([
        'FILL DATE    RX #       NDC            DRUG / STRENGTH            QTY   DAYS   CHARGE',
        '---------    ----       ---            ---------------            ---   ----   ------',
        `${fmtDate(dateDaysAgo(9))}   5512208    00781-5077-10  Naproxen 500 mg tablets     60     30   $ 24.80`,
        `${fmtDate(dateDaysAgo(9))}   5512209    51672-4133-06  Diclofenac 1% gel, 100 g     1     30   $ 38.45`,
        '',
        '                                                       TOTAL CHARGES:   $ 63.25',
      ]);
      w.para(`Dispensed for flare-up care of the right wrist under the future-medical provision of claim ${c.claimNumber}. Billed per the OMFS pharmacy fee schedule; prescriptions verified against the MPN prescriber.`);
      w.signature('T. Nakamura, Pharm.D.', 'Pharmacist in Charge', fmtDate(today));
    }),
  };
}

function declarationOfReadiness() {
  const c = ctx(11); // Grace Okafor — litigated, cervical + disputed shoulder
  const today = dateDaysAgo(0);
  return {
    filename: `DOR-WCAB_${c.persona.last}_${c.claimNumber}.pdf`,
    expected: { claim_number: c.claimNumber, claim_id: c.claimId, category: 'legal', routing: 'LEGAL_REVIEW' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('Workers\' Compensation Appeals Board — State of California',
        'Declaration of Readiness to Proceed (DWC-CA form 10250.1)',
        'District Office: Los Angeles — 320 W 4th St, Los Angeles, CA 90013');
      w.title('Declaration of Readiness to Proceed');
      patientBlock(w, c, today, [
        ['WCAB Case Number',  'ADJ5512873'],
        ['Applicant Attorney', 'Aaron Goldstein, Esq. — Goldstein & Marsh LLP, (213) 555-0177'],
        ['Defendant',          `${c.employer} / HomeCare TPA`],
      ]);
      w.para('The undersigned declares the case is ready to proceed to a MANDATORY SETTLEMENT CONFERENCE on the following issues:');
      w.checkbox(true,  'Parts of body injured — defendant disputes the add-on right shoulder claim');
      w.checkbox(true,  'Temporary disability rate — applicant contends the AWW understates concurrent earnings');
      w.checkbox(false, 'Permanent disability');
      w.checkbox(false, 'Need for further medical treatment');
      w.y -= 4;
      w.para(`Declarant states that a good-faith effort was made to resolve the disputed issues on claim ${c.claimNumber}, including written demand served 30 days before this filing, and that the QME panel process on the disputed body part is complete with the report served on the parties.`);
      w.para('Proof of service on all case participants is attached. Objections to this declaration must be filed within 10 days per 8 CCR §10744.');
      w.signature('Aaron Goldstein, Esq.', 'Attorney for Applicant', fmtDate(today));
    }),
  };
}

function triageFaxNote() {
  // Deliberately unmatched: no claim number anywhere — must land in the
  // human triage queue, never silently file.
  const today = dateDaysAgo(0);
  return {
    filename: 'Triage-test_fax-note_no-claim-number.pdf',
    expected: { claim_number: null, claim_id: null, category: 'medical or other (low confidence acceptable)', routing: 'human triage queue' },
    bytesPromise: buildPdf((w) => {
      w.letterhead('— fax transmission —', 'received via inbound fax line, sender ID unreadable', null);
      w.title('Clinic visit note (partial)');
      w.para(`Visit date: ${fmtDate(today)}. Patient: M. San--- (header cut off in transmission). DOB: --/--/1981.`);
      w.para('Subjective: pt returns c/o low back pain unchanged, worse end of shift. denies numbness/tingling. taking otc rx as directed.');
      w.para('Objective: TTP L4-5 paraspinals, ROM flexion limited ~50%, SLR neg bilat.');
      w.para('Plan: continue HEP, recheck 2 wks. work note given.');
      w.para('[remainder of page illegible — fax artifact]', { color: MUTED });
      w.para('No claim number, employer, or adjuster reference appears on this transmission.', { size: 8.5, color: MUTED });
    }),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const BUILDERS = [
  dwc1ClaimForm, pr1InitialReport, wageStatement, rfaForm,
  workStatusReport, pr4Report, qmeAppointmentNotice, settlementCounter,
  providerBill, pr4Response, pharmacyStatement, declarationOfReadiness,
  triageFaxNote,
];

async function generateTestDocuments(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = [];
  for (const build of BUILDERS) {
    const { filename, expected, bytesPromise } = build();
    const bytes = await bytesPromise;
    fs.writeFileSync(path.join(outDir, filename), bytes);
    manifest.push({ file: filename, ...expected });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    note: 'Synthetic test PDFs matching the demo seed. Claim numbers embed the current year and DOIs are relative to the generation date — regenerate after each npm run seed:demo. Upload via the claim drawer or POST /api/v1/documents/ingest-file.',
    files: manifest,
  }, null, 2));
  return manifest;
}

if (require.main === module) {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, '../../../test-documents'));
  generateTestDocuments(outDir)
    .then((manifest) => {
      // eslint-disable-next-line no-console
      console.log(`✓ wrote ${manifest.length} test PDFs + manifest.json to ${outDir}`);
      for (const m of manifest) {
        // eslint-disable-next-line no-console
        console.log(`  ${m.file}  →  ${m.claim_number || '(no claim number — triage)'}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('✗ generateTestDocuments failed:', err.message);
      process.exit(1);
    });
}

module.exports = { generateTestDocuments, BUILDERS };
