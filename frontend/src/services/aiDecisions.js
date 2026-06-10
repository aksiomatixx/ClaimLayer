// AI decisions feed API (Agents console)

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

// ── AI Decisions feed (Agents view) ────────────────────────────────
export async function fetchAiDecisions(filters = {}){
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return _tdJson(await fetch(`${_TD_BASE}/ai-decisions${qs.toString() ? '?' + qs : ''}`, _tdOpts()));
}
export async function fetchAiDecisionStats(window = 30){
  return _tdJson(await fetch(`${_TD_BASE}/ai-decisions/stats?window=${window}`, _tdOpts()));
}
export async function fetchAiDecision(id){
  return _tdJson(await fetch(`${_TD_BASE}/ai-decisions/${id}`, _tdOpts()));
}
export async function fetchPromptText(name){
  return _tdJson(await fetch(`${_TD_BASE}/prompts/${name}`, _tdOpts()));
}
