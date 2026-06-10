/**
 * Fetch contracts — the decision-loop endpoints the drawer drives
 * (steps 7–9 of the document-to-action flow).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
  calls.push({ url, opts });
  return { ok: true, json: async () => ({ ok: true, documents: [], notices: [] }) };
}));

import {
  ingestClaimDocument, fetchDocumentTriage, resolveDocumentTriage,
  fetchAftermathPreview, completeDiaryAction, declineDiaryAction,
  editDiaryAction, generateSettlementPackage, fetchWcisQualityMetrics,
} from '../services/claims.js';

beforeEach(() => { calls.length = 0; });

describe('decision-loop service contracts', () => {
  it('ingestClaimDocument POSTs the document text with credentials', async () => {
    await ingestClaimDocument('claim-1', { title: 'WSR', content_text: 'text' });
    expect(calls[0].url).toBe('/api/v1/claims/claim-1/documents/ingest');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.credentials).toBe('include');
    expect(JSON.parse(calls[0].opts.body).content_text).toBe('text');
  });

  it('triage queue: list + resolve', async () => {
    await fetchDocumentTriage();
    expect(calls[0].url).toBe('/api/v1/documents/triage');
    await resolveDocumentTriage('doc-9', { action: 'file', claim_id: 'claim-1' });
    expect(calls[1].url).toBe('/api/v1/documents/doc-9/triage-resolve');
    expect(JSON.parse(calls[1].opts.body).action).toBe('file');
  });

  it('aftermath preview + complete', async () => {
    await fetchAftermathPreview('diy-1');
    expect(calls[0].url).toBe('/api/v1/diaries/diy-1/aftermath-preview');
    await completeDiaryAction('diy-1', { action: 'continue', note: 'ok' });
    expect(calls[1].url).toBe('/api/v1/diaries/diy-1/complete');
    expect(JSON.parse(calls[1].opts.body).action).toBe('continue');
  });

  it('decline requires the reason in the body; edit PATCHes the diary', async () => {
    await declineDiaryAction('diy-1', 'duplicate');
    expect(calls[0].url).toBe('/api/v1/diaries/diy-1/decline');
    expect(JSON.parse(calls[0].opts.body).reason).toBe('duplicate');
    await editDiaryAction('diy-1', { due_date: '2026-07-01' });
    expect(calls[1].opts.method).toBe('PATCH');
    expect(JSON.parse(calls[1].opts.body).due_date).toBe('2026-07-01');
  });

  it('settlement package + WCIS quality metrics', async () => {
    await generateSettlementPackage('claim-1', { kind: 'cnr' });
    expect(calls[0].url).toBe('/api/v1/claims/claim-1/settlement-package');
    await fetchWcisQualityMetrics();
    expect(calls[1].url).toBe('/api/v1/wcis/quality-metrics');
  });
});
