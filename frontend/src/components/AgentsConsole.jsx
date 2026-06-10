import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAiDecisionStats, fetchAiDecisions, fetchPromptText } from '../services/aiDecisions.js';
import { C } from '../theme.js';
import { Btn, Lbl, Spinner, StatCard } from '../ui/primitives.jsx';

export const AGENT_TYPE_LABEL = {
  compensability: 'Compensability', rfa_mtus: 'RFA / MTUS',
  cnr_pricing:    'C&R Pricing',    msa_screening: 'MSA Screening',
  voice_extract:  'Voice Extraction',
};
export const AGENT_TYPE_COLOR = {
  compensability: C.blue, rfa_mtus: C.amber, cnr_pricing: C.purple,
  msa_screening:  C.teal, voice_extract: C.rose,
};

export function AgentsConsole({notify}){
  const [filters, setFilters] = useState(new Set()); // multi-select
  const {data: stats} = useQuery({queryKey:['ai-stats'], queryFn:()=>fetchAiDecisionStats(30), refetchInterval: 60_000});
  const {data: feed, isLoading} = useQuery({
    queryKey:['ai-decisions', Array.from(filters).sort().join(',')],
    queryFn: () => {
      // Server only filters one type at a time; for multi-select we
      // fetch all and filter client-side. Safe for the demo dataset.
      return fetchAiDecisions({ limit: 200 });
    },
    refetchInterval: 60_000,
  });
  const [expanded, setExpanded] = useState(null);
  const [promptModal, setPromptModal] = useState(null);

  const rows = (feed?.rows || []).filter(r =>
    filters.size === 0 || filters.has(r.decision_type)
  );

  const toggleFilter = (k) => {
    const next = new Set(filters);
    if (next.has(k)) next.delete(k); else next.add(k);
    setFilters(next);
  };

  const showPrompt = async (name) => {
    try {
      const data = await fetchPromptText(name);
      setPromptModal(data);
    } catch (e) { notify(`Prompt fetch failed: ${e.message}`, 'error'); }
  };

  return (
    <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:22}}>
        <h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Agents Console</h1>
        <p style={{color:C.muted,fontSize:13}}>Every Claude call + automated gate · audit trail · guardrail enforcement</p>
      </div>
      {/* KPI STRIP */}
      <div style={{display:"flex",gap:14,marginBottom:18}}>
        <StatCard label="Decisions (30d)"         value={stats?.total ?? '—'} delay={0}/>
        <StatCard label="Auto-resolved"           value={stats ? `${(100 - (stats.pct_with_human_override||0)).toFixed(1)}%` : '—'} accent={C.green} delay={.05}/>
        <StatCard label="Human-overridden"        value={stats ? `${(stats.pct_with_human_override||0).toFixed(1)}%` : '—'} accent={C.amber} delay={.10}/>
        <StatCard label="Guardrail triggered"     value={stats ? `${(stats.pct_with_guardrail_triggered||0).toFixed(1)}%` : '—'} accent={(stats?.pct_with_guardrail_triggered||0) > 0 ? C.red : C.green} delay={.15}/>
        <StatCard label="Median latency"          value={stats?.median_latency_ms ? `${stats.median_latency_ms} ms` : '—'} delay={.20}/>
      </div>
      {/* FILTER CHIPS */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
        <span style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.06em",textTransform:"uppercase",alignSelf:"center",marginRight:6}}>Filter:</span>
        {Object.keys(AGENT_TYPE_LABEL).map(k => {
          const on = filters.has(k);
          return (
            <button key={k} onClick={()=>toggleFilter(k)}
              style={{background:on?(AGENT_TYPE_COLOR[k]||C.amber):"transparent",color:on?"#000":C.dim,border:`1px solid ${on?(AGENT_TYPE_COLOR[k]||C.amber):C.border}`,padding:"4px 11px",borderRadius:14,fontSize:11,fontFamily:C.mono,fontWeight:600,letterSpacing:"0.04em",cursor:"pointer"}}>
              {AGENT_TYPE_LABEL[k]}
            </button>
          );
        })}
        {filters.size > 0 && <button onClick={()=>setFilters(new Set())}
          style={{background:"transparent",color:C.muted,border:`1px solid ${C.border}`,padding:"4px 11px",borderRadius:14,fontSize:11,fontFamily:C.mono,cursor:"pointer"}}>Clear</button>}
      </div>
      <AgentsFeedTable rows={rows} loading={isLoading} expanded={expanded} setExpanded={setExpanded} showPrompt={showPrompt}/>
      {promptModal && <PromptModal data={promptModal} onClose={()=>setPromptModal(null)}/>}
    </div>
  );
}

export function AgentsFeedTable({rows, loading, expanded, setExpanded, showPrompt}){
  if (loading) return <div style={{padding:32,textAlign:"center"}}><Spinner/></div>;
  if (rows.length === 0) return <div style={{background:C.card,border:`1px dashed ${C.border}`,borderRadius:10,padding:"32px 20px",textAlign:"center",color:C.muted,fontSize:13}}>No decisions in the current filter.</div>;
  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
      <table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
          {["When","Claim","Type","Prompt","Model","Latency","Tokens","Conf","",""].map((h,i)=>
            <th key={i} style={{padding:"9px 12px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>
          )}
        </tr></thead>
        <tbody>{rows.flatMap((r) => {
          const isExpanded = expanded === r.id;
          const guardrailHit = Array.isArray(r.guardrail_actions) && r.guardrail_actions.some(g => g?.triggered);
          const overridden   = !!r.human_decision;
          const color = AGENT_TYPE_COLOR[r.decision_type] || C.dim;
          const out = [
            <tr key={r.id} className="rh" onClick={()=>setExpanded(isExpanded ? null : r.id)} style={{borderBottom:`1px solid ${C.border}`}}>
              <td style={{padding:"10px 12px",fontFamily:C.mono,fontSize:10,color:C.muted}}>{new Date(r.created_at).toLocaleString()}</td>
              <td style={{padding:"10px 12px",fontFamily:C.mono,fontSize:11,color:C.amber,fontWeight:600}}>{r.claim_id || '—'}</td>
              <td style={{padding:"10px 12px"}}><span style={{display:"inline-block",background:`${color}22`,color,border:`1px solid ${color}55`,padding:"2px 8px",borderRadius:4,fontSize:10,fontFamily:C.mono,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase"}}>{AGENT_TYPE_LABEL[r.decision_type] || r.decision_type}</span></td>
              <td style={{padding:"10px 12px",fontFamily:C.mono,fontSize:11,color:C.dim}}>{r.prompt_name}</td>
              <td style={{padding:"10px 12px",fontFamily:C.mono,fontSize:10,color:C.muted}}>{r.model}</td>
              <td style={{padding:"10px 12px",fontFamily:C.mono,fontSize:11,color:C.dim}}>{r.latency_ms != null ? `${r.latency_ms}ms` : '—'}</td>
              <td style={{padding:"10px 12px",fontFamily:C.mono,fontSize:10,color:C.muted}}>{r.input_tokens != null ? `${r.input_tokens}/${r.output_tokens}` : '—'}</td>
              <td style={{padding:"10px 12px",fontFamily:C.mono,fontSize:11,color:C.cyan}}>{r.confidence != null ? `${r.confidence}` : '—'}</td>
              <td style={{padding:"10px 12px"}}>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {guardrailHit && <span title="Guardrail triggered" style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:C.red}}/>}
                  {overridden   && <span title="Human override recorded" style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:C.blue}}/>}
                </div>
              </td>
              <td style={{padding:"10px 12px",color:C.muted,fontSize:14}}>{isExpanded ? '▾' : '▸'}</td>
            </tr>
          ];
          if (isExpanded) out.push(<AgentsRowDetail key={`${r.id}-x`} row={r} showPrompt={showPrompt}/>);
          return out;
        })}</tbody>
      </table>
    </div>
  );
}

export function AgentsRowDetail({row, showPrompt}){
  const guardrails = Array.isArray(row.guardrail_actions) ? row.guardrail_actions : [];
  return (
    <tr style={{borderBottom:`1px solid ${C.border}`,background:C.bg}}>
      <td colSpan={10} style={{padding:"14px 16px"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px"}}>
            <Lbl>Input snapshot</Lbl>
            <pre style={{margin:0,fontSize:10,fontFamily:C.mono,color:C.dim,whiteSpace:"pre-wrap",wordBreak:"break-word",maxHeight:240,overflow:"auto"}}>{JSON.stringify(row.input_snapshot, null, 2)}</pre>
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px"}}>
            <Lbl>Output parsed</Lbl>
            <pre style={{margin:0,fontSize:10,fontFamily:C.mono,color:C.dim,whiteSpace:"pre-wrap",wordBreak:"break-word",maxHeight:240,overflow:"auto"}}>{JSON.stringify(row.output_parsed, null, 2)}</pre>
          </div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px"}}>
            <Lbl>Guardrails + Human</Lbl>
            {guardrails.length === 0
              ? <div style={{fontSize:11,color:C.muted,fontFamily:C.mono}}>No guardrail rules emitted</div>
              : guardrails.map((g, i) => (
                <div key={i} style={{fontSize:10,fontFamily:C.mono,color:g.triggered?C.red:C.green,marginBottom:5}}>
                  {g.triggered ? '⚡' : '✓'} {g.rule}{g.action ? ` → ${g.action}` : ''}{g.computed_premium ? ` (${g.computed_premium}×)` : ''}
                </div>
              ))}
            <div style={{height:1,background:C.border,margin:"8px 0"}}/>
            {row.human_decision
              ? <div style={{fontSize:11,fontFamily:C.mono,color:C.blue}}>👤 {row.human_decision}<div style={{fontSize:9,color:C.muted,marginTop:2}}>{row.human_decision_at && new Date(row.human_decision_at).toLocaleString()}</div></div>
              : <div style={{fontSize:11,fontFamily:C.mono,color:C.muted}}>No human decision recorded</div>}
            <div style={{marginTop:10}}>
              <Btn small variant="ghost" onClick={()=>showPrompt(row.prompt_name)}>View prompt →</Btn>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function PromptModal({data, onClose}){
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.85)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:24,width:740,maxHeight:"82vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:13,fontFamily:C.mono,fontWeight:700,color:C.amber}}>{data.name}.txt</div>
          <button onClick={onClose} style={{background:C.card,border:`1px solid ${C.border}`,color:C.dim,cursor:"pointer",width:28,height:28,borderRadius:6,fontSize:14}}>✕</button>
        </div>
        <pre style={{margin:0,fontSize:11,fontFamily:C.mono,color:C.dim,whiteSpace:"pre-wrap",wordBreak:"break-word",lineHeight:1.55}}>{data.text}</pre>
      </div>
    </div>
  );
}
