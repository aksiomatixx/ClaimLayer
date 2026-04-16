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

export async function fetchPanelsForClaim(claimId) {
  const data = await _json(await fetch(`${BASE}/qme/claim/${encodeURIComponent(claimId)}`, _opts()));
  return data.panels ?? [];
}

export async function fetchPanel(panelId) {
  return _json(await fetch(`${BASE}/qme/${encodeURIComponent(panelId)}`, _opts()));
}

export async function requestPanel(claimId, specialty, adjusterNotes) {
  return _json(await fetch(`${BASE}/qme`, _opts('POST', { claimId, specialty, adjusterNotes })));
}

export async function issuePanel(panelId, data) {
  return _json(await fetch(`${BASE}/qme/${encodeURIComponent(panelId)}/issue`, _opts('PATCH', data)));
}

export async function recordStrikes(panelId, strike1Npi, strike2Npi) {
  return _json(await fetch(`${BASE}/qme/${encodeURIComponent(panelId)}/strikes`, _opts('PATCH', { strike1Npi, strike2Npi })));
}

export async function scheduleQmeAppointment(panelId, appointmentDate) {
  return _json(await fetch(`${BASE}/qme/${encodeURIComponent(panelId)}/appointment`, _opts('PATCH', { appointmentDate })));
}

export async function markReportReceived(panelId) {
  return _json(await fetch(`${BASE}/qme/${encodeURIComponent(panelId)}/report-received`, _opts('PATCH', {})));
}

export async function fetchSupplementalRequests(claimId) {
  const data = await _json(await fetch(`${BASE}/qme/supplementals/${encodeURIComponent(claimId)}`, _opts()));
  return data.supplementalRequests ?? [];
}

export async function approveSupplemental(id) {
  return _json(await fetch(`${BASE}/qme/supplementals/${encodeURIComponent(id)}/approve`, _opts('PATCH', {})));
}

export async function dismissSupplemental(id, reason) {
  return _json(await fetch(`${BASE}/qme/supplementals/${encodeURIComponent(id)}/dismiss`, _opts('PATCH', { reason })));
}
