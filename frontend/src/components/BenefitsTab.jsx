import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { closeTdPeriod, createTdPeriod, fetchTdPeriods, fetchTdSummary, reinstateTdPeriod } from '../services/td.js';
import { C, TD_TYPE_BG, TD_TYPE_COLOR } from '../theme.js';
import { fmt$ } from '../utils.js';
import { Btn, Field, Lbl, SectionHead, Spinner } from '../ui/primitives.jsx';

// ═══════════════════════════════════════════════════════════
// BENEFITS TAB — TD period tracking (extracted from ClaimDrawer
// so the statutory math UI is independently testable).
// ═══════════════════════════════════════════════════════════

function _tdCapColor(weeksPaid,cap){
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

export default function BenefitsTab({claimId,claim,notify}){
  const qc=useQueryClient();
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

  return(
    <>

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
          
    </>
  );
}
