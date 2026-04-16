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

export async function evaluateMMISignals(claimId) {
  return _json(await fetch(`${BASE}/mmi/evaluate/${encodeURIComponent(claimId)}`, _opts('POST', {})));
}

export async function fetchMMIEvaluations(claimId) {
  const data = await _json(await fetch(`${BASE}/mmi/claim/${encodeURIComponent(claimId)}`, _opts()));
  return data.evaluations ?? [];
}

export async function solicitPR4(mmiEvaluationId, claimId, physicianName, physicianFax, physicianAddress) {
  return _json(await fetch(`${BASE}/mmi/${encodeURIComponent(mmiEvaluationId)}/solicit-pr4`, _opts('POST', { claimId, physicianName, physicianFax, physicianAddress })));
}

export async function recordPR4Response(pr4Id, data) {
  return _json(await fetch(`${BASE}/mmi/pr4/${encodeURIComponent(pr4Id)}/response`, _opts('PATCH', data)));
}

export async function dismissMMIEvaluation(mmiEvaluationId, note) {
  return _json(await fetch(`${BASE}/mmi/${encodeURIComponent(mmiEvaluationId)}/dismiss`, _opts('PATCH', { note })));
}

export async function fetchPR4Solicitations(claimId) {
  const data = await _json(await fetch(`${BASE}/mmi/pr4/claim/${encodeURIComponent(claimId)}`, _opts()));
  return data.solicitations ?? [];
}
