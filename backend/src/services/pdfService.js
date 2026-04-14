'use strict';

/**
 * pdfService.js — Server-side PDF generation for regulated WC documents.
 *
 * generateDWC1(): Builds a DWC-1-structured PDF using pdf-lib.
 *
 * PRODUCTION NOTE: Replace the from-scratch builder here with the official
 * DWC AcroForm PDF from dir.ca.gov/dwc/forms.html once it is committed to
 * backend/assets/forms/dwc1_acroform.pdf. Use PDFDocument.load() + getForm()
 * to fill the official AcroForm fields. The current implementation produces
 * a correctly structured document but is not the prescribed DWC form.
 *
 * Per 8 CCR §10110.1, the DWC-1 must use the current official DWC version.
 * Always verify the revision date at dir.ca.gov before committing the form.
 */

const { PDFDocument, rgb, StandardFonts, PDFString } = require('pdf-lib');
const logger = require('../logger');

// ── Color palette ─────────────────────────────────────────────────────────────
const DARK   = rgb(0.1, 0.1, 0.1);
const GRAY   = rgb(0.4, 0.4, 0.4);
const BLUE   = rgb(0.0, 0.27, 0.55);
const LINE   = rgb(0.75, 0.75, 0.75);
const FIELD_BG = rgb(0.97, 0.97, 0.97);

// ── Layout constants ──────────────────────────────────────────────────────────
const PAGE_W = 612;   // US Letter width in points
const PAGE_H = 792;   // US Letter height in points
const MARGIN = 48;
const COL_W  = (PAGE_W - MARGIN * 2 - 12) / 2;

// ── Helpers ───────────────────────────────────────────────────────────────────
function drawLine(page, x1, y, x2, color = LINE) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color });
}

function drawFieldBox(page, x, y, w, h, label, value, fonts, fontSize = 9) {
  // Background
  page.drawRectangle({ x, y, width: w, height: h, color: FIELD_BG, borderColor: LINE, borderWidth: 0.5 });
  // Label
  page.drawText(label, { x: x + 4, y: y + h - 10, size: 7, font: fonts.regular, color: GRAY });
  // Value
  if (value) {
    page.drawText(String(value).slice(0, 60), { x: x + 4, y: y + 6, size: fontSize, font: fonts.bold, color: DARK });
  }
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

// ── generateDWC1 ──────────────────────────────────────────────────────────────
/**
 * Generates a DWC-1 workers' compensation claim form as a PDF buffer.
 *
 * @param {object} claim     Claim record from claimService / DB
 * @param {object} employee  Employee record (ADP demographics)
 * @param {object} employer  Employer record
 * @returns {Buffer}         PDF bytes
 */
async function generateDWC1(claim, employee, employer) {
  const start = Date.now();
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);

  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = PAGE_H - MARGIN;

  // ── Header ────────────────────────────────────────────────────────────────
  page.drawText('STATE OF CALIFORNIA — DEPARTMENT OF INDUSTRIAL RELATIONS', {
    x: MARGIN, y, size: 7.5, font: fonts.regular, color: GRAY,
  });
  y -= 11;

  page.drawText('WORKERS\' COMPENSATION CLAIM FORM (DWC 1)', {
    x: MARGIN, y, size: 15, font: fonts.bold, color: BLUE,
  });
  y -= 5;
  drawLine(page, MARGIN, y, PAGE_W - MARGIN, BLUE);
  y -= 5;

  page.drawText('& Notice of Potential Eligibility', {
    x: MARGIN, y, size: 9, font: fonts.regular, color: GRAY,
  });
  page.drawText(`Claim No: ${claim.claimNumber || claim.id}`, {
    x: PAGE_W - MARGIN - 160, y, size: 9, font: fonts.bold, color: DARK,
  });
  y -= 4;
  page.drawText('Employee: Complete the "Employee" section and give the form to your employer.', {
    x: MARGIN, y, size: 7.5, font: fonts.regular, color: GRAY,
  });
  y -= 14;

  // ── EMPLOYEE section header ────────────────────────────────────────────────
  page.drawRectangle({ x: MARGIN, y: y - 14, width: PAGE_W - MARGIN * 2, height: 16,
    color: BLUE });
  page.drawText('EMPLOYEE — Complete this section and sign', {
    x: MARGIN + 4, y: y - 10, size: 9, font: fonts.bold, color: rgb(1,1,1),
  });
  y -= 28;

  // Row 1: Name + DOB + Phone
  const fh = 30;
  drawFieldBox(page, MARGIN,           y - fh, COL_W,      fh, 'Last Name',
    employee?.lastName || employee?.last_name, fonts);
  drawFieldBox(page, MARGIN + COL_W + 12, y - fh, COL_W * 0.55, fh, 'First Name',
    employee?.firstName || employee?.first_name, fonts);
  drawFieldBox(page, MARGIN + COL_W + 12 + COL_W * 0.55 + 8, y - fh, COL_W * 0.42, fh, 'Date of Birth',
    formatDate(employee?.dob), fonts);
  y -= fh + 6;

  // Row 2: Address
  drawFieldBox(page, MARGIN, y - fh, PAGE_W - MARGIN * 2, fh, 'Home Address',
    employee?.address?.addressLine1 || employee?.address_line1, fonts);
  y -= fh + 6;

  // Row 3: City / State / Zip / Phone
  const cityW = COL_W * 0.55;
  const stW   = 50;
  const zipW  = 80;
  const phW   = PAGE_W - MARGIN * 2 - cityW - stW - zipW - 24;
  drawFieldBox(page, MARGIN,                 y - fh, cityW, fh, 'City', employee?.address?.city || employee?.address_city, fonts);
  drawFieldBox(page, MARGIN + cityW + 8,     y - fh, stW,   fh, 'State', employee?.address?.countrySubdivisionCode || 'CA', fonts);
  drawFieldBox(page, MARGIN + cityW + stW + 16, y - fh, zipW, fh, 'ZIP', employee?.address?.postalCode || employee?.address_zip, fonts);
  drawFieldBox(page, MARGIN + cityW + stW + zipW + 24, y - fh, phW, fh, 'Phone', employee?.phone, fonts);
  y -= fh + 6;

  // Row 4: Date of Injury + Time + Occupation
  drawFieldBox(page, MARGIN, y - fh, 130, fh, 'Date of Injury', formatDate(claim.dateOfInjury), fonts);
  drawFieldBox(page, MARGIN + 138, y - fh, 90, fh, 'Time of Injury', claim.timeOfInjury || '', fonts);
  drawFieldBox(page, MARGIN + 236, y - fh, PAGE_W - MARGIN * 2 - 236, fh, 'Occupation / Job Title',
    employee?.jobTitle, fonts);
  y -= fh + 6;

  // Row 5: Injury Description (tall)
  const descH = 48;
  drawFieldBox(page, MARGIN, y - descH, PAGE_W - MARGIN * 2, descH,
    'Describe how the injury/illness happened. List body parts affected.',
    claim.injuryDescription, fonts, 8.5);
  y -= descH + 6;

  // Row 6: Body part + Injury type
  drawFieldBox(page, MARGIN, y - fh, COL_W, fh, 'Part of Body Injured', claim.bodyPart, fonts);
  drawFieldBox(page, MARGIN + COL_W + 12, y - fh, COL_W, fh, 'Nature of Injury / Illness', claim.injuryType, fonts);
  y -= fh + 6;

  // Prior claims checkbox area
  page.drawText('Did you have an injury or illness in the past 12 months?', {
    x: MARGIN, y, size: 8, font: fonts.regular, color: DARK,
  });
  page.drawRectangle({ x: MARGIN + 240, y: y - 2, width: 10, height: 10,
    borderColor: DARK, borderWidth: 0.7, color: rgb(1,1,1) });
  page.drawText('Yes', { x: MARGIN + 253, y, size: 8, font: fonts.regular, color: DARK });
  page.drawRectangle({ x: MARGIN + 278, y: y - 2, width: 10, height: 10,
    borderColor: DARK, borderWidth: 0.7, color: rgb(1,1,1) });
  page.drawText('No', { x: MARGIN + 291, y, size: 8, font: fonts.regular, color: DARK });
  y -= 20;

  // Signature line
  drawLine(page, MARGIN, y, MARGIN + 200);
  drawLine(page, MARGIN + 220, y, MARGIN + 360);
  page.drawText('Employee Signature', { x: MARGIN, y: y - 10, size: 7, font: fonts.regular, color: GRAY });
  page.drawText('Date', { x: MARGIN + 220, y: y - 10, size: 7, font: fonts.regular, color: GRAY });
  y -= 28;

  // ── EMPLOYER section header ────────────────────────────────────────────────
  page.drawRectangle({ x: MARGIN, y: y - 14, width: PAGE_W - MARGIN * 2, height: 16, color: BLUE });
  page.drawText('EMPLOYER — Complete this section', {
    x: MARGIN + 4, y: y - 10, size: 9, font: fonts.bold, color: rgb(1,1,1),
  });
  y -= 28;

  drawFieldBox(page, MARGIN, y - fh, PAGE_W - MARGIN * 2, fh, 'Employer Name', employer?.name || claim.employerName, fonts);
  y -= fh + 6;

  drawFieldBox(page, MARGIN, y - fh, PAGE_W - MARGIN * 2, fh, 'Employer Address',
    employer?.address_line1 ? `${employer.address_line1}, ${employer.city}, ${employer.state} ${employer.zip}` : '', fonts);
  y -= fh + 6;

  drawFieldBox(page, MARGIN, y - fh, 180, fh, 'Employer Phone', employer?.phone, fonts);
  drawFieldBox(page, MARGIN + 188, y - fh, 140, fh, 'Date Employer Notified', formatDate(claim.createdAt), fonts);
  drawFieldBox(page, MARGIN + 336, y - fh, PAGE_W - MARGIN * 2 - 336, fh, 'Date Claim Form Given to Employee', '', fonts);
  y -= fh + 6;

  // Employer signature
  drawLine(page, MARGIN, y, MARGIN + 200);
  drawLine(page, MARGIN + 220, y, MARGIN + 360);
  page.drawText('Employer Representative Signature', { x: MARGIN, y: y - 10, size: 7, font: fonts.regular, color: GRAY });
  page.drawText('Date', { x: MARGIN + 220, y: y - 10, size: 7, font: fonts.regular, color: GRAY });
  y -= 28;

  // ── Footer / rights notice ────────────────────────────────────────────────
  drawLine(page, MARGIN, y, PAGE_W - MARGIN);
  y -= 10;
  const footerLines = [
    'You have the right to receive free information about workers\' compensation from your employer, a claims administrator, or the DWC Information & Assistance Unit.',
    'If your claim is denied, you have the right to have this decision reviewed by the Workers\' Compensation Appeals Board (WCAB).',
    'You have the right to receive medical treatment reasonably required to cure or relieve the effects of your injury.',
    'LC §5401 — This form must be provided to the employee within one working day of receiving notice of injury.',
  ];
  for (const line of footerLines) {
    page.drawText(line, { x: MARGIN, y, size: 6.5, font: fonts.regular, color: GRAY, maxWidth: PAGE_W - MARGIN * 2 });
    y -= 9;
  }
  y -= 4;
  page.drawText(
    `Generated by HomeCare TPA — ${new Date().toLocaleDateString('en-US')} — Claim ${claim.claimNumber || claim.id}`,
    { x: MARGIN, y, size: 6, font: fonts.regular, color: rgb(0.6, 0.6, 0.6) }
  );

  const pdfBytes = await pdfDoc.save();
  const buffer = Buffer.from(pdfBytes);

  logger.info({
    msg:         'pdfService: DWC-1 generated',
    claimId:     claim.id,
    claimNumber: claim.claimNumber,
    sizeKb:      Math.round(buffer.length / 1024),
    latencyMs:   Date.now() - start,
  });

  return buffer;
}

// ── generateAuthorizationLetter ───────────────────────────────────────────────
/**
 * Generates a plain WC treatment authorization letter for the provider.
 *
 * @param {object} opts  { claimNumber, employeeName, dateOfInjury, bodyPart,
 *                         providerName, providerAddress, appointmentDate,
 *                         adjusterName, adjusterPhone, adjusterEmail }
 * @returns {Buffer}
 */
async function generateAuthorizationLetter(opts) {
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const reg    = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  let y = PAGE_H - MARGIN;

  // Letterhead
  page.drawText('HomeCare TPA', { x: MARGIN, y, size: 18, font: bold, color: BLUE });
  y -= 14;
  page.drawText('Workers\' Compensation Administration', { x: MARGIN, y, size: 9, font: reg, color: GRAY });
  y -= 9;
  page.drawText('claims@homecaretpa.com  |  (800) XXX-XXXX', { x: MARGIN, y, size: 8, font: reg, color: GRAY });
  y -= 4;
  drawLine(page, MARGIN, y, PAGE_W - MARGIN, BLUE);
  y -= 20;

  page.drawText(today, { x: MARGIN, y, size: 10, font: reg, color: DARK });
  y -= 24;

  // Provider address block
  page.drawText(opts.providerName || '', { x: MARGIN, y, size: 10, font: bold, color: DARK });
  y -= 13;
  page.drawText(opts.providerAddress || '', { x: MARGIN, y, size: 10, font: reg, color: DARK });
  y -= 30;

  page.drawText(`Re: Authorization for Workers\' Compensation Treatment`, { x: MARGIN, y, size: 11, font: bold, color: DARK });
  y -= 14;
  page.drawText(`Claim No: ${opts.claimNumber}  |  Patient: ${opts.employeeName}`, { x: MARGIN, y, size: 10, font: reg, color: DARK });
  y -= 30;

  const bodyLines = [
    `Dear Provider,`,
    '',
    `This letter serves as authorization for workers' compensation medical treatment for the above-referenced claimant.`,
    '',
    `Date of Injury:    ${formatDate(opts.dateOfInjury)}`,
    `Body Part(s):      ${opts.bodyPart || 'As noted in evaluation'}`,
    `Authorized Care:   Initial evaluation and treatment as medically necessary`,
    opts.appointmentDate ? `Appointment Date:  ${new Date(opts.appointmentDate).toLocaleDateString('en-US')}` : '',
    '',
    `Please direct all correspondence, bills, and reports to:`,
    `  Adjuster: ${opts.adjusterName || 'HomeCare TPA'}`,
    `  Phone:    ${opts.adjusterPhone || '(800) XXX-XXXX'}`,
    `  Email:    ${opts.adjusterEmail || 'claims@homecaretpa.com'}`,
    '',
    `All treatment should be provided in accordance with the Official Medical Fee Schedule (OMFS) and the`,
    `Medical Treatment Utilization Schedule (MTUS). Submit all bills and reports within 45 days of service.`,
    '',
    `Sincerely,`,
    '',
    '',
    `${opts.adjusterName || 'Claims Adjuster'}`,
    `HomeCare TPA — Workers\' Compensation Administration`,
  ];

  for (const line of bodyLines) {
    page.drawText(line, { x: MARGIN, y, size: 10, font: reg, color: DARK, maxWidth: PAGE_W - MARGIN * 2 });
    y -= 14;
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ── generateReasoningPDF ──────────────────────────────────────────────────────
/**
 * Generates an AI Reasoning PDF for adjuster review.
 *
 * @param {object} claim  Claim record including aiAnalysis
 * @returns {Buffer}      PDF bytes
 */
async function generateReasoningPDF(claim) {
  const start  = Date.now();
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([PAGE_W, PAGE_H]);

  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  const a   = claim.aiAnalysis;
  const emp = claim.employee || {};
  let y     = PAGE_H - MARGIN;

  // ── Header bar ────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: PAGE_H - 36, width: PAGE_W, height: 36,
    color: rgb(0.039, 0.086, 0.133) });
  page.drawRectangle({ x: 0, y: PAGE_H - 36, width: 4, height: 36,
    color: rgb(0.961, 0.620, 0.043) });

  page.drawText('HomeCare TPA — AI Reasoning Document', {
    x: 12, y: PAGE_H - 22, size: 13, font: fonts.bold, color: rgb(0.961, 0.620, 0.043),
  });
  const sub = `${claim.claimNumber || claim.id}  |  ${emp.firstName || ''} ${emp.lastName || ''}  |  ${claim.employerName || ''}`;
  page.drawText(sub.trim(), {
    x: 12, y: PAGE_H - 34, size: 7, font: fonts.regular, color: rgb(0.624, 0.706, 0.753),
  });
  page.drawText(`Generated: ${new Date().toLocaleString()}`, {
    x: PAGE_W - MARGIN - 120, y: PAGE_H - 34, size: 7, font: fonts.regular, color: rgb(0.624, 0.706, 0.753),
  });

  y = PAGE_H - 56;

  if (!a) {
    page.drawText('No AI analysis on file.', { x: MARGIN, y, size: 11, font: fonts.regular, color: DARK });
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  // ── Compensability / Score / Priority row ─────────────────────────────────
  const cardW = (PAGE_W - MARGIN * 2 - 16) / 3;
  const cards = [
    ['Compensability', a.compensability || '—'],
    ['Score',          `${a.compensabilityScore ?? '—'}%`],
    ['Priority',       a.priority || '—'],
  ];
  cards.forEach(([label, value], i) => {
    const cx = MARGIN + i * (cardW + 8);
    page.drawRectangle({ x: cx, y: y - 32, width: cardW, height: 34,
      color: FIELD_BG, borderColor: LINE, borderWidth: 0.5 });
    page.drawText(label.toUpperCase(), { x: cx + 5, y: y + 0, size: 7, font: fonts.regular, color: GRAY });
    page.drawText(String(value), { x: cx + 5, y: y - 20, size: 11, font: fonts.bold, color: DARK });
  });
  y -= 46;

  // ── Reserves ──────────────────────────────────────────────────────────────
  drawLine(page, MARGIN, y, PAGE_W - MARGIN);
  y -= 12;
  page.drawText('SUGGESTED RESERVES', { x: MARGIN, y, size: 8, font: fonts.bold, color: BLUE });
  y -= 12;
  const fmt$ = (n) => (n != null ? `$${Number(n).toLocaleString()}` : '—');
  const resItems = [
    ['Medical',   fmt$(a.suggestedMedicalReserve)],
    ['Indemnity', fmt$(a.suggestedIndemnityReserve)],
    ['Expense',   fmt$(a.suggestedExpenseReserve)],
    ['Total',     fmt$((a.suggestedMedicalReserve || 0) + (a.suggestedIndemnityReserve || 0) + (a.suggestedExpenseReserve || 0))],
  ];
  resItems.forEach(([label, value], i) => {
    page.drawText(`${label}:`, { x: MARGIN + i * 120, y, size: 9, font: fonts.regular, color: GRAY });
    page.drawText(value, { x: MARGIN + i * 120 + 52, y, size: 9, font: fonts.bold, color: DARK });
  });
  y -= 18;

  // ── Red flags ─────────────────────────────────────────────────────────────
  if (a.redFlags?.length) {
    drawLine(page, MARGIN, y, PAGE_W - MARGIN);
    y -= 12;
    page.drawText('RED FLAGS', { x: MARGIN, y, size: 8, font: fonts.bold, color: rgb(0.941, 0.251, 0.251) });
    y -= 10;
    for (const flag of a.redFlags) {
      const lines = wrapText(`[!] ${flag}`, PAGE_W - MARGIN * 2 - 10, fonts.regular, 9);
      for (const ln of lines) {
        if (y < 80) break;
        page.drawText(ln, { x: MARGIN + 5, y, size: 9, font: fonts.regular, color: rgb(0.972, 0.443, 0.443) });
        y -= 12;
      }
      y -= 3;
    }
  }

  // ── Next actions ──────────────────────────────────────────────────────────
  if (a.nextActions?.length) {
    drawLine(page, MARGIN, y, PAGE_W - MARGIN);
    y -= 12;
    page.drawText('RECOMMENDED ACTIONS', { x: MARGIN, y, size: 8, font: fonts.bold, color: BLUE });
    y -= 10;
    a.nextActions.forEach((act, i) => {
      const lines = wrapText(`${i + 1}. ${act}`, PAGE_W - MARGIN * 2 - 5, fonts.regular, 9);
      for (const ln of lines) {
        if (y < 80) break;
        page.drawText(ln, { x: MARGIN + 5, y, size: 9, font: fonts.regular, color: DARK });
        y -= 12;
      }
      y -= 3;
    });
  }

  // ── Rationale / analysis notes ────────────────────────────────────────────
  if (a.analysisNotes || a.rationale) {
    const notes = a.analysisNotes || a.rationale;
    drawLine(page, MARGIN, y, PAGE_W - MARGIN);
    y -= 12;
    page.drawText('AI RATIONALE', { x: MARGIN, y, size: 8, font: fonts.bold, color: GRAY });
    y -= 10;
    const lines = wrapText(notes, PAGE_W - MARGIN * 2, fonts.regular, 8.5);
    for (const ln of lines) {
      if (y < 80) break;
      page.drawText(ln, { x: MARGIN, y, size: 8.5, font: fonts.regular, color: GRAY });
      y -= 11;
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  page.drawText(
    'AI analysis is advisory. Final authority rests with the supervising adjuster per 8 CCR §10101.',
    { x: MARGIN, y: 24, size: 6.5, font: fonts.regular, color: GRAY }
  );

  const pdfBytes = await pdfDoc.save();
  const buffer   = Buffer.from(pdfBytes);

  logger.info({
    msg:         'pdfService: reasoning PDF generated',
    claimId:     claim.id,
    claimNumber: claim.claimNumber,
    sizeKb:      Math.round(buffer.length / 1024),
    latencyMs:   Date.now() - start,
  });

  return buffer;
}

/**
 * Simple word-wrap helper for pdf-lib (no built-in wrap support).
 * Returns an array of strings each fitting within maxWidth (approximate).
 */
function wrapText(text, maxWidth, font, size) {
  const words  = (text || '').split(' ');
  const lines  = [];
  let current  = '';
  const maxCh  = Math.floor(maxWidth / (size * 0.52)); // rough char estimate
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

module.exports = { generateDWC1, generateAuthorizationLetter, generateReasoningPDF };
