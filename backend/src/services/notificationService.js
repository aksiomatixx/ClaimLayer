'use strict';

/**
 * notificationService.js — Employee-facing notifications.
 *
 * sendMagicLinkEmail — sends the intake magic link to the injured employee.
 *
 * PHI constraint: email must NOT contain body part, injury type, AWW, or
 * any medical/financial data. Claim number and employer name only.
 *
 * Production: set SENDGRID_API_KEY in environment.
 * Dev/test:   no key → logs intent and returns { mock: true, sent: false }.
 */

const logger = require('../logger');

/**
 * @param {object} opts
 * @param {string} opts.toEmail       Recipient email address
 * @param {string} opts.toName        Recipient full name (first + last)
 * @param {string} opts.employerName  Name of the employer (no PHI)
 * @param {string} opts.claimNumber   Claim number (e.g. HHW-2026-043)
 * @param {string} opts.magicLinkUrl  Full URL including JWT token
 * @param {string} opts.expiresAt     ISO timestamp — shown as human-readable expiry
 * @returns {Promise<{ mock: boolean, sent: boolean, messageId?: string }>}
 */
async function sendMagicLinkEmail({ toEmail, toName, employerName, claimNumber, magicLinkUrl, expiresAt }) {
  if (!process.env.SENDGRID_API_KEY) {
    logger.info({
      msg:        'sendMagicLinkEmail: SENDGRID_API_KEY absent — skipping send',
      toEmail,
      claimNumber,
      magicLinkUrl,
    });
    return { mock: true, sent: false };
  }

  // ── SendGrid send ────────────────────────────────────────────────────────────
  // Dynamic import so the package is only required when a key is present.
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const expiryDate = new Date(expiresAt).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });

  const msg = {
    to:      toEmail,
    from:    process.env.SENDGRID_FROM_EMAIL || 'noreply@homecaretpa.com',
    subject: `Action Required: Complete Your Workers' Compensation Claim — ${claimNumber}`,
    text: [
      `Dear ${toName},`,
      '',
      `Your employer, ${employerName}, has filed a workers' compensation claim on your behalf.`,
      `Claim number: ${claimNumber}`,
      '',
      'Please complete your portion of the claim by clicking the secure link below:',
      magicLinkUrl,
      '',
      `This link expires on ${expiryDate}. Do not share it with anyone.`,
      '',
      'What you will need to do:',
      '1. Describe your injury in your own words',
      '2. Upload photos if available',
      '3. Select a medical provider from our network',
      '4. Review and sign your DWC-1 form electronically',
      '',
      'Questions? Contact the DWC Information and Assistance line: 1-800-736-7401',
      '',
      'HomeCare TPA | Workers\' Compensation Administration',
    ].join('\n'),
    // HTML template — M8 will replace with Lob-managed templates
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2332">
        <div style="background:#0a1622;padding:24px 28px;border-radius:8px 8px 0 0">
          <span style="font-family:monospace;font-weight:700;font-size:18px;color:#f59e0b">HomeCare TPA</span>
          <span style="color:#7cb4d5;font-size:12px;margin-left:12px">Workers' Compensation</span>
        </div>
        <div style="background:#f8fafc;padding:28px;border:1px solid #d1dde8;border-top:none;border-radius:0 0 8px 8px">
          <p>Dear ${toName},</p>
          <p>Your employer, <strong>${employerName}</strong>, has filed a workers' compensation claim on your behalf.</p>
          <p><strong>Claim Number: ${claimNumber}</strong></p>
          <p>Please complete your portion of the claim using the secure link below:</p>
          <p style="text-align:center;margin:28px 0">
            <a href="${magicLinkUrl}" style="background:#f59e0b;color:#000;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:15px">
              Complete My Claim &rarr;
            </a>
          </p>
          <p style="color:#6b7280;font-size:13px">This link expires on <strong>${expiryDate}</strong>. Do not share it with anyone.</p>
          <hr style="border:none;border-top:1px solid #d1dde8;margin:20px 0">
          <p style="font-size:13px;color:#374151"><strong>What you'll need to do:</strong></p>
          <ol style="font-size:13px;color:#374151;line-height:1.8">
            <li>Describe your injury in your own words</li>
            <li>Upload photos if available</li>
            <li>Select a medical provider from our network</li>
            <li>Review and sign your DWC-1 form electronically</li>
          </ol>
          <p style="font-size:12px;color:#9ca3af;margin-top:24px">
            Questions? Contact the DWC Information and Assistance line: <strong>1-800-736-7401</strong>
          </p>
        </div>
      </div>
    `,
  };

  const [response] = await sgMail.send(msg);
  const messageId  = response?.headers?.['x-message-id'];

  logger.info({
    msg:        'sendMagicLinkEmail: sent',
    toEmail,
    claimNumber,
    messageId,
  });

  return { mock: false, sent: true, messageId };
}

module.exports = { sendMagicLinkEmail };
