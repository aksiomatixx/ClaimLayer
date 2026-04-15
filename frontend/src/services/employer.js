const BASE = '/api/v1';

/**
 * POST /api/v1/auth/employer/login
 * Returns { ok, employer_id, employer_name, email } on success.
 * Throws on non-2xx.
 */
export async function loginEmployer(email, password) {
  const res = await fetch(`${BASE}/auth/employer/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Login failed'), { status: res.status, data });
  return data;
}

/**
 * GET /api/v1/auth/dev-employer-session
 * Dev-only: sets employer cookie and returns { ok, role, employerId, employerName }.
 */
export async function ensureDevEmployerSession() {
  try {
    const res = await fetch(`${BASE}/auth/dev-employer-session`, { credentials: 'include' });
    if (res.ok) return await res.json();
  } catch {
    // Non-fatal — dev session is best-effort
  }
  return null;
}

/**
 * GET /api/v1/employer/employee-preview/:adpId
 * Returns { found, first_name, last_name, job_title, email_masked }
 * Always 200 — never throws on not-found.
 */
export async function previewEmployee(adpId) {
  const res = await fetch(`${BASE}/employer/employee-preview/${encodeURIComponent(adpId)}`, {
    credentials: 'include',
  });
  if (!res.ok) return { found: false };
  return res.json();
}

/**
 * POST /api/v1/employer/froi
 * Returns 201 { claim_id, claim_number, employee_name, email_masked,
 *               magic_link_url, expires_at, adp_data, warning, warning_message }
 */
export async function submitFROI({ adpEmployeeId, dateOfInjury, bodyPart, injuryType }) {
  const res = await fetch(`${BASE}/employer/froi`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adpEmployeeId, dateOfInjury, bodyPart, injuryType }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'FROI submission failed'), { status: res.status, data });
  return data;
}
