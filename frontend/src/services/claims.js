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
  return `${BASE}/claims/${claimId}/documents/${docId}/file`;
}
