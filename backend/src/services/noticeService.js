'use strict';

/**
 * noticeService.js — CA WC statutory notice generation — M9.
 *
 * Every notice:
 *   1. Generates a PDF server-side (pdf-lib)
 *   2. Inserts a row into the `notices` table
 *   3. Queues print & mail via lobService
 *   4. Writes an audit_log entry (7-year retention per CA WC regs)
 *
 * DWC Information & Assistance (I&A) block is structurally hardcoded into
 * every notice sent to unrepresented workers — there is no conditional path
 * that can omit it.
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { supabase }        = require('./supabase');
const lobService           = require('./lobService');
const config               = require('../config');
const logger               = require('../logger');
const { addBusinessDays }  = require('../utils/businessDays');

// ── PDF constants (match pdfService.js palette) ──────────────────────────────
const DARK     = rgb(0.1, 0.1, 0.1);
const GRAY     = rgb(0.4, 0.4, 0.4);
const BLUE     = rgb(0.0, 0.27, 0.55);
const LINE     = rgb(0.75, 0.75, 0.75);
const FIELD_BG = rgb(0.97, 0.97, 0.97);
const PAGE_W   = 612;
const PAGE_H   = 792;
const MARGIN   = 48;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _drawLine(page, x1, y, x2, color = LINE) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color });
}

function _formatDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + (isoDate.includes('T') ? '' : 'T00:00:00'));
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

function _wrapText(text, maxWidth, font, size) {
  const words  = (text || '').split(' ');
  const lines  = [];
  let current  = '';
  const maxCh  = Math.floor(maxWidth / (size * 0.52));
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxCh) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── DWC I&A Block ────────────────────────────────────────────────────────────
// Required on EVERY notice to unrepresented injured workers per LC §5401.7
// and 8 CCR §9812. Hardcoded — no conditional can omit this.

const DWC_IA_BLOCK = [
  'INFORMATION & ASSISTANCE (I&A) — YOUR RIGHT TO FREE HELP',
  '',
  'You have the right to receive free information and assistance from the',
  'Division of Workers\' Compensation (DWC) Information & Assistance Unit.',
  '',
  'The I&A officer can help you understand your rights, file claims and',
  'applications, and navigate the workers\' compensation process at no cost.',
  '',
  'Contact DWC Information & Assistance:',
  '  Phone:   1-800-736-7401 (toll-free)',
  '  Website: www.dir.ca.gov/dwc/iwguides.html',
  '  Office:  Find your local I&A office at www.dir.ca.gov/dwc/IandA.html',
  '',
  'You may also consult an attorney. If you do not have an attorney, the',
  'California State Bar Lawyer Referral Service can be reached at 1-866-442-2529.',
];

/**
 * Render the DWC I&A block onto a PDF page. Returns the new Y position.
 * This function is called from every notice generator — structurally
 * guaranteed, not conditionally gated.
 */
function _drawIABlock(page, y, fonts) {
  const blockTop = y;

  // Tinted background box — height calculated from line count
  const lineH      = 11;
  const blockH     = DWC_IA_BLOCK.length * lineH + 20;
  const boxY       = y - blockH + 6;
  page.drawRectangle({
    x: MARGIN, y: boxY, width: PAGE_W - MARGIN * 2, height: blockH,
    color: rgb(0.95, 0.97, 1.0), borderColor: BLUE, borderWidth: 0.5,
  });

  y -= 12;
  for (const line of DWC_IA_BLOCK) {
    if (line === DWC_IA_BLOCK[0]) {
      // Header line — bold + blue
      page.drawText(line, { x: MARGIN + 8, y, size: 8, font: fonts.bold, color: BLUE });
    } else {
      page.drawText(line, { x: MARGIN + 8, y, size: 7.5, font: fonts.regular, color: DARK });
    }
    y -= lineH;
  }

  return y - 6;
}

// ── Letterhead (shared across all notices) ────────────────────────────────────

function _drawLetterhead(page, fonts) {
  let y = PAGE_H - MARGIN;

  page.drawText('HomeCare TPA', { x: MARGIN, y, size: 18, font: fonts.bold, color: BLUE });
  y -= 14;
  page.drawText('Workers\' Compensation Administration', { x: MARGIN, y, size: 9, font: fonts.regular, color: GRAY });
  y -= 9;
  page.drawText(
    `${config.adjuster.email}  |  ${config.adjuster.phone}`,
    { x: MARGIN, y, size: 8, font: fonts.regular, color: GRAY },
  );
  y -= 4;
  _drawLine(page, MARGIN, y, PAGE_W - MARGIN, BLUE);
  y -= 20;

  return y;
}

// ── Fetch claim (lazy require to avoid circular dep) ─────────────────────────

function _getClaimService() {
  return require('./claimService');
}

// ── Audit log write ──────────────────────────────────────────────────────────

async function _writeAuditLog(action, resourceType, resourceId, description, newValue) {
  try {
    await supabase.from('audit_log').insert({
      action,
      resource_type: resourceType,
      resource_id:   resourceId,
      description,
      new_value:     newValue,
      user_role:     'system',
      created_at:    new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'noticeService: audit_log write failed', err: err.message, action, resourceId });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// generateDwc7 — DWC-7 Notice of Rights
// ═════════════════════════════════════════════════════════════════════════════
//
// Per LC §5401.7 and 8 CCR §9810: Claims administrator must send a notice
// advising the employee of potential eligibility for benefits within 5 days
// of receipt of the claim form or knowledge of injury.
//
// The DWC I&A block is structurally included — not behind any conditional.

async function generateDwc7(claimId) {
  const claim = await _getClaimService().getClaim(claimId);
  if (!claim) {
    logger.error({ msg: 'noticeService.generateDwc7: claim not found', claimId });
    return null;
  }

  const emp    = claim.employee || {};
  const empName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Injured Worker';
  const now     = new Date().toISOString();

  // Statutory deadline: 5 days from claim receipt (filed_at)
  const filedAt  = claim.filed_at || claim.createdAt || now;
  const deadline = addBusinessDays(filedAt, 5).toISOString();

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = _drawLetterhead(page, fonts);

  // Date
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  page.drawText(today, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 24;

  // Recipient
  page.drawText(empName, { x: MARGIN, y, size: 10, font: fonts.bold, color: DARK });
  y -= 13;
  const addr = emp.address
    ? `${emp.address.line1 || emp.address.addressLine1 || ''}, ${emp.address.city || ''}, ${emp.address.state || emp.address.countrySubdivisionCode || 'CA'} ${emp.address.postalCode || emp.address.zip || ''}`
    : 'Address on file';
  page.drawText(addr, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 30;

  // Subject line
  page.drawText('Re: Notice of Workers\' Compensation Benefits — DWC-7', {
    x: MARGIN, y, size: 11, font: fonts.bold, color: DARK,
  });
  y -= 14;
  page.drawText(`Claim No: ${claim.claimNumber || claim.id}  |  Date of Injury: ${_formatDate(claim.dateOfInjury)}`, {
    x: MARGIN, y, size: 10, font: fonts.regular, color: DARK,
  });
  y -= 28;

  // Body
  const bodyLines = [
    `Dear ${emp.firstName || 'Injured Worker'},`,
    '',
    'You have filed a workers\' compensation claim. This notice is to inform you of your',
    'rights and benefits under California workers\' compensation law.',
    '',
    'YOUR RIGHTS UNDER CALIFORNIA WORKERS\' COMPENSATION:',
    '',
    '1. MEDICAL TREATMENT — You are entitled to receive all medical treatment reasonably',
    '   required to cure or relieve the effects of your injury (LC \u00A74600).',
    '',
    '2. TEMPORARY DISABILITY (TD) — If your doctor says you cannot work or can only do',
    '   limited work while recovering, you may receive TD payments. The first payment is',
    '   due within 14 days after your employer learns of your injury (LC \u00A74650).',
    '',
    '3. PERMANENT DISABILITY (PD) — If your injury causes permanent limitations, you may',
    '   be entitled to PD payments after you reach maximum medical improvement.',
    '',
    '4. SUPPLEMENTAL JOB DISPLACEMENT — If your injury results in permanent partial',
    '   disability and your employer does not offer modified or alternative work, you may',
    '   be entitled to a supplemental job displacement benefit (LC \u00A74658.7).',
    '',
    '5. DEATH BENEFITS — If the injury results in death, reasonable burial expenses and',
    '   death benefits may be payable to eligible dependents.',
    '',
    'CLAIMS ADMINISTRATOR INFORMATION:',
    `  Name:    ${config.adjuster.name}`,
    `  Phone:   ${config.adjuster.phone}`,
    `  Email:   ${config.adjuster.email}`,
    `  Address: HomeCare TPA, Claims Department`,
    '',
    'You may receive a delay letter if a decision on your claim has not been made within',
    '14 days. Under LC \u00A75402, if your claim is not denied within 90 days, it is presumed',
    'accepted by operation of law.',
    '',
  ];

  for (const line of bodyLines) {
    if (y < 200) break; // reserve space for I&A block + footer
    const isHeading = line === line.toUpperCase() && line.length > 2;
    page.drawText(line, {
      x: MARGIN, y,
      size: isHeading ? 9 : 9,
      font: isHeading ? fonts.bold : fonts.regular,
      color: DARK,
      maxWidth: PAGE_W - MARGIN * 2,
    });
    y -= 12;
  }

  // ── DWC I&A Block — structurally hardcoded, cannot be omitted ──────────────
  y = _drawIABlock(page, y, fonts);

  // Footer
  page.drawText(
    `Generated by HomeCare TPA — ${new Date().toLocaleDateString('en-US')} — Claim ${claim.claimNumber || claim.id}`,
    { x: MARGIN, y: 24, size: 6, font: fonts.regular, color: rgb(0.6, 0.6, 0.6) },
  );

  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);

  logger.info({
    msg:         'noticeService: DWC-7 PDF generated',
    claimId,
    claimNumber: claim.claimNumber,
    sizeKb:      Math.round(pdfBuffer.length / 1024),
  });

  // ── Write notices row ──────────────────────────────────────────────────────
  const recipientAddress = addr;
  const storagePath = `notices/dwc7/${claimId}/${Date.now()}.pdf`;

  const lobResult = await lobService.sendLetter('dwc7', claimId, 'claimant', {
    recipientName:    empName,
    recipientAddress,
    pdfBuffer,
  });

  const noticeRow = {
    claim_id:             claimId,
    notice_type:          'dwc7',
    statutory_deadline:   deadline,
    recipient_name:       empName,
    recipient_address:    recipientAddress,
    generated_at:         now,
    pdf_storage_path:     storagePath,
    lob_letter_id:        lobResult.letterId,
    lob_sent_at:          now,
    lob_expected_delivery: lobResult.estimatedDelivery,
    lob_status:           lobResult.status,
    created_at:           now,
  };

  const { data: inserted, error } = await supabase
    .from('notices')
    .insert(noticeRow)
    .select()
    .single();

  if (error) {
    logger.error({ msg: 'noticeService.generateDwc7: DB insert failed', err: error.message, claimId });
  }

  const noticeId = inserted?.id || `notice_dwc7_${claimId}`;

  // ── Audit log — 7-year retention ───────────────────────────────────────────
  await _writeAuditLog(
    'notice_generated',
    'notice',
    noticeId,
    `DWC-7 notice generated for claim ${claim.claimNumber || claimId} — mailed to ${empName}`,
    { noticeType: 'dwc7', claimId, lobLetterId: lobResult.letterId },
  );

  logger.info({ msg: 'noticeService.generateDwc7: complete', claimId, noticeId, lobLetterId: lobResult.letterId });

  return {
    noticeId,
    noticeType:   'dwc7',
    claimId,
    lobLetterId:  lobResult.letterId,
    lobStatus:    lobResult.status,
    pdfSizeKb:    Math.round(pdfBuffer.length / 1024),
    pdfBuffer,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// generateTdNotice — Temporary Disability Benefit Notice
// ═════════════════════════════════════════════════════════════════════════════
//
// Per LC §4650: First TD payment due within 14 days of employer knowledge of
// injury/disability. This notice informs the worker of their TD rate, payment
// schedule, and rights.  The DWC I&A block is structurally included.

async function generateTdNotice(claimId) {
  const claim = await _getClaimService().getClaim(claimId);
  if (!claim) {
    logger.error({ msg: 'noticeService.generateTdNotice: claim not found', claimId });
    return null;
  }

  const emp     = claim.employee || {};
  const empName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Injured Worker';
  const now     = new Date().toISOString();

  // Statutory deadline: 14 days from employer knowledge (use filed_at as proxy)
  const filedAt  = claim.filed_at || claim.createdAt || now;
  const deadline = new Date(new Date(filedAt).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const tdRate = claim.tdRate || 0;
  const aww    = claim.aww    || 0;

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = _drawLetterhead(page, fonts);

  // Date
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  page.drawText(today, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 24;

  // Recipient
  page.drawText(empName, { x: MARGIN, y, size: 10, font: fonts.bold, color: DARK });
  y -= 13;
  const addr = emp.address
    ? `${emp.address.line1 || emp.address.addressLine1 || ''}, ${emp.address.city || ''}, ${emp.address.state || emp.address.countrySubdivisionCode || 'CA'} ${emp.address.postalCode || emp.address.zip || ''}`
    : 'Address on file';
  page.drawText(addr, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 30;

  // Subject
  page.drawText('Re: Notice of Temporary Disability Benefits', {
    x: MARGIN, y, size: 11, font: fonts.bold, color: DARK,
  });
  y -= 14;
  page.drawText(`Claim No: ${claim.claimNumber || claim.id}  |  Date of Injury: ${_formatDate(claim.dateOfInjury)}`, {
    x: MARGIN, y, size: 10, font: fonts.regular, color: DARK,
  });
  y -= 28;

  const fmt$ = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const bodyLines = [
    `Dear ${emp.firstName || 'Injured Worker'},`,
    '',
    'This letter is to notify you that you may be entitled to temporary disability (TD)',
    'benefits in connection with your workers\' compensation claim referenced above.',
    '',
    'BENEFIT CALCULATION:',
    '',
    `  Average Weekly Wage (AWW):     ${fmt$(aww)}`,
    `  Temporary Disability Rate:     ${fmt$(tdRate)} per week`,
    '',
    'Per Labor Code \u00A74653, the TD rate is two-thirds of your average weekly wage, subject',
    'to the minimum and maximum rates set by the State of California for the year of injury.',
    '',
    'PAYMENT SCHEDULE:',
    '',
    'TD payments are made every two weeks during the period of temporary disability.',
    'The first payment is due no later than 14 days after your employer has knowledge of',
    'your injury or disability (LC \u00A74650).',
    '',
    'TD benefits continue until one of the following occurs:',
    '  \u2022 Your treating physician releases you to return to work',
    '  \u2022 Your condition reaches permanent and stationary (P&S) status',
    '  \u2022 You reach the 104-week maximum (LC \u00A74656), except as extended for certain injuries',
    '',
    'IMPORTANT — YOUR OBLIGATIONS:',
    '',
    'You must attend all scheduled medical appointments and comply with your treating',
    'physician\'s prescribed treatment plan. Failure to do so may result in suspension of',
    'your TD benefits (LC \u00A74056).',
    '',
    'CLAIMS ADMINISTRATOR:',
    `  ${config.adjuster.name}  |  ${config.adjuster.phone}  |  ${config.adjuster.email}`,
    '',
  ];

  for (const line of bodyLines) {
    if (y < 200) break;
    const isHeading = line === line.toUpperCase() && line.length > 2;
    page.drawText(line, {
      x: MARGIN, y,
      size: 9,
      font: isHeading ? fonts.bold : fonts.regular,
      color: DARK,
      maxWidth: PAGE_W - MARGIN * 2,
    });
    y -= 12;
  }

  // ── DWC I&A Block — structurally hardcoded, cannot be omitted ──────────────
  y = _drawIABlock(page, y, fonts);

  // Footer
  page.drawText(
    `Generated by HomeCare TPA — ${new Date().toLocaleDateString('en-US')} — Claim ${claim.claimNumber || claim.id}`,
    { x: MARGIN, y: 24, size: 6, font: fonts.regular, color: rgb(0.6, 0.6, 0.6) },
  );

  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);

  logger.info({
    msg:         'noticeService: TD benefit PDF generated',
    claimId,
    claimNumber: claim.claimNumber,
    sizeKb:      Math.round(pdfBuffer.length / 1024),
  });

  // ── Write notices row ──────────────────────────────────────────────────────
  const storagePath = `notices/td_benefit/${claimId}/${Date.now()}.pdf`;

  const lobResult = await lobService.sendLetter('td_benefit', claimId, 'claimant', {
    recipientName:    empName,
    recipientAddress: addr,
    pdfBuffer,
  });

  const noticeRow = {
    claim_id:              claimId,
    notice_type:           'td_benefit',
    statutory_deadline:    deadline,
    recipient_name:        empName,
    recipient_address:     addr,
    generated_at:          now,
    pdf_storage_path:      storagePath,
    lob_letter_id:         lobResult.letterId,
    lob_sent_at:           now,
    lob_expected_delivery: lobResult.estimatedDelivery,
    lob_status:            lobResult.status,
    created_at:            now,
  };

  const { data: inserted, error } = await supabase
    .from('notices')
    .insert(noticeRow)
    .select()
    .single();

  if (error) {
    logger.error({ msg: 'noticeService.generateTdNotice: DB insert failed', err: error.message, claimId });
  }

  const noticeId = inserted?.id || `notice_td_${claimId}`;

  // ── Audit log — 7-year retention ───────────────────────────────────────────
  await _writeAuditLog(
    'notice_generated',
    'notice',
    noticeId,
    `TD benefit notice generated for claim ${claim.claimNumber || claimId} — TD rate ${fmt$(tdRate)}/wk — mailed to ${empName}`,
    { noticeType: 'td_benefit', claimId, tdRate, aww, lobLetterId: lobResult.letterId },
  );

  logger.info({ msg: 'noticeService.generateTdNotice: complete', claimId, noticeId, lobLetterId: lobResult.letterId });

  return {
    noticeId,
    noticeType:  'td_benefit',
    claimId,
    lobLetterId: lobResult.letterId,
    lobStatus:   lobResult.status,
    pdfSizeKb:   Math.round(pdfBuffer.length / 1024),
    pdfBuffer,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// generateRfaLetter — RFA Determination Letter
// ═════════════════════════════════════════════════════════════════════════════
//
// Per 8 CCR §9792.9.1: Written determination must be communicated to the
// requesting physician and injured worker. For approved RFAs, includes the
// authorized treatment. For denied/modified, includes rationale and IMR
// rights notice.
//
// The DWC I&A block is structurally included on the worker copy.

async function generateRfaLetter(rfaId) {
  // Lazy-require rfaService to avoid circular dep
  const rfaService = require('./rfaService');

  const rfa = await rfaService.getRFA(rfaId);
  if (!rfa) {
    logger.error({ msg: 'noticeService.generateRfaLetter: RFA not found', rfaId });
    return null;
  }

  const claimId = rfa.claim_id;
  const claim   = await _getClaimService().getClaim(claimId);
  if (!claim) {
    logger.error({ msg: 'noticeService.generateRfaLetter: claim not found', claimId, rfaId });
    return null;
  }

  const emp     = claim.employee || {};
  const empName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Injured Worker';
  const now     = new Date().toISOString();

  // Determine approval vs denial language
  const decision   = rfa.decision || 'pending';
  const isApproved = ['auto_approved', 'adjuster_approved'].includes(decision);
  const isDenied   = decision === 'denied';
  const decisionLabel = isApproved ? 'APPROVED' : isDenied ? 'DENIED' : decision.toUpperCase().replace(/_/g, ' ');

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = _drawLetterhead(page, fonts);

  // Date
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  page.drawText(today, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 24;

  // Recipient — requesting physician
  const physician = rfa.requesting_physician || 'Requesting Physician';
  page.drawText(physician, { x: MARGIN, y, size: 10, font: fonts.bold, color: DARK });
  y -= 13;
  if (rfa.requesting_npi) {
    page.drawText(`NPI: ${rfa.requesting_npi}`, { x: MARGIN, y, size: 9, font: fonts.regular, color: GRAY });
    y -= 13;
  }

  // CC line — worker copy
  page.drawText(`cc: ${empName} (injured worker)`, { x: MARGIN, y, size: 9, font: fonts.regular, color: GRAY });
  y -= 24;

  // Subject
  page.drawText(`Re: Utilization Review Determination — ${decisionLabel}`, {
    x: MARGIN, y, size: 11, font: fonts.bold, color: DARK,
  });
  y -= 14;
  page.drawText(`Claim No: ${claim.claimNumber || claim.id}  |  Patient: ${empName}  |  DOI: ${_formatDate(claim.dateOfInjury)}`, {
    x: MARGIN, y, size: 9, font: fonts.regular, color: DARK,
  });
  y -= 28;

  // Body
  const bodyLines = [
    `Dear ${physician},`,
    '',
    `This letter is to advise you of the utilization review determination regarding your`,
    `Request for Authorization (RFA) for the above-referenced patient.`,
    '',
    'REQUEST DETAILS:',
    `  Treatment:   ${rfa.treatment_description || 'See attached RFA'}`,
    `  CPT Codes:   ${(rfa.cpt_codes || []).join(', ') || 'N/A'}`,
    `  Urgency:     ${(rfa.urgency || 'standard').charAt(0).toUpperCase() + (rfa.urgency || 'standard').slice(1)}`,
    `  Received:    ${_formatDate(rfa.received_at || rfa.created_at)}`,
    '',
    `DETERMINATION: ${decisionLabel}`,
    '',
  ];

  if (isApproved) {
    bodyLines.push(
      'The requested treatment has been authorized. You may proceed with the treatment as',
      'described in the RFA. Please submit all billing in accordance with the Official',
      'Medical Fee Schedule (OMFS) within 45 days of service.',
    );
  } else if (isDenied) {
    bodyLines.push(
      'The requested treatment has been denied based on the Medical Treatment Utilization',
      'Schedule (MTUS) and applicable ACOEM guidelines.',
    );
    if (rfa.evaluation?.rationale) {
      bodyLines.push('', 'RATIONALE:', `  ${rfa.evaluation.rationale}`);
    }
    bodyLines.push(
      '',
      'INDEPENDENT MEDICAL REVIEW (IMR) RIGHTS:',
      '',
      'The injured worker or their representative may request an Independent Medical Review',
      '(IMR) of this decision within 30 days of receipt of this notice by contacting:',
      '',
      '  Maximus Federal — IMR',
      '  Phone: 1-888-845-7100',
      '  Website: www.dir.ca.gov/dwc/IMR.htm',
      '',
      'Per LC \u00A74610.5, an IMR application must be filed within 30 calendar days of the',
      'service of this denial notice. The IMR process is provided at no cost to the worker.',
    );
  } else {
    // sent_to_uro, deferred, adjuster_review, etc.
    bodyLines.push(
      `The RFA has been routed for additional review (status: ${decisionLabel}).`,
      'You will receive a final determination within the statutory timeframe.',
    );
  }

  bodyLines.push(
    '',
    'CLAIMS ADMINISTRATOR:',
    `  ${config.adjuster.name}  |  ${config.adjuster.phone}  |  ${config.adjuster.email}`,
    '',
    'Sincerely,',
    '',
    `${config.adjuster.name}`,
    'HomeCare TPA — Utilization Review',
    '',
  );

  for (const line of bodyLines) {
    if (y < 200) break;
    const isHeading = line === line.toUpperCase() && line.length > 2;
    page.drawText(line, {
      x: MARGIN, y,
      size: 9,
      font: isHeading ? fonts.bold : fonts.regular,
      color: DARK,
      maxWidth: PAGE_W - MARGIN * 2,
    });
    y -= 12;
  }

  // ── DWC I&A Block — structurally hardcoded, cannot be omitted ──────────────
  y = _drawIABlock(page, y, fonts);

  // Footer
  page.drawText(
    `Generated by HomeCare TPA — ${new Date().toLocaleDateString('en-US')} — Claim ${claim.claimNumber || claim.id}`,
    { x: MARGIN, y: 24, size: 6, font: fonts.regular, color: rgb(0.6, 0.6, 0.6) },
  );

  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);

  logger.info({
    msg:         'noticeService: RFA determination PDF generated',
    claimId,
    rfaId,
    decision,
    claimNumber: claim.claimNumber,
    sizeKb:      Math.round(pdfBuffer.length / 1024),
  });

  // ── Write notices row ──────────────────────────────────────────────────────
  const addr = emp.address
    ? `${emp.address.line1 || emp.address.addressLine1 || ''}, ${emp.address.city || ''}, ${emp.address.state || emp.address.countrySubdivisionCode || 'CA'} ${emp.address.postalCode || emp.address.zip || ''}`
    : 'Address on file';
  const storagePath = `notices/rfa_determination/${claimId}/${rfaId}_${Date.now()}.pdf`;

  const lobResult = await lobService.sendLetter('rfa_determination', claimId, 'claimant', {
    recipientName:    empName,
    recipientAddress: addr,
    pdfBuffer,
  });

  const noticeRow = {
    claim_id:              claimId,
    notice_type:           'rfa_determination',
    statutory_deadline:    rfa.response_due_at || null,
    recipient_name:        empName,
    recipient_address:     addr,
    generated_at:          now,
    pdf_storage_path:      storagePath,
    lob_letter_id:         lobResult.letterId,
    lob_sent_at:           now,
    lob_expected_delivery: lobResult.estimatedDelivery,
    lob_status:            lobResult.status,
    created_at:            now,
  };

  const { data: inserted, error } = await supabase
    .from('notices')
    .insert(noticeRow)
    .select()
    .single();

  if (error) {
    logger.error({ msg: 'noticeService.generateRfaLetter: DB insert failed', err: error.message, claimId, rfaId });
  }

  const noticeId = inserted?.id || `notice_rfa_${rfaId}`;

  // ── Audit log — 7-year retention ───────────────────────────────────────────
  await _writeAuditLog(
    'notice_generated',
    'notice',
    noticeId,
    `RFA determination letter (${decisionLabel}) generated for RFA ${rfaId} on claim ${claim.claimNumber || claimId}`,
    { noticeType: 'rfa_determination', claimId, rfaId, decision, lobLetterId: lobResult.letterId },
  );

  logger.info({ msg: 'noticeService.generateRfaLetter: complete', claimId, rfaId, noticeId, lobLetterId: lobResult.letterId });

  return {
    noticeId,
    noticeType:  'rfa_determination',
    claimId,
    rfaId,
    decision,
    lobLetterId: lobResult.letterId,
    lobStatus:   lobResult.status,
    pdfSizeKb:   Math.round(pdfBuffer.length / 1024),
    pdfBuffer,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// generateImrRightsNotice — Independent Medical Review Rights Notice
// ═════════════════════════════════════════════════════════════════════════════
//
// Per LC §4610.5: When a UR denial or modification is issued, the claims
// administrator must provide written notice to the injured worker advising
// them of the right to request an IMR within 30 calendar days of service.
// Triggered by _routeToEnlyte (URO denial path) in rfaService.
//
// The DWC I&A block is structurally included.

async function generateImrRightsNotice(rfaId) {
  const rfaService = require('./rfaService');

  const rfa = await rfaService.getRFA(rfaId);
  if (!rfa) {
    logger.error({ msg: 'noticeService.generateImrRightsNotice: RFA not found', rfaId });
    return null;
  }

  const claimId = rfa.claim_id;
  const claim   = await _getClaimService().getClaim(claimId);
  if (!claim) {
    logger.error({ msg: 'noticeService.generateImrRightsNotice: claim not found', claimId, rfaId });
    return null;
  }

  const emp     = claim.employee || {};
  const empName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Injured Worker';
  const now     = new Date().toISOString();

  // 30 calendar day IMR filing deadline from service of this notice
  const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = _drawLetterhead(page, fonts);

  // Date
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  page.drawText(today, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 24;

  // Recipient
  const addr = emp.address
    ? `${emp.address.line1 || emp.address.addressLine1 || ''}, ${emp.address.city || ''}, ${emp.address.state || emp.address.countrySubdivisionCode || 'CA'} ${emp.address.postalCode || emp.address.zip || ''}`
    : 'Address on file';
  page.drawText(empName, { x: MARGIN, y, size: 10, font: fonts.bold, color: DARK });
  y -= 13;
  page.drawText(addr, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 30;

  // Subject
  page.drawText('Re: Notice of Independent Medical Review (IMR) Rights — IMPORTANT', {
    x: MARGIN, y, size: 11, font: fonts.bold, color: DARK,
  });
  y -= 14;
  page.drawText(`Claim No: ${claim.claimNumber || claim.id}  |  DOI: ${_formatDate(claim.dateOfInjury)}`, {
    x: MARGIN, y, size: 9, font: fonts.regular, color: DARK,
  });
  y -= 28;

  const bodyLines = [
    `Dear ${emp.firstName || 'Injured Worker'},`,
    '',
    'Your claims administrator has issued a utilization review (UR) determination that',
    'denied or modified a request for medical treatment in connection with your claim.',
    'You have the right to challenge this decision through an Independent Medical Review',
    '(IMR) — a process established by California Labor Code \u00A74610.5.',
    '',
    'WHAT IS INDEPENDENT MEDICAL REVIEW (IMR)?',
    '',
    'IMR is an independent review of the UR denial/modification by a qualified medical',
    'reviewer selected by the Administrative Director of the DWC. The reviewing physician',
    'is not affiliated with the claims administrator or treating physician.',
    '',
    'HOW TO REQUEST AN IMR:',
    '',
    '  \u2022 You must request IMR within 30 CALENDAR DAYS of service of this notice.',
    `  \u2022 Deadline to file: ${_formatDate(deadline)}`,
    '',
    '  Contact Maximus Federal to initiate your IMR request:',
    '',
    '  Maximus Federal Services — IMR Division',
    '  Phone:    1-888-845-7100 (toll-free)',
    '  Fax:      1-888-845-7101',
    '  Website:  www.dir.ca.gov/dwc/IMR.htm',
    '  Mail:     Maximus Federal, P.O. Box 24490, Oakland, CA 94623',
    '',
    'THE IMR PROCESS IS FREE — there is no cost to you as the injured worker.',
    '',
    'REQUEST DETAILS:',
    `  Treatment Requested: ${rfa.treatment_description || 'See RFA on file'}`,
    `  CPT Codes:           ${(rfa.cpt_codes || []).join(', ') || 'N/A'}`,
    `  UR Decision:         ${(rfa.decision || 'denied').toUpperCase().replace(/_/g, ' ')}`,
    `  UR Decision Date:    ${_formatDate(rfa.decision_made_at || rfa.updated_at)}`,
    '',
    'WHAT HAPPENS NEXT:',
    '',
    'After Maximus Federal receives your request, the medical reviewer has 30 business days',
    '(or 3 business days for expedited requests) to issue a determination. If the IMR',
    'upholds the UR denial, you may appeal to the Workers\' Compensation Appeals Board.',
    '',
    'CLAIMS ADMINISTRATOR:',
    `  ${config.adjuster.name}  |  ${config.adjuster.phone}  |  ${config.adjuster.email}`,
    '',
  ];

  for (const line of bodyLines) {
    if (y < 200) break;
    const isHeading = line === line.toUpperCase() && line.length > 2;
    page.drawText(line, {
      x: MARGIN, y,
      size: 9,
      font: isHeading ? fonts.bold : fonts.regular,
      color: DARK,
      maxWidth: PAGE_W - MARGIN * 2,
    });
    y -= 12;
  }

  // ── DWC I&A Block — structurally hardcoded, cannot be omitted ──────────────
  y = _drawIABlock(page, y, fonts);

  // Footer
  page.drawText(
    `Generated by HomeCare TPA — ${new Date().toLocaleDateString('en-US')} — Claim ${claim.claimNumber || claim.id}`,
    { x: MARGIN, y: 24, size: 6, font: fonts.regular, color: rgb(0.6, 0.6, 0.6) },
  );

  const pdfBytes  = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);

  logger.info({
    msg:         'noticeService: IMR rights PDF generated',
    claimId,
    rfaId,
    claimNumber: claim.claimNumber,
    sizeKb:      Math.round(pdfBuffer.length / 1024),
  });

  // ── Write notices row ──────────────────────────────────────────────────────
  const storagePath = `notices/imr_rights/${claimId}/${rfaId}_${Date.now()}.pdf`;

  const lobResult = await lobService.sendLetter('imr_rights', claimId, 'claimant', {
    recipientName:    empName,
    recipientAddress: addr,
    pdfBuffer,
  });

  const noticeRow = {
    claim_id:              claimId,
    notice_type:           'imr_rights',
    statutory_deadline:    deadline,
    recipient_name:        empName,
    recipient_address:     addr,
    generated_at:          now,
    pdf_storage_path:      storagePath,
    lob_letter_id:         lobResult.letterId,
    lob_sent_at:           now,
    lob_expected_delivery: lobResult.estimatedDelivery,
    lob_status:            lobResult.status,
    created_at:            now,
  };

  const { data: inserted, error } = await supabase
    .from('notices')
    .insert(noticeRow)
    .select()
    .single();

  if (error) {
    logger.error({ msg: 'noticeService.generateImrRightsNotice: DB insert failed', err: error.message, claimId, rfaId });
  }

  const noticeId = inserted?.id || `notice_imr_${rfaId}`;

  // ── Audit log — 7-year retention ───────────────────────────────────────────
  await _writeAuditLog(
    'notice_generated',
    'notice',
    noticeId,
    `IMR rights notice generated for RFA ${rfaId} on claim ${claim.claimNumber || claimId} — 30-day deadline ${_formatDate(deadline)}`,
    { noticeType: 'imr_rights', claimId, rfaId, imrDeadline: deadline, lobLetterId: lobResult.letterId },
  );

  logger.info({ msg: 'noticeService.generateImrRightsNotice: complete', claimId, rfaId, noticeId, lobLetterId: lobResult.letterId });

  return {
    noticeId,
    noticeType:   'imr_rights',
    claimId,
    rfaId,
    imrDeadline:  deadline,
    lobLetterId:  lobResult.letterId,
    lobStatus:    lobResult.status,
    pdfSizeKb:    Math.round(pdfBuffer.length / 1024),
    pdfBuffer,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// generateDenialNotice — Claim Denial Notice
// ═════════════════════════════════════════════════════════════════════════════
//
// MANUAL TRIGGER ONLY — never auto-generated.
//
// A hard guard at the top of this function enforces that adjusterId must be
// provided. Any call path that omits adjusterId (e.g. an accidental system
// trigger) will throw synchronously before any PDF or DB work occurs.
//
// Per 8 CCR §10089.23 and LC §5402: Written denial must explain the basis
// for denial and advise the worker of WCAB appeal rights.
//
// The DWC I&A block is structurally included.

async function generateDenialNotice(claimId, adjusterId) {
  // ── HARD GUARD — manual only ───────────────────────────────────────────────
  // This notice may never be auto-triggered. adjusterId must be an explicit
  // human adjuster identifier from an authenticated admin action.
  if (!adjusterId || typeof adjusterId !== 'string' || !adjusterId.trim()) {
    throw new Error(
      'generateDenialNotice: adjusterId is required — denial notices are manual-only and ' +
      'cannot be auto-triggered by the system. Provide the authenticated adjuster email or ID.',
    );
  }

  const claim = await _getClaimService().getClaim(claimId);
  if (!claim) {
    logger.error({ msg: 'noticeService.generateDenialNotice: claim not found', claimId });
    return null;
  }

  const emp     = claim.employee || {};
  const empName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || 'Injured Worker';
  const now     = new Date().toISOString();

  // No statutory deadline on the notice itself — WCAB appeal window starts
  // from service date (computed by recipient on receipt)
  const wcabDeadline = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = _drawLetterhead(page, fonts);

  // Date
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  page.drawText(today, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 24;

  // Recipient
  const addr = emp.address
    ? `${emp.address.line1 || emp.address.addressLine1 || ''}, ${emp.address.city || ''}, ${emp.address.state || emp.address.countrySubdivisionCode || 'CA'} ${emp.address.postalCode || emp.address.zip || ''}`
    : 'Address on file';
  page.drawText(empName, { x: MARGIN, y, size: 10, font: fonts.bold, color: DARK });
  y -= 13;
  page.drawText(addr, { x: MARGIN, y, size: 10, font: fonts.regular, color: DARK });
  y -= 30;

  // Subject
  page.drawText('Re: Notice of Denial of Workers\' Compensation Claim', {
    x: MARGIN, y, size: 11, font: fonts.bold, color: DARK,
  });
  y -= 14;
  page.drawText(`Claim No: ${claim.claimNumber || claim.id}  |  Date of Injury: ${_formatDate(claim.dateOfInjury)}`, {
    x: MARGIN, y, size: 9, font: fonts.regular, color: DARK,
  });
  y -= 28;

  const bodyLines = [
    `Dear ${emp.firstName || 'Injured Worker'},`,
    '',
    'We have completed our investigation of your workers\' compensation claim referenced',
    'above. Based upon our investigation, we have determined that your claim for workers\'',
    'compensation benefits is DENIED.',
    '',
    'BASIS FOR DENIAL:',
    '',
    'After a thorough investigation, we have determined that the claimed injury does not',
    'meet the requirements for compensability under California workers\' compensation law.',
    'Specific grounds for denial were reviewed and authorized by the undersigned adjuster.',
    '',
    'YOUR RIGHTS — WORKERS\' COMPENSATION APPEALS BOARD (WCAB):',
    '',
    'You have the right to dispute this denial by filing an Application for Adjudication',
    'of Claim with the Workers\' Compensation Appeals Board (WCAB). You must file within',
    'the applicable statute of limitations:',
    '',
    '  \u2022 One (1) year from date of injury for most claims (LC \u00A75405)',
    '  \u2022 One (1) year from last date of benefits if benefits were provided',
    '',
    'To file with the WCAB:',
    '  Phone:    1-800-736-7401 (WCAB recorded information)',
    '  Website:  www.dir.ca.gov/dwc/wcab.html',
    '  Office:   Find your local WCAB district office at the website above',
    '',
    'EMPLOYER INFORMATION:',
    `  Employer:  ${claim.employerName || 'On file'}`,
    `  Claim No:  ${claim.claimNumber || claim.id}`,
    `  DOI:       ${_formatDate(claim.dateOfInjury)}`,
    '',
    'ADJUSTER INFORMATION:',
    `  Authorized by: ${adjusterId}`,
    `  Name:          ${config.adjuster.name}`,
    `  Phone:         ${config.adjuster.phone}`,
    `  Email:         ${config.adjuster.email}`,
    '',
  ];

  for (const line of bodyLines) {
    if (y < 200) break;
    const isHeading = line === line.toUpperCase() && line.length > 2;
    page.drawText(line, {
      x: MARGIN, y,
      size: 9,
      font: isHeading ? fonts.bold : fonts.regular,
      color: DARK,
      maxWidth: PAGE_W - MARGIN * 2,
    });
    y -= 12;
  }

  // ── DWC I&A Block — structurally hardcoded, cannot be omitted ──────────────
  y = _drawIABlock(page, y, fonts);

  // Footer
  page.drawText(
    `Generated by HomeCare TPA — ${new Date().toLocaleDateString('en-US')} — Claim ${claim.claimNumber || claim.id} — Authorized by: ${adjusterId}`,
    { x: MARGIN, y: 24, size: 6, font: fonts.regular, color: rgb(0.6, 0.6, 0.6) },
  );

  const pdfBytes  = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);

  logger.info({
    msg:         'noticeService: denial notice PDF generated',
    claimId,
    adjusterId,
    claimNumber: claim.claimNumber,
    sizeKb:      Math.round(pdfBuffer.length / 1024),
  });

  // ── Write notices row ──────────────────────────────────────────────────────
  const storagePath = `notices/denial/${claimId}/${Date.now()}.pdf`;

  const lobResult = await lobService.sendLetter('denial', claimId, 'claimant', {
    recipientName:    empName,
    recipientAddress: addr,
    pdfBuffer,
  });

  const noticeRow = {
    claim_id:              claimId,
    notice_type:           'denial',
    statutory_deadline:    null,
    recipient_name:        empName,
    recipient_address:     addr,
    generated_at:          now,
    pdf_storage_path:      storagePath,
    lob_letter_id:         lobResult.letterId,
    lob_sent_at:           now,
    lob_expected_delivery: lobResult.estimatedDelivery,
    lob_status:            lobResult.status,
    created_at:            now,
  };

  const { data: inserted, error } = await supabase
    .from('notices')
    .insert(noticeRow)
    .select()
    .single();

  if (error) {
    logger.error({ msg: 'noticeService.generateDenialNotice: DB insert failed', err: error.message, claimId });
  }

  const noticeId = inserted?.id || `notice_denial_${claimId}`;

  // ── Audit log — 7-year retention ───────────────────────────────────────────
  await _writeAuditLog(
    'notice_generated',
    'notice',
    noticeId,
    `Denial notice generated for claim ${claim.claimNumber || claimId} — authorized by adjuster ${adjusterId}`,
    { noticeType: 'denial', claimId, adjusterId, lobLetterId: lobResult.letterId },
  );

  logger.info({ msg: 'noticeService.generateDenialNotice: complete', claimId, adjusterId, noticeId, lobLetterId: lobResult.letterId });

  return {
    noticeId,
    noticeType:  'denial',
    claimId,
    adjusterId,
    lobLetterId: lobResult.letterId,
    lobStatus:   lobResult.status,
    pdfSizeKb:   Math.round(pdfBuffer.length / 1024),
    pdfBuffer,
  };
}

module.exports = { generateDwc7, generateTdNotice, generateRfaLetter, generateImrRightsNotice, generateDenialNotice };
