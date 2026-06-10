// Legacy integrations API (M_legacy_integration)

const _TD_BASE = '/api/v1';
async function _tdJson(res){
  if(!res.ok){
    const body = await res.json().catch(()=>({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
function _tdOpts(method='GET', body){
  const opts = { method, credentials: 'include' };
  if(body !== undefined){
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  return opts;
}

// ── Legacy integrations (M_legacy_integration) ─────────────────────────────
export async function fetchIntegrationSystems(){
  return _tdJson(await fetch(`${_TD_BASE}/integrations/systems`, _tdOpts()));
}
export async function migrateFromLegacy(system){
  return _tdJson(await fetch(`${_TD_BASE}/integrations/${system}/migrate`, _tdOpts('POST', {})));
}
export async function fetchMigratedClaims(){
  return _tdJson(await fetch(`${_TD_BASE}/integrations/migrated`, _tdOpts()));
}
export async function fetchLegacyRecord(system, externalId){
  return _tdJson(await fetch(`${_TD_BASE}/integrations/${system}/legacy-record/${externalId}`, _tdOpts()));
}
