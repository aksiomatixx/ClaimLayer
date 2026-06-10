// TD period API helpers (extracted from App.jsx — closes the deferred frontend tdService split)

// ═══════════════════════════════════════════════════════════
// TD PERIOD API HELPERS (inline — backend deferred from full tdService milestone)
// ═══════════════════════════════════════════════════════════
export const _TD_BASE = '/api/v1';
export async function _tdJson(res){
  if(!res.ok){
    const body = await res.json().catch(()=>({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
export function _tdOpts(method='GET', body){
  const opts = { method, credentials: 'include' };
  if(body !== undefined){
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  return opts;
}
export async function fetchTdPeriods(claimId){
  const data = await _tdJson(await fetch(`${_TD_BASE}/claims/${claimId}/td-periods`, _tdOpts()));
  return data.periods ?? [];
}
export async function fetchTdSummary(claimId){
  return _tdJson(await fetch(`${_TD_BASE}/claims/${claimId}/td-summary`, _tdOpts()));
}
export async function createTdPeriod(claimId, body){
  return _tdJson(await fetch(`${_TD_BASE}/claims/${claimId}/td-periods`, _tdOpts('POST', body)));
}
export async function closeTdPeriod(periodId, body){
  return _tdJson(await fetch(`${_TD_BASE}/td-periods/${periodId}/close`, _tdOpts('PATCH', body)));
}
export async function reinstateTdPeriod(periodId, body){
  return _tdJson(await fetch(`${_TD_BASE}/td-periods/${periodId}/reinstate`, _tdOpts('PATCH', body)));
}
