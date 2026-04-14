'use strict';

const BASE = '/api/v1';

async function _json(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchProviders(zipCode, limit = 5) {
  const params = new URLSearchParams({ zip: zipCode, limit });
  const data = await _json(
    await fetch(`${BASE}/providers?${params}`, { credentials: 'include' })
  );
  return data.providers ?? [];
}
