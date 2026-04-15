'use strict';

const BASE = '/api/v1';

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

export async function fetchRFAs(filters = {}) {
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null && v !== ''))
  );
  const qs = params.toString() ? `?${params}` : '';
  const data = await _json(await fetch(`${BASE}/rfas${qs}`, _opts()));
  return data.rfas ?? [];
}

export async function fetchRFA(rfaId) {
  return _json(await fetch(`${BASE}/rfas/${rfaId}`, _opts()));
}

export async function submitRFA(claimId, rfaData) {
  return _json(await fetch(`${BASE}/rfas`, _opts('POST', { claimId, ...rfaData })));
}

export async function approveRFA(rfaId) {
  return _json(await fetch(`${BASE}/rfas/${rfaId}/approve`, _opts('POST')));
}

export async function routeToURO(rfaId, reason) {
  return _json(await fetch(`${BASE}/rfas/${rfaId}/route-to-uro`, _opts('POST', { reason })));
}
