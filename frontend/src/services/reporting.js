const BASE = '/api/v1';

async function _json(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const _opts = () => ({ method: 'GET', credentials: 'include' });

/**
 * GET /api/v1/employers/:id/loss-run
 */
export async function fetchLossRun(employerId) {
  return _json(await fetch(`${BASE}/employers/${encodeURIComponent(employerId)}/loss-run`, _opts()));
}

/**
 * GET /api/v1/employers/:id/summary
 */
export async function fetchEmployerSummary(employerId) {
  return _json(await fetch(`${BASE}/employers/${encodeURIComponent(employerId)}/summary`, _opts()));
}

/**
 * GET /api/v1/employers/:id/experience-mod-inputs
 */
export async function fetchExperienceModInputs(employerId) {
  return _json(await fetch(`${BASE}/employers/${encodeURIComponent(employerId)}/experience-mod-inputs`, _opts()));
}

/**
 * GET /api/v1/reports/cross-employer (admin only)
 */
export async function fetchCrossEmployerReport() {
  return _json(await fetch(`${BASE}/reports/cross-employer`, _opts()));
}

/**
 * GET /api/v1/reports/missed-deadlines (admin only)
 */
export async function fetchMissedDeadlines() {
  return _json(await fetch(`${BASE}/reports/missed-deadlines`, _opts()));
}
