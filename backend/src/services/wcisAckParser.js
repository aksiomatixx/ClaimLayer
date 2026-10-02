'use strict';

/**
 * wcisAckParser.js — Phase 7 WCIS Release 3.1 EDI Flat-File & 824 Acknowledgment Parser.
 *
 * Implements California DWC / IAIABC Release 3.1 flat-file and 824 EDI acknowledgment parsing:
 *   1. Parses Header (HD), Detail (TA/TE/TR), and Trailer (TR) records.
 *   2. Decodes IAIABC Data Element (DN) numbers and standard error rejection codes.
 *   3. Extracts California Jurisdiction Claim Numbers (JCNs) for FROI 00 acceptance.
 *   4. Supports both fixed-width flat files and pipe/delimiter-separated EDI acks.
 */

const logger = require('../logger');

// Standard IAIABC Release 3.1 Error Codes
const IAIABC_ERROR_CODES = {
  '001': 'Mandatory Field Missing',
  '028': 'Invalid Social Security Number',
  '031': 'Duplicate Claim Admin Claim Number without Prior Linkage',
  '033': 'Invalid Date of Injury',
  '039': 'Date of Injury cannot be in the future',
  '042': 'Missing or Invalid Employee Name',
  '057': 'Mandatory Jurisdiction Field Missing for California',
  '063': 'Invalid Body Part Code',
  '064': 'Invalid Nature of Injury Code',
  '071': 'Employee Date of Birth cannot be after Date of Injury',
  '085': 'Invalid Benefit Type Code for SROI MTC',
  '091': 'Initial Payment MTC (IP) submitted without Paid To Date',
  '102': 'JCN not found in jurisdiction database for subsequent MTC',
};

// Data Element (DN) dictionary lookup
const IAIABC_DN_NAMES = {
  'DN0004': 'Jurisdiction Claim Number (JCN)',
  'DN0005': 'Claim Admin Claim Number',
  'DN0006': 'Insurer FEIN',
  'DN0015': 'Claim Administrator FEIN',
  'DN0016': 'Employer FEIN',
  'DN0031': 'Date of Injury',
  'DN0042': 'Employee SSN',
  'DN0043': 'Employee First Name',
  'DN0044': 'Employee Last Name',
  'DN0052': 'Employee Date of Birth',
  'DN0085': 'Benefit Type Code',
  'DN0086': 'Weekly Benefit Amount',
};

function _isTrailer(line, fields) {
  if (fields) {
    return fields[0] === 'TR' && /^\d+$/.test((fields[1] || '').trim())
      && fields.slice(2).every(f => f.trim() === '');
  }
  return /^TR\d{1,6}\s*$/.test(line);
}

/**
 * Parse an IAIABC 3.1 flat-file acknowledgment string.
 * Supports line-oriented fixed records and pipe-delimited records.
 */
function parseAckFlatFile(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    throw new Error('parseAckFlatFile requires raw text content');
  }

  const lines = rawContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error('Empty EDI acknowledgment file');
  }

  let header = null;
  let trailer = null;
  const records = [];

  for (const line of lines) {
    const isPipeDelimited = line.includes('|');
    const fields = isPipeDelimited ? line.split('|') : null;
    const recordType = isPipeDelimited ? fields[0] : line.slice(0, 2);

    if (recordType === 'HD') {
      // Header record
      header = isPipeDelimited ? {
        recordType: 'HD',
        senderFein: fields[1] || '',
        receiverFein: fields[2] || '',
        transDate: fields[3] || '',
        transTime: fields[4] || '',
        version: fields[5] || '3.1',
      } : {
        recordType: 'HD',
        senderFein: line.slice(2, 11).trim(),
        receiverFein: line.slice(11, 20).trim(),
        transDate: line.slice(20, 28).trim(),
        transTime: line.slice(28, 34).trim(),
        version: line.slice(34, 37).trim() || '3.1',
      };
    } else if (_isTrailer(line, fields)) {
      // Trailer record. 'TR' is also the record type of a REJECTED transaction,
      // so the trailer is recognized by its shape — TR + a record count and
      // nothing else — never by length (a short rejection is still a rejection).
      trailer = isPipeDelimited ? {
        recordType: 'TR',
        recordCount: parseInt(fields[1] || '0', 10),
      } : {
        recordType: 'TR',
        recordCount: parseInt(line.slice(2, 8).trim() || '0', 10),
      };
    } else if (['TA', 'TE', 'TR', 'AK'].includes(recordType)) {
      // Detail Transaction Ack Record
      // Record formats:
      // Delimited: TYPE|CLAIM_ADMIN_NUM|MTC|APP_ACK_CODE|JCN|ERROR_CODE|DN_NUM|ERROR_MSG
      if (isPipeDelimited) {
        const ackCode = fields[3] || (recordType === 'TE' ? 'TE' : (recordType === 'TR' ? 'TR' : 'TA'));
        const result = ackCode === 'TA' ? 'accepted' : (ackCode === 'TE' ? 'accepted_with_error' : 'rejected');
        const jcn = fields[4] || null;
        const errCode = fields[5] || null;
        const dn = fields[6] || null;

        const errors = [];
        if (errCode) {
          errors.push({
            code: errCode,
            dn: dn || 'DN0000',
            field: IAIABC_DN_NAMES[dn] || dn || 'Unknown Field',
            description: IAIABC_ERROR_CODES[errCode] || fields[7] || 'Unspecified EDI error',
          });
        }

        records.push({
          claimAdminClaimNumber: fields[1] || '',
          mtcCode: fields[2] || '00',
          appAckCode: ackCode,
          result,
          jcn,
          errors,
        });
      } else {
        // Fixed-width positional record
        const ackCode = line.slice(2, 4).trim(); // TA, TE, or TR
        const claimNum = line.slice(4, 24).trim();
        const mtc = line.slice(24, 26).trim() || '00';
        const jcn = line.slice(26, 40).trim() || null;
        const errCode = line.slice(40, 43).trim() || null;
        const dn = line.slice(43, 49).trim() || null;

        const result = ackCode === 'TA' ? 'accepted' : (ackCode === 'TE' ? 'accepted_with_error' : 'rejected');
        const errors = [];
        if (errCode) {
          errors.push({
            code: errCode,
            dn: dn || 'DN0000',
            field: IAIABC_DN_NAMES[dn] || dn || 'Unknown Field',
            description: IAIABC_ERROR_CODES[errCode] || 'Unspecified EDI error',
          });
        }

        records.push({
          claimAdminClaimNumber: claimNum,
          mtcCode: mtc,
          appAckCode: ackCode,
          result,
          jcn,
          errors,
        });
      }
    }
  }

  const acceptedCount = records.filter(r => r.result === 'accepted').length;
  const errorCount = records.filter(r => r.result === 'accepted_with_error').length;
  const rejectedCount = records.filter(r => r.result === 'rejected').length;

  return {
    header,
    trailer,
    records,
    summary: {
      total: records.length,
      accepted: acceptedCount,
      accepted_with_error: errorCount,
      rejected: rejectedCount,
      overallStatus: rejectedCount > 0 ? (acceptedCount > 0 ? 'partial' : 'rejected') : 'accepted',
    },
  };
}

module.exports = {
  parseAckFlatFile,
  IAIABC_ERROR_CODES,
  IAIABC_DN_NAMES,
};
