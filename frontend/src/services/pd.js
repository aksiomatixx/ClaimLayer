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

export async function calculatePD(claimId, pr4Id, apportionmentPercent) {
  return _json(await fetch(`${BASE}/pd/calculate/${encodeURIComponent(claimId)}`, _opts('POST', { pr4Id, apportionmentPercent })));
}

export async function initiatePDAdvances(claimId, pdEvaluationId, tdEndDate) {
  return _json(await fetch(`${BASE}/pd/advances/${encodeURIComponent(claimId)}`, _opts('POST', { pdEvaluationId, tdEndDate })));
}

export async function recordPDAdvancePayment(pdAdvanceId) {
  return _json(await fetch(`${BASE}/pd/advances/${encodeURIComponent(pdAdvanceId)}/payment`, _opts('PATCH', {})));
}

export async function waivePDAdvance(pdAdvanceId, reason) {
  return _json(await fetch(`${BASE}/pd/advances/${encodeURIComponent(pdAdvanceId)}/waive`, _opts('PATCH', { reason })));
}

export async function createStipulation(claimId, pdEvaluationId, opts) {
  return _json(await fetch(`${BASE}/pd/stip/${encodeURIComponent(claimId)}`, _opts('POST', { pdEvaluationId, ...opts })));
}

export async function sendStipToWorker(stipId) {
  return _json(await fetch(`${BASE}/pd/stip/${encodeURIComponent(stipId)}/send`, _opts('PATCH', {})));
}

export async function recordWorkerSignature(stipId) {
  return _json(await fetch(`${BASE}/pd/stip/${encodeURIComponent(stipId)}/worker-signature`, _opts('PATCH', {})));
}

export async function recordAdjusterSignature(stipId) {
  return _json(await fetch(`${BASE}/pd/stip/${encodeURIComponent(stipId)}/adjuster-signature`, _opts('PATCH', {})));
}

export async function recordEAMSFiled(stipId, filedDate) {
  return _json(await fetch(`${BASE}/pd/stip/${encodeURIComponent(stipId)}/eams-filed`, _opts('PATCH', { filedDate })));
}

export async function fetchPDData(claimId) {
  return _json(await fetch(`${BASE}/pd/claim/${encodeURIComponent(claimId)}`, _opts()));
}
