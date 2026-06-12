// ═══════════════════════════════════════════════════════════
// ACTION QUEUE (M3) + ADMIN DASHBOARD — extracted verbatim from App.jsx
// ═══════════════════════════════════════════════════════════
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchRFAs } from '../services/rfas.js';
import { C, PRI_COLOR, TD_TYPE_COLOR } from '../theme.js';
import { fmt$ } from '../utils.js';
import { Badge, Btn, StatCard, Tabs, SyncBadge } from '../ui/primitives.jsx';
import { TriageQueue, WcisQualityStrip } from './TriageQueue.jsx';
import SupervisorAlerts from './SupervisorAlerts.jsx';

const ACTION_STATUSES=new Set(["new_claim","intake_complete","under_investigation"]);
const AGE_MS=d=>Date.now()-new Date(d).getTime();
const DAYS=ms=>Math.floor(ms/(86400*1000));
const PRI_ORDER={Critical:0,High:1,Medium:2,Low:3};

function ActionQueue({claims,onSelect}){
  const today=new Date().toISOString().split('T')[0];
  const actionable=claims.filter(c=>{
    if(ACTION_STATUSES.has(c.status)) return true;
    // Any overdue diary
    return (c.diaries||[]).some(d=>d.status==='open'&&d.dueDate<today);
  }).sort((a,b)=>{
    const pa=PRI_ORDER[a.aiAnalysis?.priority]??4;
    const pb=PRI_ORDER[b.aiAnalysis?.priority]??4;
    if(pa!==pb) return pa-pb;
    return new Date(a.createdAt)-new Date(b.createdAt);
  });

  const STATUS_CFG_LIVE={
    new_claim:{label:"New Claim",color:"#f59e0b",bg:"#1a1100",bd:"#f59e0b33"},
    intake_complete:{label:"Intake Done",color:"#4a8df0",bg:"#06122a",bd:"#4a8df033"},
    under_investigation:{label:"Investigation",color:"#a78bfa",bg:"#0e0920",bd:"#a78bfa33"},
  };
  function LiveBadge({status}){
    const c=STATUS_CFG_LIVE[status]||{label:status,color:C.muted,bg:C.card,bd:C.border};
    return <span style={{display:"inline-block",background:c.bg,color:c.color,border:`1px solid ${c.bd}`,padding:"3px 9px",borderRadius:4,fontSize:10,fontFamily:C.mono,fontWeight:600,textTransform:"uppercase",whiteSpace:"nowrap"}}>{c.label}</span>;
  }

  if(actionable.length===0){
    return(
      <div style={{textAlign:"center",padding:"56px 20px",color:C.muted,animation:"fadeUp .3s ease"}}>
        <div style={{fontSize:28,marginBottom:12}}>✓</div>
        <div style={{fontSize:14,fontWeight:600,color:C.dim}}>No claims require immediate action</div>
        <div style={{fontSize:12,marginTop:6}}>All active claims are on track</div>
      </div>
    );
  }

  return(
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
      <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>
        ACTION QUEUE — {actionable.length} CLAIM{actionable.length!==1?"S":""} NEED ATTENTION
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
              {["Claim #","Employee","DOI","Status","AI Priority","Age",""].map(h=>(
                <th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {actionable.map((c,i)=>{
              const overdueDiaries=(c.diaries||[]).filter(d=>d.status==='open'&&d.dueDate<today);
              const emp=c.employee||{};
              const empName=`${emp.firstName||c.claimant||''} ${emp.lastName||''}`.trim()||c.claimant||c.id;
              return(
                <tr key={c.id} className="rh" onClick={()=>onSelect(c.id||c.claimNumber)}
                    style={{borderBottom:i<actionable.length-1?`1px solid ${C.border}`:"none",animation:`fadeUp .3s ease ${i*.04}s both`}}>
                  <td style={{padding:"12px 13px"}}><span style={{fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{c.claimNumber||c.id}</span></td>
                  <td style={{padding:"12px 13px",fontSize:13,fontWeight:500}}>{empName}</td>
                  <td style={{padding:"12px 13px",fontSize:12,fontFamily:C.mono,color:C.dim}}>{c.dateOfInjury}</td>
                  <td style={{padding:"12px 13px"}}><LiveBadge status={c.status}/></td>
                  <td style={{padding:"12px 13px"}}>
                    {c.aiAnalysis
                      ?<span style={{fontFamily:C.mono,fontSize:12,fontWeight:700,color:PRI_COLOR[c.aiAnalysis.priority]}}>{c.aiAnalysis.priority}</span>
                      :<span style={{color:C.muted,fontSize:11}}>Pending</span>
                    }
                  </td>
                  <td style={{padding:"12px 13px"}}>
                    <span style={{fontFamily:C.mono,fontSize:12,color:DAYS(AGE_MS(c.createdAt))>7?C.amber:C.dim}}>
                      {c.createdAt?`${DAYS(AGE_MS(c.createdAt))}d`:"—"}
                    </span>
                    {overdueDiaries.length>0&&<span style={{marginLeft:6,fontSize:10,background:C.redF,color:C.red,border:`1px solid ${C.red}33`,padding:"1px 6px",borderRadius:4,fontFamily:C.mono}}>⚠ {overdueDiaries.length} overdue</span>}
                  </td>
                  <td style={{padding:"12px 13px"}}><Btn small variant="ghost" onClick={()=>onSelect(c.id||c.claimNumber)}>Review →</Btn></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ═══════════════════════════════════════════════════════════
export default function AdminDashboard({claims,onSelect,onAnalyze,aiLoading,onGenPDF,onPushCMS,jsPdfReady,notify=()=>{}}){
  const [tab,setTab]=useState("queue");
  const today=new Date().toISOString().split('T')[0];
  const actionCount=claims.filter(c=>["new_claim","intake_complete","under_investigation"].includes(c.status)||(c.diaries||[]).some(d=>d.status==='open'&&d.dueDate<today)).length;
  const totalReserves=claims.reduce((s,c)=>c.aiAnalysis?s+(c.aiAnalysis.suggestedMedicalReserve||0)+(c.aiAnalysis.suggestedIndemnityReserve||0)+(c.aiAnalysis.suggestedExpenseReserve||0):s,0);
  const withAI=claims.filter(c=>c.aiAnalysis).length;
  const {data:pendingRfas=[]}=useQuery({queryKey:['rfas','pending'],queryFn:()=>fetchRFAs({status:'pending_adjuster_review'}),refetchInterval:30_000,retry:false,staleTime:30_000});

  return(
    <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:26}}><h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Claims Console</h1><p style={{color:C.muted,fontSize:13}}>Action Queue · AI Analysis · Reserve Approval · CMS Sync</p></div>
      <SupervisorAlerts onSelect={onSelect} notify={notify}/>
      <TriageQueue claims={claims} notify={notify}/>
      <WcisQualityStrip/>
      <div style={{display:"flex",gap:14,marginBottom:24}}>
        <StatCard label="Total Claims" value={claims.length} delay={0}/>
        <StatCard label="Need Action" value={actionCount} accent={actionCount>0?C.amber:C.green} sub="In queue" delay={.05}/>
        <StatCard label="AI Analyzed" value={withAI} accent={withAI>0?C.blue:C.muted} sub="Of total claims" delay={.1}/>
        <StatCard label="AI Reserves" value={totalReserves>0?fmt$(totalReserves):"—"} accent={C.purple} sub="Total suggested" delay={.15}/>
        <StatCard label="Pending RFAs" value={pendingRfas.length} accent={pendingRfas.length>0?C.amber:C.green} sub="Need decision" delay={.2}/>
      </div>
      <Tabs tabs={[{key:"queue",label:`Action Queue (${actionCount})`},{key:"all",label:`All Claims (${claims.length})`}]} active={tab} onChange={setTab}/>
      {tab==="queue"&&<ActionQueue claims={claims} onSelect={onSelect}/>}
      {tab==="all"&&<div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>ALL CLAIMS — {claims.length}</div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>{["Claim ID","Claimant","Employer","DOI","Injury","Status","Active Benefit","TD Weeks","Priority","Reserve","Appt","Media","Actions"].map(h=><th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
            <tbody>{claims.map((c,i)=>{
              const res=c.aiAnalysis?c.aiAnalysis.suggestedMedicalReserve+c.aiAnalysis.suggestedIndemnityReserve+c.aiAnalysis.suggestedExpenseReserve:null;
              const tdSum = c.td_summary || null;
              const tdActive = tdSum?.active || null;
              const tdPaid = tdSum?.total_weeks_paid ?? 0;
              const tdCap = tdSum?.statutory_cap_weeks || 104;
              const tdPct = Math.min(100, Math.round((tdPaid/tdCap)*100));
              const tdColor = tdPaid>=100 ? C.red : tdPaid>=95 ? C.amber : C.cyan;
              return(
                <tr key={c.id} className="rh" onClick={()=>onSelect(c.id)} style={{borderBottom:i<claims.length-1?`1px solid ${C.border}`:"none",animation:`fadeUp .3s ease ${i*.04}s both`}}>
                  <td style={{padding:"12px 13px"}}>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      <span style={{fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{c.id}</span>
                      <SyncBadge source_system={c.sourceSystem} sync_status={c.syncStatus} small/>
                    </div>
                  </td>
                  <td style={{padding:"12px 13px",fontSize:13,fontWeight:500}}>{c.claimant}</td>
                  <td style={{padding:"12px 13px",fontSize:12,color:C.dim}}>{c.employer}</td>
                  <td style={{padding:"12px 13px",fontSize:12,fontFamily:C.mono,color:C.dim}}>{c.dateOfInjury}</td>
                  <td style={{padding:"12px 13px"}}><div style={{fontSize:12,color:C.dim}}>{c.injuryType}</div><div style={{fontSize:10,color:C.muted,marginTop:2}}>{c.bodyPart}</div></td>
                  <td style={{padding:"12px 13px"}}><Badge status={c.status}/></td>
                  <td style={{padding:"12px 13px"}}>{tdActive?<span style={{fontFamily:C.mono,fontSize:11,fontWeight:600,color:TD_TYPE_COLOR[tdActive.benefit_type]||C.blue}}>{tdActive.benefit_type} {fmt$(tdActive.weekly_rate)}/wk</span>:<span style={{color:C.dim}}>—</span>}</td>
                  <td style={{padding:"12px 13px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontFamily:C.mono,fontSize:11,color:tdColor,fontWeight:tdPaid>=95?700:500,whiteSpace:"nowrap"}}>{tdPaid} / {tdCap}</span>
                      <div style={{width:32,height:4,background:C.bg,borderRadius:2,overflow:"hidden",border:`1px solid ${C.border}`}}>
                        <div style={{width:`${tdPct}%`,height:"100%",background:tdColor}}/>
                      </div>
                    </div>
                  </td>
                  <td style={{padding:"12px 13px"}}>{c.aiAnalysis?<span style={{fontFamily:C.mono,fontSize:12,fontWeight:700,color:PRI_COLOR[c.aiAnalysis.priority]}}>{c.aiAnalysis.priority}</span>:<span style={{color:C.muted}}>—</span>}</td>
                  <td style={{padding:"12px 13px"}}>{res!=null?<span style={{fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.cyan}}>{fmt$(res)}</span>:<span style={{color:C.muted}}>—</span>}</td>
                  <td style={{padding:"12px 13px"}}>{c.appointment?.confirmed?<span style={{fontSize:10,background:C.tealF,color:C.teal,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,border:`1px solid ${C.teal}33`}}>✓ Booked</span>:<span style={{color:C.muted,fontSize:11}}>—</span>}</td>
                  <td style={{padding:"12px 13px"}}>{c.media?.length>0?<span style={{fontSize:10,background:C.blueF,color:C.blue,padding:"2px 8px",borderRadius:4,fontFamily:C.mono}}>📎 {c.media.length}</span>:c.voiceTranscript?<span style={{fontSize:10,color:C.rose}}>🎙</span>:<span style={{color:C.muted}}>—</span>}</td>
                  <td style={{padding:"12px 13px"}} onClick={e=>e.stopPropagation()}>
                    <div style={{display:"flex",gap:5}}>
                      {c.aiAnalysis&&<Btn small variant="teal" onClick={()=>onGenPDF(c)}>PDF</Btn>}
                      <Btn small variant="ghost" onClick={()=>onSelect(c.id||c.claimNumber)}>Review</Btn>
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>}
    </div>
  );
}

