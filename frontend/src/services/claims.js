'use strict';

const BASE = '/api/v1';

// ── helpers ───────────────────────────────────────────────────────────────────
async function _json(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function _opts(method = 'GET', body = undefined) {
  const opts = { method, credentials: 'include' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  return opts;
}

// ── Claims CRUD ───────────────────────────────────────────────────────────────

export async function fetchClaims(filters = {}) {
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null))
  );
  const qs = params.toString() ? `?${params}` : '';
  const data = await _json(await fetch(`${BASE}/claims${qs}`, _opts()));
  return data.claims ?? [];
}

export async function fetchClaim(id) {
  return _json(await fetch(`${BASE}/claims/${id}`, _opts()));
}

export async function updateClaimStatus(id, status) {
  return _json(await fetch(`${BASE}/claims/${id}/status`, _opts('PATCH', { status })));
}

export async function approveReserves(id, reserves) {
  return _json(await fetch(`${BASE}/claims/${id}/reserves`, _opts('PATCH', reserves)));
}

// ── AI analysis ───────────────────────────────────────────────────────────────

export async function triggerAnalysis(id) {
  return _json(await fetch(`${BASE}/claims/${id}/analyze`, _opts('POST')));
}

// ── Diaries ───────────────────────────────────────────────────────────────────

export async function fetchDiaries(id) {
  const data = await _json(await fetch(`${BASE}/claims/${id}/diaries`, _opts()));
  return data.diaries ?? [];
}

// ── Dev session (non-production auto-login) ───────────────────────────────────

export async function ensureDevSession() {
  try {
    await _json(await fetch(`${BASE}/auth/dev-session`, _opts()));
  } catch {
    // non-fatal — production will use real auth
  }
}

// ── Documents & decision brief (decision-support drawer) ─────────────────────

export async function fetchClaimDocuments(id) {
  const data = await _json(await fetch(`${BASE}/claims/${id}/documents`, _opts()));
  return data.documents ?? [];
}

export async function fetchDecisionBrief(id) {
  return _json(await fetch(`${BASE}/claims/${id}/decision-brief`, _opts()));
}

export function documentFileUrl(claimId, docId) {
  // Static demo builds ship the document PDFs as files next to the bundle.
  if (import.meta.env.VITE_DEMO) return `files/${docId}.pdf`;
  return `${BASE}/claims/${claimId}/documents/${docId}/file`;
}

// ── Tier-1 build: ingestion, aftermath, settlement packages, WCIS quality ────

export async function ingestClaimDocument(claimId, payload) {
  return _json(await fetch(`${BASE}/claims/${claimId}/documents/ingest`, _opts('POST', payload)));
}

export async function ingestClaimFile(claimId, file) {
  const form = new FormData();
  form.append('file', file, file.name);
  return _json(await fetch(`${BASE}/claims/${claimId}/documents/ingest-file`, {
    method: 'POST',
    credentials: 'include',
    body: form, // browser sets the multipart boundary
  }));
}

export async function fetchDocumentTriage() {
  const data = await _json(await fetch(`${BASE}/documents/triage`, _opts()));
  return data.documents ?? [];
}

export async function resolveDocumentTriage(docId, payload) {
  return _json(await fetch(`${BASE}/documents/${docId}/triage-resolve`, _opts('POST', payload)));
}

export async function fetchAftermathPreview(diaryId) {
  return _json(await fetch(`${BASE}/diaries/${encodeURIComponent(diaryId)}/aftermath-preview`, _opts()));
}

export async function completeDiaryAction(diaryId, payload) {
  return _json(await fetch(`${BASE}/diaries/${encodeURIComponent(diaryId)}/complete`, _opts('POST', payload)));
}

export async function generateSettlementPackage(claimId, payload) {
  return _json(await fetch(`${BASE}/claims/${claimId}/settlement-package`, _opts('POST', payload)));
}

export async function fetchWcisQualityMetrics() {
  return _json(await fetch(`${BASE}/wcis/quality-metrics`, _opts()));
}

// ── Claim links (CL-DEMO2) ───────────────────────────────────────────────────

export async function fetchClaimLinks(claimId) {
  const data = await _json(await fetch(`${BASE}/claims/${claimId}/links`, _opts()));
  return data.links ?? [];
}

// ── Itemized reserve worksheets (CL-RSV1) ────────────────────────────────────

export async function fetchReserveWorksheet(claimId) {
  return _json(await fetch(`${BASE}/claims/${claimId}/reserve-worksheet`, _opts()));
}

// Approve the rollup BOUND to the reviewed subtotals — the server
// recomputes at approval time and 409s if the worksheet changed since
// it was loaded, so stale totals never reach reserves/FileHandler.
export async function approveReserveWorksheet(claimId, expected) {
  return _json(await fetch(`${BASE}/claims/${claimId}/reserve-worksheet/approve`, _opts('POST', { expected })));
}

export async function addReserveLineItem(claimId, payload) {
  return _json(await fetch(`${BASE}/claims/${claimId}/reserve-worksheet/items`, _opts('POST', payload)));
}

export async function removeReserveLineItem(itemId) {
  return _json(await fetch(`${BASE}/reserve-worksheet/items/${encodeURIComponent(itemId)}`, { method: 'DELETE', credentials: 'include' }));
}

export async function declineDiaryAction(diaryId, reason) {
  return _json(await fetch(`${BASE}/diaries/${encodeURIComponent(diaryId)}/decline`, _opts('POST', { reason })));
}

export async function editDiaryAction(diaryId, patch) {
  return _json(await fetch(`${BASE}/diaries/${encodeURIComponent(diaryId)}`, _opts('PATCH', patch)));
}
