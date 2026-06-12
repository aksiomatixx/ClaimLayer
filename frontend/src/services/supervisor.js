'use strict';

const BASE = '/api/v1';

async function _json(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** Latest daily digest for the logged-in supervisor; null when none
 *  (or when the caller is not a supervisor — the panel renders nothing). */
export async function fetchSupervisorAlert() {
  const res = await fetch(`${BASE}/supervisor/alerts/current`, { credentials: 'include' });
  if (res.status === 403 || res.status === 401) return null;
  return (await _json(res)).alert;
}

export async function acknowledgeSupervisorAlert(alertId) {
  const res = await fetch(`${BASE}/supervisor/alerts/${encodeURIComponent(alertId)}/acknowledge`, {
    method: 'POST', credentials: 'include',
  });
  return (await _json(res)).alert;
}
