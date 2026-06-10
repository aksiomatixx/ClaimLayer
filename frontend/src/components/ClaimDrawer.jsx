import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approveReserves, fetchClaim, fetchDiaries, triggerAnalysis, updateClaimStatus } from '../services/claims.js';
import { dismissMMIEvaluation, evaluateMMISignals, fetchMMIEvaluations, fetchPR4Solicitations, recordPR4Response, solicitPR4 } from '../services/mmi.js';
import { calculatePD, createStipulation, fetchPDData, initiatePDAdvances, recordAdjusterSignature, recordEAMSFiled, recordPDAdvancePayment, recordWorkerSignature, sendStipToWorker, waivePDAdvance } from '../services/pd.js';
import { approveSupplemental, dismissSupplemental, fetchPanelsForClaim, fetchSupplementalRequests, issuePanel, markReportReceived, recordStrikes, requestPanel, scheduleQmeAppointment } from '../services/qme.js';
import { closeTdPeriod, createTdPeriod, fetchTdPeriods, fetchTdSummary, reinstateTdPeriod } from '../services/td.js';
import { C, COMP_COLOR, PRI_COLOR, TD_TYPE_BG, TD_TYPE_COLOR } from '../theme.js';
import { Btn, Field, InfoPair, Lbl, SectionHead, Spinner, SyncBadge, Tabs } from '../ui/primitives.jsx';
import { fmt$ } from '../utils.js';

export function _tdCapColor(weeksPaid,cap){
  const pct = cap>0 ? (weeksPaid/cap)*100 : 0;
  if(pct>95)  return C.red;
  if(pct>=70) return C.amber;
  return C.green;
}
export function _tdWeeks(startStr,endStr){
  if(!startStr) return 0;
  const a = new Date(startStr+'T00:00:00Z');
  const b = new Date((endStr||new Date().toISOString().split('T')[0])+'T00:00:00Z');
  const days = Math.max(0, Math.round((b-a)/86400000)+1);
  return Math.round((days/7)*100)/100;
}

export function TdSummaryCard({summary}){
  const s = summary||{};
  const active = s.active||null;
  const cap    = s.statutory_cap_weeks||104;
  const paid   = s.total_weeks_paid||0;
  const pct    = Math.min(100, Math.round((paid/cap)*1000)/10);
  const color  = _tdCapColor(paid,cap);
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 22px",marginBottom:18}}>
      {/* LEFT — active benefit */}
      <div style={{borderRight:`1px solid ${C.border}`,paddingRight:14}}>
        <Lbl>Active Benefit</Lbl>
        {active ? (
          <>
            <div style={{display:"inline-block",background:TD_TYPE_BG[active.benefit_type]||C.blueF,color:TD_TYPE_COLOR[active.benefit_type]||C.blue,border:`1px solid ${(TD_TYPE_COLOR[active.benefit_type]||C.blue)}55`,padding:"4px 12px",borderRadius:5,fontSize:14,fontFamily:C.mono,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:8}}>{active.benefit_type}</div>
            <div style={{fontFamily:C.mono,fontSize:18,fontWeight:600,color:C.cyan}}>{fmt$(active.weekly_rate)}<span style={{fontSize:11,color:C.muted,marginLeft:4}}>/wk</span></div>
            <div style={{fontSize:11,color:C.dim,marginTop:6}}>Started {active.start_date} · {active.days_in}d in</div>
          </>
        ) : (
          <div style={{display:"inline-block",background:C.bg,color:C.muted,border:`1px solid ${C.border}`,padding:"4px 12px",borderRadius:5,fontSize:13,fontFamily:C.mono,fontWeight:700,textTransform:"uppercase"}}>None Active</div>
        )}
      </div>
      {/* MIDDLE — cumulative */}
      <div style={{borderRight:`1px solid ${C.border}`,paddingRight:14,paddingLeft:14}}>
        <Lbl>Cumulative</Lbl>
        <div style={{fontFamily:C.mono,fontSize:18,fontWeight:600}}>{paid}<span style={{fontSize:11,color:C.muted,marginLeft:4}}>weeks paid</span></div>
        <div style={{fontFamily:C.mono,fontSize:13,color:C.cyan,marginTop:4}}>{fmt$(s.total_indemnity_paid||0)}</div>
        <div style={{fontSize:11,color:C.dim,marginTop:4}}>{s.periods_count||0} period{(s.periods_count||0)===1?'':'s'}</div>
      </div>
      {/* RIGHT — statutory cap */}
      <div style={{paddingLeft:14}}>
        <Lbl>Statutory Cap</Lbl>
        <div style={{height:8,background:C.bg,borderRadius:4,overflow:"hidden",border:`1px solid ${C.border}`,marginBottom:6}}>
          <div style={{width:`${Math.min(100,pct)}%`,height:"100%",background:color,transition:"width .3s"}}/>
        </div>
        <div style={{fontFamily:C.mono,fontSize:12,color}}>{paid} / {cap} wk · {pct}%</div>
        <div style={{fontSize:11,color:C.dim,marginTop:4}}>Projected exhaustion: {s.projected_exhaustion_date||"—"}</div>
        <div style={{fontSize:9,color:C.muted,marginTop:6,fontFamily:C.mono}}>LC §4656(c)(2)</div>
      </div>
    </div>
  );
}

export function TdTimeline({periods}){
  if(!periods||periods.length===0){
    return <div style={{background:C.card,border:`1px dashed ${C.border}`,borderRadius:10,padding:"22px 18px",textAlign:"center",color:C.muted,fontSize:12,marginBottom:14}}>No TD periods yet — timeline will appear once a period is recorded.</div>;
  }
  // Determine x-axis range: earliest start_date → today (or latest end_date if later).
  const today = new Date().toISOString().split('T')[0];
  const starts = periods.map(p=>p.start_date).sort();
  const ends   = periods.map(p=>p.end_date||today).sort();
  const min = starts[0];
  const maxRaw = ends[ends.length-1];
  const max = maxRaw>today?maxRaw:today;
  const minMs = new Date(min+'T00:00:00Z').getTime();
  const maxMs = new Date(max+'T00:00:00Z').getTime();
  const range = Math.max(1, maxMs-minMs);
  const W = 800, H = 120, padX = 40, padY = 24, barH = 32;
  const xFor = (d)=> padX + ((new Date(d+'T00:00:00Z').getTime()-minMs)/range) * (W-padX*2);

  // Build hatched suspension gaps between consecutive closed→next-start periods.
  const sortedByStart = [...periods].sort((a,b)=>a.start_date.localeCompare(b.start_date));
  const gaps = [];
  for(let i=0;i<sortedByStart.length-1;i++){
    const cur = sortedByStart[i];
    const nxt = sortedByStart[i+1];
    if(cur.end_date && cur.end_date < nxt.start_date){
      gaps.push({from:cur.end_date, to:nxt.start_date});
    }
  }

  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 12px",marginBottom:14}}>
      <Lbl>Timeline</Lbl>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}}>
        <defs>
          <pattern id="td-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={C.muted} strokeWidth="1.5"/>
          </pattern>
        </defs>
        {/* baseline */}
        <line x1={padX} y1={padY+barH+8} x2={W-padX} y2={padY+barH+8} stroke={C.border} strokeWidth="1"/>
        {/* end caps with date labels */}
        <text x={padX} y={padY+barH+24} fill={C.muted} fontSize="10" fontFamily="IBM Plex Mono">{min}</text>
        <text x={W-padX} y={padY+barH+24} fill={C.muted} fontSize="10" fontFamily="IBM Plex Mono" textAnchor="end">{max}</text>
        {/* suspension gap hatches (drawn beneath bars) */}
        {gaps.map((g,i)=>{
          const x1 = xFor(g.from), x2 = xFor(g.to);
          return <rect key={`gap${i}`} x={x1} y={padY+8} width={Math.max(1,x2-x1)} height={barH-16} fill="url(#td-hatch)" opacity="0.6"><title>Suspension gap {g.from} → {g.to}</title></rect>;
        })}
        {/* period bars */}
        {sortedByStart.map((p,i)=>{
          const x1 = xFor(p.start_date);
          const x2 = xFor(p.end_date||today);
          const w  = Math.max(2, x2-x1);
          const color = TD_TYPE_COLOR[p.benefit_type]||C.blue;
          const weeks = _tdWeeks(p.start_date,p.end_date);
          return (
            <g key={p.id||i}>
              <rect x={x1} y={padY} width={w} height={barH} fill={color} opacity={p.end_date?0.65:1} rx="3" ry="3">
                <title>{p.benefit_type} — {p.start_date} to {p.end_date||"active"} — ${Number(p.weekly_rate).toFixed(2)}/wk · {weeks}wk</title>
              </rect>
              {w>40 && <text x={x1+6} y={padY+barH/2+4} fill="#000" fontSize="11" fontWeight="700" fontFamily="IBM Plex Mono">{p.benefit_type}</text>}
            </g>
          );
        })}
      </svg>
      <div style={{display:"flex",gap:14,marginTop:8,fontSize:10,fontFamily:C.mono,color:C.muted}}>
        <span><span style={{display:"inline-block",width:9,height:9,background:C.blue,borderRadius:2,marginRight:5,verticalAlign:"middle"}}/>TTD</span>
        <span><span style={{display:"inline-block",width:9,height:9,background:C.teal,borderRadius:2,marginRight:5,verticalAlign:"middle"}}/>TPD</span>
        <span><span style={{display:"inline-block",width:9,height:9,background:C.purple,borderRadius:2,marginRight:5,verticalAlign:"middle"}}/>Salary Cont.</span>
        <span><span style={{display:"inline-block",width:9,height:9,background:C.muted,opacity:.6,borderRadius:2,marginRight:5,verticalAlign:"middle"}}/>Suspension gap</span>
      </div>
    </div>
  );
}

export function TdPeriodsTable({periods,onClose,onReinstate,onEdit}){
  if(!periods||periods.length===0) return null;
  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:14}}>
      <table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
          {["Type","Start","End","Rate","Weeks","Total","Reason Ended","Actions"].map(h=>
            <th key={h} style={{padding:"8px 11px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>
          )}
        </tr></thead>
        <tbody>{periods.map((p,i)=>{
          const isActive = p.end_date==null;
          const weeks = _tdWeeks(p.start_date,p.end_date);
          const total = Math.round(weeks*Number(p.weekly_rate)*100)/100;
          const color = TD_TYPE_COLOR[p.benefit_type]||C.blue;
          return (
            <tr key={p.id} style={{borderBottom:i<periods.length-1?`1px solid ${C.border}`:"none",background:isActive?C.amberF:"transparent"}}>
              <td style={{padding:"10px 11px"}}><span style={{fontFamily:C.mono,fontSize:11,fontWeight:700,color}}>{p.benefit_type}</span></td>
              <td style={{padding:"10px 11px",fontFamily:C.mono,fontSize:11,color:C.dim}}>{p.start_date}</td>
              <td style={{padding:"10px 11px",fontFamily:C.mono,fontSize:11,color:isActive?C.amber:C.dim}}>{p.end_date||"— active"}</td>
              <td style={{padding:"10px 11px",fontFamily:C.mono,fontSize:11,color:C.cyan}}>{fmt$(p.weekly_rate)}</td>
              <td style={{padding:"10px 11px",fontFamily:C.mono,fontSize:11}}>{weeks}</td>
              <td style={{padding:"10px 11px",fontFamily:C.mono,fontSize:11,color:C.cyan}}>{fmt$(total)}</td>
              <td style={{padding:"10px 11px",fontSize:11,color:C.dim}}>{p.reason_ended||(isActive?"—":"")}</td>
              <td style={{padding:"10px 11px"}}>
                <div style={{display:"flex",gap:5}}>
                  {isActive && onClose      && <Btn small variant="outline" onClick={()=>onClose(p)}>Close</Btn>}
                  {!isActive && onReinstate && <Btn small variant="ghost"   onClick={()=>onReinstate(p)}>Reinstate</Btn>}
                  {onEdit && <Btn small variant="ghost" onClick={()=>onEdit(p)}>Edit</Btn>}
                </div>
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

export function StartTdModal({claim,activePeriod,onClose,onSubmit,pending}){
  const today = new Date().toISOString().split('T')[0];
  const [form,setForm] = useState({
    benefit_type:   activePeriod ? (activePeriod.benefit_type==='TTD'?'TPD':'TTD') : 'TTD',
    start_date:     today,
    weekly_rate:    activePeriod?.weekly_rate || claim?.tdRate || '',
    reason_started: activePeriod ? (activePeriod.benefit_type==='TTD'?'benefit_type_change':'rate_change') : 'initial_disability',
    notes:          '',
  });
  const upd = (k,v)=>setForm(p=>({...p,[k]:v}));
  const closeDate = (()=>{ try{ const d=new Date(form.start_date+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().split('T')[0]; }catch{ return ''; } })();
  const valid = form.benefit_type && form.start_date && Number(form.weekly_rate)>0 && form.reason_started;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:480,maxHeight:"85vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:16,fontWeight:700,marginBottom:14}}>Start TD Period</div>
        {activePeriod && (
          <div style={{background:C.amberF,border:`1px solid ${C.amber}55`,borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:12,color:C.amber}}>
            ⚠ This will close the current {activePeriod.benefit_type} period effective {closeDate} and start a new one.
          </div>
        )}
        <Field label="Benefit Type">
          <select value={form.benefit_type} onChange={e=>upd('benefit_type',e.target.value)}>
            <option value="TTD">TTD — Temporary Total Disability</option>
            <option value="TPD">TPD — Temporary Partial Disability</option>
            <option value="salary_continuation">Salary Continuation</option>
          </select>
        </Field>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <Field label="Start Date"><input type="date" value={form.start_date} onChange={e=>upd('start_date',e.target.value)}/></Field>
          <Field label="Weekly Rate ($)"><input type="number" min="0" step="0.01" value={form.weekly_rate} onChange={e=>upd('weekly_rate',e.target.value)}/></Field>
        </div>
        <Field label="Reason Started">
          <select value={form.reason_started} onChange={e=>upd('reason_started',e.target.value)}>
            <option value="initial_disability">Initial Disability</option>
            <option value="reinstatement">Reinstatement</option>
            <option value="rate_change">Rate Change</option>
            <option value="benefit_type_change">Benefit Type Change</option>
          </select>
        </Field>
        <Field label="Notes (optional)"><textarea rows={3} value={form.notes} onChange={e=>upd('notes',e.target.value)}/></Field>
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <Btn disabled={!valid||pending} onClick={()=>onSubmit({benefit_type:form.benefit_type,start_date:form.start_date,weekly_rate:Number(form.weekly_rate),reason_started:form.reason_started,notes:form.notes||undefined})}>
            {pending?<Spinner/>:'Start Period'}
          </Btn>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

export function CloseTdForm({period,onCancel,onSubmit,pending}){
  const today = new Date().toISOString().split('T')[0];
  const [end_date,setEnd] = useState(today);
  const [reason_ended,setReason] = useState('rtw_full');
  const [notes,setNotes] = useState('');
  const valid = end_date >= period.start_date && reason_ended;
  return (
    <>
      <div style={{fontSize:11,color:C.muted,marginBottom:10,fontFamily:C.mono}}>{period.benefit_type} · started {period.start_date}</div>
      <Field label="End Date"><input type="date" min={period.start_date} value={end_date} onChange={e=>setEnd(e.target.value)}/></Field>
      <Field label="Reason Ended">
        <select value={reason_ended} onChange={e=>setReason(e.target.value)}>
          <option value="rtw_full">Returned to work — full duty</option>
          <option value="rtw_modified">Returned to work — modified</option>
          <option value="mmi_reached">MMI reached</option>
          <option value="max_weeks_exhausted">Max weeks exhausted (104-wk cap)</option>
          <option value="suspended_by_adjuster">Suspended by adjuster</option>
          <option value="settled">Settled</option>
          <option value="death">Death</option>
          <option value="other">Other</option>
        </select>
      </Field>
      <Field label="Notes (optional)"><textarea rows={2} value={notes} onChange={e=>setNotes(e.target.value)}/></Field>
      <div style={{display:"flex",gap:8,marginTop:8}}>
        <Btn disabled={!valid||pending} onClick={()=>onSubmit({end_date,reason_ended,notes:notes||undefined})}>{pending?<Spinner/>:'Close Period'}</Btn>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
      </div>
    </>
  );
}

export function ReinstateTdForm({period,onCancel,onSubmit,pending}){
  const today = new Date().toISOString().split('T')[0];
  const minStart = (()=>{ try{ const d=new Date(period.end_date+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().split('T')[0]; }catch{ return today; } })();
  const [start_date,setStart] = useState(minStart>today?minStart:today);
  const [weekly_rate,setRate] = useState(period.weekly_rate||'');
  const [notes,setNotes] = useState('');
  const valid = start_date>period.end_date && Number(weekly_rate)>0;
  return (
    <>
      <div style={{fontSize:11,color:C.muted,marginBottom:10,fontFamily:C.mono}}>Source period: {period.benefit_type} · {period.start_date} → {period.end_date}</div>
      <Field label="New Start Date"><input type="date" min={minStart} value={start_date} onChange={e=>setStart(e.target.value)}/></Field>
      <Field label="Weekly Rate ($)"><input type="number" min="0" step="0.01" value={weekly_rate} onChange={e=>setRate(e.target.value)}/></Field>
      <Field label="Notes (optional)"><textarea rows={2} value={notes} onChange={e=>setNotes(e.target.value)}/></Field>
      <div style={{display:"flex",gap:8,marginTop:8}}>
        <Btn disabled={!valid||pending} onClick={()=>onSubmit({start_date,weekly_rate:Number(weekly_rate),notes:notes||undefined})}>{pending?<Spinner/>:'Reinstate Period'}</Btn>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// CLAIM DRAWER (Admin) — M3: live data, reserve approval, diaries, status
// ═══════════════════════════════════════════════════════════
export const VALID_NEXT={
  new_claim:["intake_complete","denied"],
  intake_complete:["under_investigation","accepted"],
  under_investigation:["accepted","denied"],
  accepted:["active_medical"],
  active_medical:["p_and_s","litigated"],
  p_and_s:["pd_evaluation","litigated"],
  pd_evaluation:["settlement_discussions","litigated"],
  settlement_discussions:["closed"],
  litigated:["settlement_discussions","closed"],
  denied:[],closed:[],
};
export const STATUS_LABEL={
  new_claim:"New Claim",intake_complete:"Intake Done",under_investigation:"Investigation",
  accepted:"Accepted",active_medical:"Active Medical",p_and_s:"P&S",pd_evaluation:"PD Eval",
  settlement_discussions:"Settlement",litigated:"Litigated",denied:"Denied",closed:"Closed",
};
export const PRI_DIARY={CRITICAL:C.red,HIGH:C.amber,MEDIUM:C.blue,LOW:C.dim};

export function ClaimDrawer({claimId,onClose,notify,jsPdfReady,onGenDWC1}){
  const qc=useQueryClient();
  const {data:claim,isLoading:claimLoading}=useQuery({
    queryKey:['claim',claimId],
    queryFn:()=>fetchClaim(claimId),
    enabled:!!claimId,
  });
  const {data:diariesData}=useQuery({
    queryKey:['claim-diaries',claimId],
    queryFn:()=>fetchDiaries(claimId),
    enabled:!!claimId,
  });
  const diaries=diariesData||[];

  const analyzeMut=useMutation({
    mutationFn:()=>triggerAnalysis(claimId),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['claim',claimId]});qc.invalidateQueries({queryKey:['claims']});notify('AI analysis complete');},
    onError:(e)=>notify(`Analysis failed: ${e.message}`,'error'),
  });
  const statusMut=useMutation({
    mutationFn:(s)=>updateClaimStatus(claimId,s),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['claim',claimId]});qc.invalidateQueries({queryKey:['claims']});notify('Status updated');},
    onError:(e)=>notify(`Status update failed: ${e.message}`,'error'),
  });
  const reserveMut=useMutation({
    mutationFn:(r)=>approveReserves(claimId,r),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['claim',claimId]});qc.invalidateQueries({queryKey:['claims']});notify('Reserves approved');},
    onError:(e)=>notify(`Reserve approval failed: ${e.message}`,'error'),
  });

  const [resForm,setResForm]=useState({medical:'',indemnity:'',expense:'',reason:''});
  const [resEditing,setResEditing]=useState(false);
  const [drawerTab,setDrawerTab]=useState("details");

  // TD periods (Benefits tab)
  const {data:tdPeriods=[]}=useQuery({queryKey:['td-periods',claimId],queryFn:()=>fetchTdPeriods(claimId),enabled:!!claimId,staleTime:30_000});
  const {data:tdSummary}=useQuery({queryKey:['td-summary',claimId],queryFn:()=>fetchTdSummary(claimId),enabled:!!claimId,staleTime:30_000});
  const [tdModal,setTdModal]=useState(null); // 'start' | {kind:'close',period} | {kind:'reinstate',period} | null
  const tdMut=useMutation({
    mutationFn:async(action)=>{
      if(action.type==='create')    return createTdPeriod(claimId,action.body);
      if(action.type==='close')     return closeTdPeriod(action.periodId,action.body);
      if(action.type==='reinstate') return reinstateTdPeriod(action.periodId,action.body);
    },
    onSuccess:()=>{
      qc.invalidateQueries({queryKey:['td-periods',claimId]});
      qc.invalidateQueries({queryKey:['td-summary',claimId]});
      qc.invalidateQueries({queryKey:['claim-diaries',claimId]});
      qc.invalidateQueries({queryKey:['claims']});
      setTdModal(null);
      notify('TD period updated');
    },
    onError:(e)=>notify(`TD period action failed: ${e.message}`,'error'),
  });
  const tdActive = tdPeriods.find(p=>p.end_date==null) || null;

  // M11: QME/AME data
  const {data:qmePanels=[]}=useQuery({queryKey:['qme-panels',claimId],queryFn:()=>fetchPanelsForClaim(claimId),enabled:!!claimId,staleTime:30_000});
  const {data:suppReqs=[]}=useQuery({queryKey:['supplementals',claimId],queryFn:()=>fetchSupplementalRequests(claimId),enabled:!!claimId&&drawerTab==='qme',staleTime:30_000});
  const [qmeModal,setQmeModal]=useState(null); // 'request'|'issue'|'strikes'|'appointment'|null
  const [qmeForm,setQmeForm]=useState({});
  const qmeMut=useMutation({
    mutationFn:async(action)=>{
      if(action.type==='request') return requestPanel(claimId,action.specialty,action.notes);
      if(action.type==='issue') return issuePanel(action.panelId,{panelIssuedDate:action.panelIssuedDate,doctor1:action.doctor1,doctor2:action.doctor2,doctor3:action.doctor3});
      if(action.type==='strikes') return recordStrikes(action.panelId,action.strike1Npi,action.strike2Npi);
      if(action.type==='appointment') return scheduleQmeAppointment(action.panelId,action.appointmentDate);
      if(action.type==='report') return markReportReceived(action.panelId);
      if(action.type==='approve-supp') return approveSupplemental(action.id);
      if(action.type==='dismiss-supp') return dismissSupplemental(action.id,action.reason);
    },
    onSuccess:()=>{qc.invalidateQueries({queryKey:['qme-panels',claimId]});qc.invalidateQueries({queryKey:['supplementals',claimId]});qc.invalidateQueries({queryKey:['claim-diaries',claimId]});setQmeModal(null);setQmeForm({});notify('QME action completed');},
    onError:(e)=>notify(`QME action failed: ${e.message}`,'error'),
  });

  // M12: MMI / P&S data
  const {data:mmiEvals=[]}=useQuery({queryKey:['mmi-evals',claimId],queryFn:()=>fetchMMIEvaluations(claimId),enabled:!!claimId&&drawerTab==='mmi',staleTime:30_000});
  const {data:pr4List=[]}=useQuery({queryKey:['pr4-list',claimId],queryFn:()=>fetchPR4Solicitations(claimId),enabled:!!claimId&&drawerTab==='mmi',staleTime:30_000});
  const [mmiModal,setMmiModal]=useState(null);
  const [mmiForm,setMmiForm]=useState({});
  const mmiMut=useMutation({
    mutationFn:async(action)=>{
      if(action.type==='evaluate') return evaluateMMISignals(claimId);
      if(action.type==='solicit') return solicitPR4(action.evalId,claimId,action.physicianName,action.physicianFax,action.physicianAddress);
      if(action.type==='response') return recordPR4Response(action.pr4Id,{wpi:action.wpi,workRestrictions:action.workRestrictions,futureMedical:action.futureMedical,apportionmentNoted:action.apportionmentNoted});
      if(action.type==='dismiss') return dismissMMIEvaluation(action.evalId,action.note);
    },
    onSuccess:()=>{qc.invalidateQueries({queryKey:['mmi-evals',claimId]});qc.invalidateQueries({queryKey:['pr4-list',claimId]});qc.invalidateQueries({queryKey:['claim-diaries',claimId]});setMmiModal(null);setMmiForm({});notify('MMI action completed');},
    onError:(e)=>notify(`MMI action failed: ${e.message}`,'error'),
  });

  // M13: PD / Stip data
  const {data:pdData}=useQuery({queryKey:['pd-data',claimId],queryFn:()=>fetchPDData(claimId),enabled:!!claimId&&drawerTab==='pd',staleTime:30_000});
  const pdEval=pdData?.pdEvaluation||null;
  const pdAdvances=pdData?.pdAdvances||[];
  const stipulation=pdData?.stipulation||null;
  const [pdModal,setPdModal]=useState(null);
  const [pdForm,setPdForm]=useState({});
  const pdMut=useMutation({
    mutationFn:async(action)=>{
      if(action.type==='calculate') return calculatePD(claimId,action.pr4Id,action.apportionmentPercent);
      if(action.type==='advances') return initiatePDAdvances(claimId,action.pdEvaluationId,action.tdEndDate);
      if(action.type==='advPayment') return recordPDAdvancePayment(action.pdAdvanceId);
      if(action.type==='advWaive') return waivePDAdvance(action.pdAdvanceId,action.reason);
      if(action.type==='createStip') return createStipulation(claimId,action.pdEvaluationId,{futureMedical:action.futureMedical,futureMedicalDesc:action.futureMedicalDesc,bodyPartsAccepted:action.bodyPartsAccepted});
      if(action.type==='sendStip') return sendStipToWorker(action.stipId);
      if(action.type==='workerSign') return recordWorkerSignature(action.stipId);
      if(action.type==='adjusterSign') return recordAdjusterSignature(action.stipId);
      if(action.type==='eamsFiled') return recordEAMSFiled(action.stipId,action.filedDate);
    },
    onSuccess:()=>{qc.invalidateQueries({queryKey:['pd-data',claimId]});qc.invalidateQueries({queryKey:['claim-diaries',claimId]});qc.invalidateQueries({queryKey:['claim',claimId]});setPdModal(null);setPdForm({});notify('PD action completed');},
    onError:(e)=>notify(`PD action failed: ${e.message}`,'error'),
  });

  const today=new Date().toISOString().split('T')[0];

  if(claimLoading||!claim){
    return(
      <>
        <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(2,8,18,.75)",zIndex:200,backdropFilter:"blur(3px)"}}/>
        <div style={{position:"fixed",top:0,right:0,bottom:0,width:600,background:C.surface,borderLeft:`1px solid ${C.border}`,zIndex:201,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <Spinner/>
        </div>
      </>
    );
  }

  const a=claim.aiAnalysis;
  const emp=claim.employee||{};
  const empName=`${emp.firstName||''} ${emp.lastName||''}`.trim()||claim.claimant||claim.id;
  const totalRes=a?(a.suggestedMedicalReserve||0)+(a.suggestedIndemnityReserve||0)+(a.suggestedExpenseReserve||0):null;
  const nextStatuses=VALID_NEXT[claim.status]||[];

  const startReserveApproval=()=>{
    setResForm({
      medical:a?.suggestedMedicalReserve||'',
      indemnity:a?.suggestedIndemnityReserve||'',
      expense:a?.suggestedExpenseReserve||'',
      reason:'Adjuster reserve approval',
    });
    setResEditing(true);
  };

  const downloadReasoningPDF=async()=>{
    try{
      const res=await fetch(`/api/v1/claims/${claimId}/reasoning-pdf`,{credentials:'include'});
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download=`reasoning_${claim.claimNumber||claimId}.pdf`;
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify('AI Reasoning PDF downloaded');
    }catch(e){notify(`PDF failed: ${e.message}`,'error');}
  };

  return(
    <>
      <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(2,8,18,.75)",zIndex:200,backdropFilter:"blur(3px)"}}/>
      <div style={{position:"fixed",top:0,right:0,bottom:0,width:640,background:C.surface,borderLeft:`1px solid ${C.border}`,zIndex:201,overflowY:"auto",animation:"slideR .22s ease"}}>
        {/* Header */}
        <div style={{padding:"18px 26px",borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,background:C.surface,zIndex:1,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <div style={{fontFamily:C.mono,color:C.amber,fontSize:12,fontWeight:600}}>{claim.claimNumber||claim.id}</div>
              <SyncBadge source_system={claim.sourceSystem} sync_status={claim.syncStatus} small/>
            </div>
            <div style={{fontSize:19,fontWeight:700}}>{empName}</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>{claim.employerName||claim.employer||'—'} · {claim.dateOfInjury}</div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",paddingTop:4}}>
            <span style={{display:"inline-block",background:C.card,color:C.amber,border:`1px solid ${C.amber}33`,padding:"3px 9px",borderRadius:4,fontSize:10,fontFamily:C.mono,fontWeight:600,textTransform:"uppercase"}}>{STATUS_LABEL[claim.status]||claim.status}</span>
            <button onClick={onClose} style={{background:C.card,border:`1px solid ${C.border}`,color:C.dim,cursor:"pointer",width:28,height:28,borderRadius:6,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
          </div>
        </div>

        <div style={{padding:"22px 26px"}}>
          <Tabs tabs={[{key:"details",label:"Details"},{key:"benefits",label:`Benefits${tdActive?` · ${tdActive.benefit_type}`:''}`},{key:"qme",label:`QME/AME (${qmePanels.length})`},{key:"mmi",label:"MMI / P&S"},{key:"pd",label:"PD / Stip"}]} active={drawerTab} onChange={setDrawerTab}/>

          {drawerTab==="details"&&<>
          {/* Claim Facts */}
          <SectionHead title="Claim Facts"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 22px",marginBottom:12}}>
            <InfoPair label="DOI" value={claim.dateOfInjury} mono/>
            <InfoPair label="Employee ID" value={emp.adpEmployeeId} mono/>
            <InfoPair label="Body Part" value={claim.bodyPart}/>
            <InfoPair label="Injury Type" value={claim.injuryType}/>
            {claim.aww&&<InfoPair label="AWW" value={fmt$(claim.aww)} mono accent={C.cyan}/>}
            {claim.tdRate&&<InfoPair label="TD Rate/wk" value={fmt$(claim.tdRate)} mono accent={C.cyan}/>}
          </div>
          {claim.injuryDescription&&<InfoPair label="Description" value={claim.injuryDescription}/>}

          {/* Status Transitions */}
          {nextStatuses.length>0&&(
            <div style={{marginTop:16,marginBottom:16}}>
              <SectionHead title="Status Transition"/>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {nextStatuses.map(s=>(
                  <Btn key={s} small variant={s==="denied"?"danger":s==="accepted"?"success":"ghost"}
                       disabled={statusMut.isPending}
                       onClick={()=>statusMut.mutate(s)}>
                    {statusMut.isPending?<Spinner/>:STATUS_LABEL[s]||s}
                  </Btn>
                ))}
              </div>
            </div>
          )}

          {/* Diaries */}
          {diaries.length>0&&(
            <>
              <div style={{height:1,background:C.border,margin:"18px 0"}}/>
              <SectionHead title={`Diaries (${diaries.length})`}/>
              <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
                {diaries.map((d,i)=>{
                  const overdue=d.status==='open'&&d.dueDate<today;
                  return(
                    <div key={d.diaryId||i} style={{background:overdue?C.redF:C.bg,border:`1px solid ${overdue?C.red+'33':C.border}`,borderRadius:8,padding:"10px 14px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                        <span style={{fontFamily:C.mono,fontSize:11,fontWeight:600,color:overdue?C.red:C.text}}>{d.type}</span>
                        <div style={{display:"flex",gap:6,alignItems:"center"}}>
                          {d.priority&&<span style={{fontSize:10,fontFamily:C.mono,color:PRI_DIARY[d.priority]||C.muted,background:`${PRI_DIARY[d.priority]||C.border}22`,border:`1px solid ${PRI_DIARY[d.priority]||C.border}33`,padding:"1px 7px",borderRadius:3}}>{d.priority}</span>}
                          <span style={{fontSize:11,fontFamily:C.mono,color:overdue?C.red:C.dim}}>Due {d.dueDate}{overdue?' ⚠ OVERDUE':''}</span>
                        </div>
                      </div>
                      {d.notes&&<div style={{fontSize:11,color:C.dim,lineHeight:1.5}}>{d.notes}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* AI Analysis */}
          <div style={{height:1,background:C.border,margin:"18px 0"}}/>
          <SectionHead title="AI Analysis"/>
          {a?(
            <>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
                {[["Compensability",(a.compensability||"").replace("Likely ",""),COMP_COLOR[a.compensability]],["Score",`${a.compensabilityScore}%`,a.compensabilityScore>=80?C.green:C.amber],["Priority",a.priority,PRI_COLOR[a.priority]]].map(([l,v,c])=>(
                  <div key={l} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"11px 14px"}}>
                    <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:6}}>{l}</div>
                    <div style={{fontSize:13,fontWeight:700,color:c}}>{v||"—"}</div>
                  </div>
                ))}
              </div>
              {a.redFlags?.length>0&&<div style={{marginBottom:14}}><Lbl color={C.red}>⚠ Red Flags</Lbl>{a.redFlags.map((f,i)=><div key={i} style={{background:C.redF,border:`1px solid ${C.red}22`,borderRadius:6,padding:"8px 12px",marginBottom:6,fontSize:12,color:"#f87171"}}>{f}</div>)}</div>}
              {a.nextActions?.length>0&&<div style={{marginBottom:14}}><Lbl color={C.blue}>Actions</Lbl>{a.nextActions.map((act,i)=><div key={i} style={{display:"flex",gap:9,marginBottom:8,alignItems:"flex-start"}}><div style={{width:18,height:18,borderRadius:"50%",background:C.blueF,border:`1px solid ${C.blue}33`,color:C.blue,fontSize:9,fontFamily:C.mono,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div><div style={{fontSize:12,color:C.dim,lineHeight:1.6}}>{act}</div></div>)}</div>}
              {(a.analysisNotes||a.rationale)&&<div style={{background:C.blueF,border:`1px solid ${C.blue}22`,borderRadius:9,padding:"12px 15px",marginBottom:14}}><Lbl color={C.blue}>Rationale</Lbl><div style={{fontSize:12,color:C.dim,lineHeight:1.75}}>{a.analysisNotes||a.rationale}</div></div>}
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
                <Btn small variant="teal" onClick={downloadReasoningPDF}>📄 AI Reasoning PDF</Btn>
                <Btn small variant="ghost" onClick={()=>onGenDWC1(claim)}>📋 DWC-1 Form</Btn>
              </div>
            </>
          ):(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"24px 22px",textAlign:"center"}}>
              <div style={{fontSize:20,marginBottom:10}}>🤖</div>
              <div style={{fontSize:13,fontWeight:600,marginBottom:12}}>No AI analysis yet</div>
              <Btn onClick={()=>analyzeMut.mutate()} disabled={analyzeMut.isPending}>
                {analyzeMut.isPending?<span style={{display:"flex",alignItems:"center",gap:8}}><Spinner/>Analyzing…</span>:"Run AI Analysis"}
              </Btn>
            </div>
          )}

          {/* Reserve Approval */}
          <div style={{height:1,background:C.border,margin:"18px 0"}}/>
          <SectionHead title="Reserves"/>
          {!resEditing?(
            <div>
              {a&&totalRes!=null&&(
                <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:9,padding:"14px 18px",marginBottom:12}}>
                  <Lbl>AI Suggested</Lbl>
                  <div style={{display:"flex",gap:0}}>
                    {[["Medical",a.suggestedMedicalReserve],["Indemnity",a.suggestedIndemnityReserve],["Expense",a.suggestedExpenseReserve]].map(([l,v],i,arr)=>(
                      <div key={l} style={{flex:1,borderRight:i<arr.length-1?`1px solid ${C.border}`:"none",paddingRight:i<arr.length-1?14:0,marginRight:i<arr.length-1?14:0}}>
                        <div style={{fontSize:10,color:C.muted,marginBottom:3}}>{l}</div>
                        <div style={{fontFamily:C.mono,fontSize:15,fontWeight:600}}>{fmt$(v)}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:10,paddingTop:9,borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:11,color:C.muted}}>Total</span>
                    <span style={{fontFamily:C.mono,fontWeight:700,color:C.cyan,fontSize:16}}>{fmt$(totalRes)}</span>
                  </div>
                </div>
              )}
              <Btn small variant="outline" onClick={startReserveApproval} disabled={!a}>
                {a?"Approve / Adjust Reserves":"Run AI Analysis First"}
              </Btn>
            </div>
          ):(
            <div style={{background:C.card,border:`1px solid ${C.amber}33`,borderRadius:10,padding:"18px 20px"}}>
              <Lbl color={C.amber}>Adjuster Reserve Approval</Lbl>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
                {[["Medical","medical"],["Indemnity","indemnity"],["Expense","expense"]].map(([l,k])=>(
                  <Field key={k} label={l}><input type="number" min="0" value={resForm[k]} onChange={e=>setResForm(p=>({...p,[k]:e.target.value}))}/></Field>
                ))}
              </div>
              <Field label="Reason"><input value={resForm.reason} onChange={e=>setResForm(p=>({...p,reason:e.target.value}))}/></Field>
              <div style={{display:"flex",gap:8,marginTop:8}}>
                <Btn disabled={reserveMut.isPending} onClick={()=>reserveMut.mutate({medical:parseFloat(resForm.medical)||0,indemnity:parseFloat(resForm.indemnity)||0,expense:parseFloat(resForm.expense)||0,reason:resForm.reason})}>
                  {reserveMut.isPending?<Spinner/>:"Approve Reserves"}
                </Btn>
                <Btn variant="ghost" onClick={()=>setResEditing(false)}>Cancel</Btn>
              </div>
              {reserveMut.isSuccess&&<div style={{marginTop:8,fontSize:12,color:C.green}}>✓ Reserves approved and synced to CMS</div>}
            </div>
          )}
          </>}

          {/* ── Benefits Tab — TD period tracking ────────────────── */}
          {drawerTab==="benefits"&&<>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <SectionHead title="Temporary Disability"/>
              <Btn small variant="outline" onClick={()=>setTdModal('start')}>Start TD Period</Btn>
            </div>
            <TdSummaryCard summary={tdSummary}/>
            {tdPeriods.length===0 ? (
              <div style={{background:C.card,border:`1px dashed ${C.border}`,borderRadius:10,padding:"32px 20px",textAlign:"center",color:C.muted,fontSize:13}}>
                <div style={{fontSize:22,marginBottom:8}}>🗓</div>
                <div style={{fontWeight:600,color:C.dim,marginBottom:6}}>No TD periods recorded.</div>
                <div style={{fontSize:12}}>Click "Start TD Period" to begin tracking.</div>
              </div>
            ) : (
              <>
                <TdTimeline periods={tdPeriods}/>
                <TdPeriodsTable
                  periods={tdPeriods}
                  onClose={(p)=>setTdModal({kind:'close',period:p})}
                  onReinstate={(p)=>setTdModal({kind:'reinstate',period:p})}
                />
              </>
            )}

            {tdModal==='start' && <StartTdModal claim={claim} activePeriod={tdActive} pending={tdMut.isPending} onClose={()=>setTdModal(null)} onSubmit={(body)=>tdMut.mutate({type:'create',body})}/>}

            {tdModal && tdModal.kind==='close' && (
              <div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setTdModal(null)}>
                <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:440}} onClick={e=>e.stopPropagation()}>
                  <div style={{fontSize:16,fontWeight:700,marginBottom:14}}>Close TD Period</div>
                  <CloseTdForm period={tdModal.period} pending={tdMut.isPending} onCancel={()=>setTdModal(null)} onSubmit={(body)=>tdMut.mutate({type:'close',periodId:tdModal.period.id,body})}/>
                </div>
              </div>
            )}

            {tdModal && tdModal.kind==='reinstate' && (
              <div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setTdModal(null)}>
                <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:440}} onClick={e=>e.stopPropagation()}>
                  <div style={{fontSize:16,fontWeight:700,marginBottom:14}}>Reinstate TD Period</div>
                  <ReinstateTdForm period={tdModal.period} pending={tdMut.isPending} onCancel={()=>setTdModal(null)} onSubmit={(body)=>tdMut.mutate({type:'reinstate',periodId:tdModal.period.id,body})}/>
                </div>
              </div>
            )}
          </>}

          {/* ── M11: QME/AME Tab ─────────────────────────────────── */}
          {drawerTab==="qme"&&<>
            {/* Request Panel button */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <SectionHead title="QME/AME Panels"/>
              <Btn small variant="outline" onClick={()=>{setQmeModal('request');setQmeForm({specialty:'',notes:''});}}>Request QME Panel</Btn>
            </div>

            {/* Active panels */}
            {qmePanels.length===0?<div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"24px 22px",textAlign:"center",color:C.muted,fontSize:13}}>No QME/AME panels for this claim.</div>:qmePanels.map(p=>{
              const QS=[['panel_requested','Requested'],['panel_issued','Issued'],['strikes_pending','Strikes'],['doctor_selected','Doctor Selected'],['appointment_scheduled','Appt Scheduled'],['report_pending','Report Pending'],['report_received','Report Received'],['closed','Closed']];
              const si=QS.findIndex(([k])=>k===p.status);
              const deadlineDays=p.strike_deadline?Math.ceil((new Date(p.strike_deadline+'T00:00:00')-new Date())/(1000*60*60*24)):null;
              const deadlineUrgent=deadlineDays!=null&&deadlineDays<=3&&deadlineDays>=0&&p.status==='panel_issued';
              return(
                <div key={p.id} style={{background:C.card,border:`1px solid ${deadlineUrgent?C.red+'66':C.border}`,borderRadius:12,padding:"18px 20px",marginBottom:14}}>
                  {/* Header */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div>
                      <span style={{fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.amber}}>{p.track.toUpperCase()}</span>
                      <span style={{color:C.muted,fontSize:11,marginLeft:10}}>{p.specialty}</span>
                    </div>
                    <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,fontWeight:600,background:p.status==='report_received'?C.greenF:C.amberF,color:p.status==='report_received'?C.green:C.amber,border:`1px solid ${p.status==='report_received'?C.green:C.amber}33`}}>{p.status.replace(/_/g,' ').toUpperCase()}</span>
                  </div>

                  {/* Strike deadline warning */}
                  {deadlineUrgent&&<div style={{background:C.redF,border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:18}}>⚠</span>
                    <div><div style={{fontSize:12,fontWeight:700,color:C.red}}>STRIKE DEADLINE: {p.strike_deadline}</div><div style={{fontSize:11,color:C.rose}}>{deadlineDays===0?'DUE TODAY':deadlineDays===1?'DUE TOMORROW':`${deadlineDays} days remaining`} — CANNOT BE MISSED</div></div>
                  </div>}

                  {/* Progress steps */}
                  <div style={{display:"flex",gap:2,marginBottom:14}}>
                    {QS.map(([k,l],i)=><div key={k} style={{flex:1,height:4,borderRadius:2,background:i<=si?C.amber:C.border,transition:"background .3s"}} title={l}/>)}
                  </div>

                  {/* Panel info */}
                  {p.selected_name&&<InfoPair label="Selected Doctor" value={`${p.selected_name} (NPI: ${p.selected_npi})`} mono/>}
                  {p.appointment_date&&<InfoPair label="Appointment" value={p.appointment_date} mono/>}
                  {p.report_due_date&&<InfoPair label="Report Due" value={p.report_due_date} mono/>}
                  {p.report_received_at&&<InfoPair label="Report Received" value={new Date(p.report_received_at).toLocaleDateString()} mono accent={C.green}/>}

                  {/* Panel doctors (when issued) */}
                  {p.doctor_1_name&&!p.selected_name&&<div style={{marginBottom:10}}>
                    <Lbl>Panel Doctors</Lbl>
                    {[1,2,3].map(i=>{const nm=p[`doctor_${i}_name`];const npi=p[`doctor_${i}_npi`];return nm?<div key={i} style={{fontSize:12,color:C.dim,marginBottom:3}}>{nm} <span style={{fontFamily:C.mono,fontSize:10,color:C.muted}}>NPI: {npi}</span></div>:null;})}
                  </div>}

                  {/* Action buttons based on status */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
                    {p.status==='panel_requested'&&<Btn small variant="outline" onClick={()=>{setQmeModal('issue');setQmeForm({panelId:p.id,panelIssuedDate:'',d1name:'',d1npi:'',d1addr:'',d2name:'',d2npi:'',d2addr:'',d3name:'',d3npi:'',d3addr:''});}}>Record Panel Issue</Btn>}
                    {p.status==='panel_issued'&&<Btn small variant="outline" onClick={()=>{setQmeModal('strikes');setQmeForm({panelId:p.id,strike1:'',strike2:'',npis:[p.doctor_1_npi,p.doctor_2_npi,p.doctor_3_npi],names:[p.doctor_1_name,p.doctor_2_name,p.doctor_3_name]});}}>Record Strikes</Btn>}
                    {p.status==='doctor_selected'&&<Btn small variant="outline" onClick={()=>{setQmeModal('appointment');setQmeForm({panelId:p.id,appointmentDate:''});}}>Schedule Appointment</Btn>}
                    {(p.status==='appointment_scheduled'||p.status==='report_pending')&&<Btn small variant="success" disabled={qmeMut.isPending} onClick={()=>qmeMut.mutate({type:'report',panelId:p.id})}>Mark Report Received</Btn>}
                  </div>
                </div>
              );
            })}

            {/* Supplemental requests */}
            {suppReqs.length>0&&<>
              <div style={{height:1,background:C.border,margin:"18px 0"}}/>
              <SectionHead title={`Supplemental Requests (${suppReqs.length})`}/>
              {suppReqs.map(sr=>(
                <div key={sr.id} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"14px 16px",marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                    <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,fontWeight:600,background:sr.status==='sent'?C.greenF:sr.status==='dismissed'?C.redF:C.amberF,color:sr.status==='sent'?C.green:sr.status==='dismissed'?C.red:C.amber}}>{sr.status.toUpperCase()}</span>
                    <span style={{fontSize:10,fontFamily:C.mono,color:C.muted}}>{new Date(sr.created_at).toLocaleDateString()}</span>
                  </div>
                  {(sr.flags||[]).map((f,i)=><div key={i} style={{background:f.severity==='critical'?C.redF:C.amberF,border:`1px solid ${f.severity==='critical'?C.red:C.amber}22`,borderRadius:6,padding:"8px 12px",marginBottom:6,fontSize:11}}>
                    <span style={{fontFamily:C.mono,fontWeight:600,color:f.severity==='critical'?C.red:C.amber}}>{f.flag}</span>
                    <div style={{color:C.dim,marginTop:3}}>{f.description}</div>
                  </div>)}
                  {sr.status==='draft'&&<div style={{display:"flex",gap:8,marginTop:10}}>
                    <Btn small variant="success" disabled={qmeMut.isPending} onClick={()=>qmeMut.mutate({type:'approve-supp',id:sr.id})}>Approve & Send</Btn>
                    <Btn small variant="ghost" disabled={qmeMut.isPending} onClick={()=>{const r=prompt('Reason for dismissal:');if(r)qmeMut.mutate({type:'dismiss-supp',id:sr.id,reason:r});}}>Dismiss</Btn>
                  </div>}
                </div>
              ))}
            </>}

            {/* ── QME Modals ─── */}
            {qmeModal==='request'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setQmeModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:420,maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Request QME Panel</div>
                <Field label="Specialty"><select value={qmeForm.specialty||''} onChange={e=>setQmeForm(f=>({...f,specialty:e.target.value}))}>
                  <option value="">Select specialty...</option>
                  {['Orthopedic Surgery','Internal Medicine','Neurology','Pain Management','Psychiatry','Occupational Medicine','Physical Medicine & Rehabilitation','Chiropractic'].map(s=><option key={s} value={s}>{s}</option>)}
                </select></Field>
                <Field label="Adjuster Notes (optional)"><textarea rows={3} value={qmeForm.notes||''} onChange={e=>setQmeForm(f=>({...f,notes:e.target.value}))}/></Field>
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <Btn disabled={!qmeForm.specialty||qmeMut.isPending} onClick={()=>qmeMut.mutate({type:'request',specialty:qmeForm.specialty,notes:qmeForm.notes})}>{qmeMut.isPending?<Spinner/>:'Request Panel'}</Btn>
                  <Btn variant="ghost" onClick={()=>setQmeModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}

            {qmeModal==='issue'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setQmeModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:520,maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Record Panel Issue</div>
                <Field label="Panel Issued Date"><input type="date" value={qmeForm.panelIssuedDate||''} onChange={e=>setQmeForm(f=>({...f,panelIssuedDate:e.target.value}))}/></Field>
                {[1,2,3].map(i=><div key={i} style={{marginBottom:14,padding:"12px 14px",background:C.bg,borderRadius:8,border:`1px solid ${C.border}`}}>
                  <Lbl>Doctor {i}</Lbl>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <Field label="Name"><input value={qmeForm[`d${i}name`]||''} onChange={e=>setQmeForm(f=>({...f,[`d${i}name`]:e.target.value}))}/></Field>
                    <Field label="NPI"><input value={qmeForm[`d${i}npi`]||''} onChange={e=>setQmeForm(f=>({...f,[`d${i}npi`]:e.target.value}))}/></Field>
                  </div>
                </div>)}
                <div style={{display:"flex",gap:8,marginTop:8}}>
                  <Btn disabled={!qmeForm.panelIssuedDate||!qmeForm.d1name||!qmeForm.d1npi||!qmeForm.d2name||!qmeForm.d2npi||!qmeForm.d3name||!qmeForm.d3npi||qmeMut.isPending} onClick={()=>qmeMut.mutate({type:'issue',panelId:qmeForm.panelId,panelIssuedDate:qmeForm.panelIssuedDate,doctor1:{name:qmeForm.d1name,npi:qmeForm.d1npi,address:qmeForm.d1addr},doctor2:{name:qmeForm.d2name,npi:qmeForm.d2npi,address:qmeForm.d2addr},doctor3:{name:qmeForm.d3name,npi:qmeForm.d3npi,address:qmeForm.d3addr}})}>{qmeMut.isPending?<Spinner/>:'Issue Panel'}</Btn>
                  <Btn variant="ghost" onClick={()=>setQmeModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}

            {qmeModal==='strikes'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setQmeModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:440}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>Record Strikes</div>
                <div style={{fontSize:12,color:C.muted,marginBottom:18}}>Select 2 doctors to strike. The remaining doctor will be selected.</div>
                {(qmeForm.npis||[]).map((npi,i)=>{const checked=qmeForm.strike1===npi||qmeForm.strike2===npi;return(
                  <label key={npi} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:checked?C.redF:C.bg,border:`1px solid ${checked?C.red+'33':C.border}`,borderRadius:8,marginBottom:8,cursor:"pointer"}}>
                    <input type="checkbox" checked={checked} onChange={()=>{
                      if(checked){setQmeForm(f=>f.strike1===npi?{...f,strike1:''}:{...f,strike2:''});}
                      else{setQmeForm(f=>!f.strike1?{...f,strike1:npi}:!f.strike2?{...f,strike2:npi}:f);}
                    }}/>
                    <div><div style={{fontSize:13,fontWeight:600,color:checked?C.red:C.text}}>{qmeForm.names?.[i]}</div><div style={{fontSize:10,fontFamily:C.mono,color:C.muted}}>NPI: {npi}</div></div>
                    {checked&&<span style={{marginLeft:"auto",fontSize:10,color:C.red,fontFamily:C.mono,fontWeight:600}}>STRUCK</span>}
                  </label>
                );})}
                <div style={{display:"flex",gap:8,marginTop:14}}>
                  <Btn disabled={!qmeForm.strike1||!qmeForm.strike2||qmeMut.isPending} onClick={()=>qmeMut.mutate({type:'strikes',panelId:qmeForm.panelId,strike1Npi:qmeForm.strike1,strike2Npi:qmeForm.strike2})}>{qmeMut.isPending?<Spinner/>:'Confirm Strikes'}</Btn>
                  <Btn variant="ghost" onClick={()=>setQmeModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}

            {qmeModal==='appointment'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setQmeModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:400}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Schedule QME Appointment</div>
                <Field label="Appointment Date"><input type="date" value={qmeForm.appointmentDate||''} onChange={e=>setQmeForm(f=>({...f,appointmentDate:e.target.value}))}/></Field>
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <Btn disabled={!qmeForm.appointmentDate||qmeMut.isPending} onClick={()=>qmeMut.mutate({type:'appointment',panelId:qmeForm.panelId,appointmentDate:qmeForm.appointmentDate})}>{qmeMut.isPending?<Spinner/>:'Schedule'}</Btn>
                  <Btn variant="ghost" onClick={()=>setQmeModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}
          </>}

          {/* ── M12: MMI / P&S Tab ───────────────────────────────── */}
          {drawerTab==="mmi"&&<>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <SectionHead title="MMI Signal Evaluation"/>
              <Btn small variant="outline" disabled={mmiMut.isPending} onClick={()=>mmiMut.mutate({type:'evaluate'})}>{mmiMut.isPending?<><Spinner/> Evaluating...</>:'Run MMI Evaluation'}</Btn>
            </div>

            {mmiEvals.length===0?<div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"24px 22px",textAlign:"center",color:C.muted,fontSize:13}}>No MMI evaluations yet. Run an evaluation to detect P&S signals.</div>:mmiEvals.map(ev=>{
              const recColor=ev.recommendation==='solicit_pr4'?C.red:ev.recommendation==='monitor'?C.amber:C.green;
              const recBg=ev.recommendation==='solicit_pr4'?C.redF:ev.recommendation==='monitor'?C.amberF:C.greenF;
              return(
                <div key={ev.id} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 20px",marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{display:"flex",gap:10,alignItems:"center"}}>
                      <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,fontWeight:600,background:recBg,color:recColor,border:`1px solid ${recColor}33`}}>{ev.recommendation.replace(/_/g,' ').toUpperCase()}</span>
                      <span style={{fontFamily:C.mono,fontSize:11,color:C.muted}}>{ev.signal_count} signal{ev.signal_count!==1?'s':''}</span>
                    </div>
                    <span style={{fontSize:10,fontFamily:C.mono,color:C.muted}}>{new Date(ev.evaluated_at).toLocaleDateString()}</span>
                  </div>
                  {(ev.signals||[]).map((s,i)=>(
                    <div key={i} style={{background:s.weight>=2?C.amberF:C.bg,border:`1px solid ${s.weight>=2?C.amber:C.border}33`,borderRadius:6,padding:"8px 12px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div><span style={{fontFamily:C.mono,fontSize:10,fontWeight:600,color:s.weight>=2?C.amber:C.dim}}>{s.type}</span><div style={{fontSize:11,color:C.dim,marginTop:2}}>{s.description}</div></div>
                      <span style={{fontFamily:C.mono,fontSize:10,color:C.muted,flexShrink:0,marginLeft:10}}>wt {s.weight}</span>
                    </div>
                  ))}
                  {ev.rationale&&<div style={{background:C.blueF,border:`1px solid ${C.blue}22`,borderRadius:8,padding:"10px 14px",marginTop:8,fontSize:11,color:C.dim,lineHeight:1.6}}>{ev.rationale}</div>}
                  {ev.adjuster_action?<div style={{marginTop:10,fontSize:11,fontFamily:C.mono,color:ev.adjuster_action==='dismissed'?C.muted:C.green}}>{ev.adjuster_action==='dismissed'?'Dismissed':'PR-4 Solicited'}{ev.adjuster_note?` — ${ev.adjuster_note}`:''}</div>:(
                    ev.recommendation!=='no_action'&&<div style={{display:"flex",gap:8,marginTop:12}}>
                      {ev.recommendation==='solicit_pr4'&&<Btn small variant="success" onClick={()=>{setMmiModal('solicit');setMmiForm({evalId:ev.id,physicianName:'',physicianFax:'',physicianAddress:''});}}>Solicit PR-4</Btn>}
                      <Btn small variant="ghost" onClick={()=>{const n=prompt('Note (optional):');mmiMut.mutate({type:'dismiss',evalId:ev.id,note:n||''});}}>Dismiss</Btn>
                    </div>
                  )}
                </div>
              );
            })}

            {pr4List.length>0&&<>
              <div style={{height:1,background:C.border,margin:"18px 0"}}/>
              <SectionHead title={`PR-4 Solicitations (${pr4List.length})`}/>
              {pr4List.map(pr=>{
                const overdue=pr.status==='sent'&&pr.response_due_date<today;
                return(
                  <div key={pr.id} style={{background:C.bg,border:`1px solid ${overdue?C.red+'44':C.border}`,borderRadius:8,padding:"14px 16px",marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                      <div><span style={{fontSize:13,fontWeight:600,color:C.text}}>{pr.physician_name}</span><span style={{fontSize:10,fontFamily:C.mono,color:C.muted,marginLeft:10}}>{pr.method?.toUpperCase()}</span></div>
                      <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,fontWeight:600,background:pr.status==='received'?C.greenF:overdue?C.redF:C.amberF,color:pr.status==='received'?C.green:overdue?C.red:C.amber}}>{overdue?'OVERDUE':pr.status.toUpperCase()}</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,fontSize:11,color:C.dim}}>
                      <div>Sent: <span style={{fontFamily:C.mono}}>{pr.solicitation_date}</span></div>
                      <div>Due: <span style={{fontFamily:C.mono,color:overdue?C.red:C.text}}>{pr.response_due_date}</span></div>
                    </div>
                    {pr.status==='received'&&<div style={{marginTop:8,display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,fontSize:11}}>
                      <div>WPI: <span style={{fontFamily:C.mono,fontWeight:600,color:C.cyan}}>{pr.wpi!=null?pr.wpi+'%':'—'}</span></div>
                      <div>Apportionment: <span style={{fontFamily:C.mono,color:pr.apportionment_noted?C.amber:C.green}}>{pr.apportionment_noted?'Yes':'No'}</span></div>
                      {pr.work_restrictions&&<div style={{gridColumn:"1/3",color:C.dim}}>Restrictions: {pr.work_restrictions}</div>}
                      {pr.future_medical&&<div style={{gridColumn:"1/3",color:C.dim}}>Future Medical: {pr.future_medical}</div>}
                    </div>}
                    {pr.status==='sent'&&<div style={{marginTop:10}}><Btn small variant="outline" onClick={()=>{setMmiModal('response');setMmiForm({pr4Id:pr.id,wpi:'',workRestrictions:'',futureMedical:'',apportionmentNoted:false});}}>Record Response</Btn></div>}
                  </div>
                );
              })}
            </>}

            {mmiModal==='solicit'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setMmiModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:440}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Solicit PR-4 Report</div>
                <Field label="Physician Name"><input value={mmiForm.physicianName||''} onChange={e=>setMmiForm(f=>({...f,physicianName:e.target.value}))}/></Field>
                <Field label="Physician Fax"><input value={mmiForm.physicianFax||''} onChange={e=>setMmiForm(f=>({...f,physicianFax:e.target.value}))}/></Field>
                <Field label="Physician Address"><textarea rows={2} value={mmiForm.physicianAddress||''} onChange={e=>setMmiForm(f=>({...f,physicianAddress:e.target.value}))}/></Field>
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <Btn disabled={!mmiForm.physicianName||mmiMut.isPending} onClick={()=>mmiMut.mutate({type:'solicit',evalId:mmiForm.evalId,physicianName:mmiForm.physicianName,physicianFax:mmiForm.physicianFax,physicianAddress:mmiForm.physicianAddress})}>{mmiMut.isPending?<Spinner/>:'Send PR-4 Request'}</Btn>
                  <Btn variant="ghost" onClick={()=>setMmiModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}

            {mmiModal==='response'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setMmiModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:480}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Record PR-4 Response</div>
                <Field label="WPI (Whole Person Impairment %)"><input type="number" min="0" max="100" step="0.5" value={mmiForm.wpi||''} onChange={e=>setMmiForm(f=>({...f,wpi:e.target.value}))}/></Field>
                <Field label="Work Restrictions"><textarea rows={2} value={mmiForm.workRestrictions||''} onChange={e=>setMmiForm(f=>({...f,workRestrictions:e.target.value}))}/></Field>
                <Field label="Future Medical"><textarea rows={2} value={mmiForm.futureMedical||''} onChange={e=>setMmiForm(f=>({...f,futureMedical:e.target.value}))}/></Field>
                <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:C.dim,marginTop:8,cursor:"pointer"}}>
                  <input type="checkbox" checked={mmiForm.apportionmentNoted||false} onChange={e=>setMmiForm(f=>({...f,apportionmentNoted:e.target.checked}))}/>
                  Apportionment noted in PR-4
                </label>
                <div style={{display:"flex",gap:8,marginTop:16}}>
                  <Btn disabled={mmiMut.isPending} onClick={()=>mmiMut.mutate({type:'response',pr4Id:mmiForm.pr4Id,wpi:mmiForm.wpi?parseFloat(mmiForm.wpi):null,workRestrictions:mmiForm.workRestrictions,futureMedical:mmiForm.futureMedical,apportionmentNoted:mmiForm.apportionmentNoted})}>{mmiMut.isPending?<Spinner/>:'Record Response'}</Btn>
                  <Btn variant="ghost" onClick={()=>setMmiModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}
          </>}

          {/* ── M13: PD / Stip Tab ───────────────────────────────── */}
          {drawerTab==="pd"&&<>
            {/* PD Calculation */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <SectionHead title="Permanent Disability"/>
              {!pdEval&&<Btn small variant="outline" onClick={()=>{setPdModal('calculate');setPdForm({pr4Id:'',apportionmentPercent:0});}}>Calculate PD</Btn>}
            </div>

            {pdEval?<div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 20px",marginBottom:14}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
                {[["WPI",pdEval.wpi!=null?pdEval.wpi+"%":"—",C.cyan],["PD Rating",pdEval.pd_percent!=null?pdEval.pd_percent+"%":"—",C.amber],["Total Value",pdEval.pd_total_value!=null?"$"+Number(pdEval.pd_total_value).toLocaleString():"—",C.green]].map(([l,v,c])=>(
                  <div key={l} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"11px 14px"}}>
                    <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",marginBottom:6}}>{l}</div>
                    <div style={{fontSize:15,fontWeight:700,color:c,fontFamily:C.mono}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:11,color:C.dim}}>
                <div>Weeks: <span style={{fontFamily:C.mono}}>{pdEval.pd_weeks}</span></div>
                <div>Rate: <span style={{fontFamily:C.mono}}>${pdEval.pd_weekly_rate}/wk</span></div>
                {parseFloat(pdEval.apportionment_percent)>0&&<>
                  <div>Apportionment: <span style={{fontFamily:C.mono,color:C.amber}}>{pdEval.apportionment_percent}%</span></div>
                  <div>Adjusted: <span style={{fontFamily:C.mono,color:C.cyan}}>${Number(pdEval.adjusted_total_value).toLocaleString()}</span></div>
                </>}
              </div>
            </div>:<div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"24px 22px",textAlign:"center",color:C.muted,fontSize:13}}>No PD evaluation yet. Calculate PD from a PR-4 response.</div>}

            {/* PD Advances */}
            {pdEval&&<>
              <div style={{height:1,background:C.border,margin:"18px 0"}}/>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <SectionHead title="PD Advances"/>
                {pdAdvances.length===0&&<Btn small variant="outline" onClick={()=>{setPdModal('advances');setPdForm({tdEndDate:''});}}>Initiate PD Advances</Btn>}
              </div>
              {pdAdvances.map(adv=>{
                const overdue=adv.status==='pending'&&adv.advance_due_date<today;
                return(
                  <div key={adv.id} style={{background:overdue?C.redF:C.bg,border:`1px solid ${overdue?C.red+'44':C.border}`,borderRadius:8,padding:"14px 16px",marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                      <span style={{fontSize:12,fontWeight:600,color:C.text}}>PD Advance — ${adv.weekly_rate}/wk</span>
                      <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,fontWeight:600,background:adv.status==='active'?C.greenF:adv.status==='waived'?C.amberF:overdue?C.redF:C.amberF,color:adv.status==='active'?C.green:adv.status==='waived'?C.muted:overdue?C.red:C.amber}}>{overdue?'OVERDUE':adv.status.toUpperCase()}</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,fontSize:11,color:C.dim}}>
                      <div>TD End: <span style={{fontFamily:C.mono}}>{adv.td_end_date}</span></div>
                      <div>Due: <span style={{fontFamily:C.mono,color:overdue?C.red:C.text}}>{adv.advance_due_date}</span></div>
                    </div>
                    {overdue&&<div style={{marginTop:6,fontSize:11,color:C.red,fontWeight:600}}>10% penalty exposure — LC §4650(b)</div>}
                    {adv.status==='pending'&&<div style={{display:"flex",gap:8,marginTop:10}}>
                      <Btn small variant="success" disabled={pdMut.isPending} onClick={()=>pdMut.mutate({type:'advPayment',pdAdvanceId:adv.id})}>Record Payment</Btn>
                      <Btn small variant="ghost" disabled={pdMut.isPending} onClick={()=>{const r=prompt('Reason for waiver:');if(r)pdMut.mutate({type:'advWaive',pdAdvanceId:adv.id,reason:r});}}>Waive</Btn>
                    </div>}
                    {adv.status==='waived'&&adv.waived_reason&&<div style={{marginTop:6,fontSize:11,color:C.muted}}>Waived: {adv.waived_reason}</div>}
                  </div>
                );
              })}
            </>}

            {/* Stipulation */}
            {pdEval&&<>
              <div style={{height:1,background:C.border,margin:"18px 0"}}/>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <SectionHead title="Stipulation"/>
                {!stipulation&&<Btn small variant="outline" onClick={()=>{setPdModal('createStip');setPdForm({futureMedical:false,futureMedicalDesc:'',bodyPartsAccepted:claim.bodyPart||''});}}>Draft Stipulation</Btn>}
              </div>

              {stipulation?(()=>{
                const SS=[['draft','Draft'],['sent_to_worker','Sent'],['worker_signed','Worker Signed'],['adjuster_signed','Adjuster Signed'],['eams_ready','EAMS Ready'],['filed','Filed'],['closed','Closed']];
                const si=SS.findIndex(([k])=>k===stipulation.status);
                return(
                  <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 20px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                      <span style={{fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>PD {stipulation.pd_percent}% = ${Number(stipulation.pd_total_value).toLocaleString()}</span>
                      <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,fontWeight:600,background:stipulation.status==='filed'||stipulation.status==='closed'?C.greenF:C.amberF,color:stipulation.status==='filed'||stipulation.status==='closed'?C.green:C.amber}}>{stipulation.status.replace(/_/g,' ').toUpperCase()}</span>
                    </div>
                    {/* Step progression */}
                    <div style={{display:"flex",gap:2,marginBottom:14}}>
                      {SS.map(([k],i)=><div key={k} style={{flex:1,height:4,borderRadius:2,background:i<=si?C.amber:C.border}}/>)}
                    </div>
                    {stipulation.future_medical&&<div style={{fontSize:11,color:C.cyan,marginBottom:8}}>Future medical reserved{stipulation.future_medical_desc?`: ${stipulation.future_medical_desc}`:''}</div>}
                    {/* Action buttons per status */}
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      {stipulation.status==='draft'&&<Btn small variant="outline" disabled={pdMut.isPending} onClick={()=>pdMut.mutate({type:'sendStip',stipId:stipulation.id})}>Send to Worker</Btn>}
                      {stipulation.status==='sent_to_worker'&&<Btn small variant="outline" disabled={pdMut.isPending} onClick={()=>pdMut.mutate({type:'workerSign',stipId:stipulation.id})}>Record Worker Signature</Btn>}
                      {stipulation.status==='worker_signed'&&<Btn small variant="outline" disabled={pdMut.isPending} onClick={()=>pdMut.mutate({type:'adjusterSign',stipId:stipulation.id})}>Adjuster Sign</Btn>}
                      {(stipulation.status==='eams_ready'||stipulation.status==='adjuster_signed')&&<Btn small variant="success" onClick={()=>{setPdModal('eamsFiled');setPdForm({filedDate:''});}}>Record EAMS Filed</Btn>}
                    </div>
                    {stipulation.eams_filed_at&&<div style={{marginTop:8,fontSize:11,color:C.green,fontFamily:C.mono}}>EAMS filed: {stipulation.eams_filed_at}</div>}
                  </div>
                );
              })():<div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"24px 22px",textAlign:"center",color:C.muted,fontSize:13}}>No stipulation yet.</div>}
            </>}

            {/* Modals */}
            {pdModal==='calculate'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setPdModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:420}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Calculate Permanent Disability</div>
                <Field label="PR-4 ID"><input value={pdForm.pr4Id||''} onChange={e=>setPdForm(f=>({...f,pr4Id:e.target.value}))}/></Field>
                <Field label="Apportionment %"><input type="number" min="0" max="100" value={pdForm.apportionmentPercent||0} onChange={e=>setPdForm(f=>({...f,apportionmentPercent:e.target.value}))}/></Field>
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <Btn disabled={!pdForm.pr4Id||pdMut.isPending} onClick={()=>pdMut.mutate({type:'calculate',pr4Id:pdForm.pr4Id,apportionmentPercent:parseFloat(pdForm.apportionmentPercent)||0})}>{pdMut.isPending?<Spinner/>:'Calculate'}</Btn>
                  <Btn variant="ghost" onClick={()=>setPdModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}

            {pdModal==='advances'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setPdModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:400}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Initiate PD Advances</div>
                <Field label="TD End Date"><input type="date" value={pdForm.tdEndDate||''} onChange={e=>setPdForm(f=>({...f,tdEndDate:e.target.value}))}/></Field>
                <div style={{fontSize:11,color:C.rose,marginBottom:12}}>First PD advance due 14 calendar days from TD end. 10% penalty if missed (LC §4650(b)).</div>
                <div style={{display:"flex",gap:8}}>
                  <Btn disabled={!pdForm.tdEndDate||pdMut.isPending} onClick={()=>pdMut.mutate({type:'advances',pdEvaluationId:pdEval.id,tdEndDate:pdForm.tdEndDate})}>{pdMut.isPending?<Spinner/>:'Initiate'}</Btn>
                  <Btn variant="ghost" onClick={()=>setPdModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}

            {pdModal==='createStip'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setPdModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:460}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Draft Stipulation</div>
                <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:C.dim,marginBottom:12,cursor:"pointer"}}>
                  <input type="checkbox" checked={pdForm.futureMedical||false} onChange={e=>setPdForm(f=>({...f,futureMedical:e.target.checked}))}/>
                  Reserve future medical treatment
                </label>
                {pdForm.futureMedical&&<Field label="Future Medical Description"><textarea rows={2} value={pdForm.futureMedicalDesc||''} onChange={e=>setPdForm(f=>({...f,futureMedicalDesc:e.target.value}))}/></Field>}
                <Field label="Accepted Body Parts"><input value={pdForm.bodyPartsAccepted||''} onChange={e=>setPdForm(f=>({...f,bodyPartsAccepted:e.target.value}))}/></Field>
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <Btn disabled={pdMut.isPending} onClick={()=>pdMut.mutate({type:'createStip',pdEvaluationId:pdEval.id,futureMedical:pdForm.futureMedical,futureMedicalDesc:pdForm.futureMedicalDesc,bodyPartsAccepted:pdForm.bodyPartsAccepted?pdForm.bodyPartsAccepted.split(',').map(s=>s.trim()):null})}>{pdMut.isPending?<Spinner/>:'Draft Stip'}</Btn>
                  <Btn variant="ghost" onClick={()=>setPdModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}

            {pdModal==='eamsFiled'&&<div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setPdModal(null)}>
              <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:28,width:400}} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:16,fontWeight:700,marginBottom:18}}>Record EAMS Filing</div>
                <Field label="Date Filed at DWC"><input type="date" value={pdForm.filedDate||''} onChange={e=>setPdForm(f=>({...f,filedDate:e.target.value}))}/></Field>
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <Btn disabled={!pdForm.filedDate||pdMut.isPending} onClick={()=>pdMut.mutate({type:'eamsFiled',stipId:stipulation.id,filedDate:pdForm.filedDate})}>{pdMut.isPending?<Spinner/>:'Record Filed'}</Btn>
                  <Btn variant="ghost" onClick={()=>setPdModal(null)}>Cancel</Btn>
                </div>
              </div>
            </div>}
          </>}
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// EMPLOYER PORTAL
// ═══════════════════════════════════════════════════════════
// ── Link status derived from claim.events ─────────────────────────────────────
