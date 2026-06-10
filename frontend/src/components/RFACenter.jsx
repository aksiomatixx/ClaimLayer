import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { approveRFA, fetchRFAs, routeToURO } from '../services/rfas.js';
import { C } from '../theme.js';
import { Btn, InfoPair, SectionHead, Spinner, StatCard } from '../ui/primitives.jsx';

export function RFADrawer({rfa,onClose,onApprove,onRouteURO,approving,routing}){
  if(!rfa)return null;
  const ev=rfa.evaluation;
  const decisionColor={'auto_approved':C.green,'adjuster_approved':C.green,'sent_to_uro':C.purple,'pending_adjuster_review':C.amber,'deferred':C.muted}[rfa.decision]||C.muted;
  return(
    <div style={{position:"fixed",top:0,right:0,bottom:0,width:560,background:C.surface,borderLeft:`1px solid ${C.border}`,zIndex:9000,display:"flex",flexDirection:"column",animation:"slideR .22s ease"}}>
      <div style={{padding:"20px 24px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontFamily:C.mono,fontSize:12,color:C.muted,marginBottom:4}}>RFA DETAIL</div>
          <div style={{fontFamily:C.mono,fontSize:13,fontWeight:700,color:C.text}}>{rfa.id?.slice(0,16)}…</div>
        </div>
        <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",color:C.dim,fontSize:22,lineHeight:1,padding:"0 4px"}}>×</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"22px 24px"}}>
        <InfoPair label="Claim" value={rfa.claim_id} mono/>
        <InfoPair label="Treatment" value={rfa.treatment_description}/>
        <InfoPair label="CPT Codes" value={(rfa.cpt_codes||[]).join(', ')||'—'} mono/>
        <InfoPair label="ICD-10 Codes" value={(rfa.icd10_codes||[]).join(', ')||'—'} mono/>
        <InfoPair label="Requesting Physician" value={rfa.requesting_physician||'—'}/>
        <InfoPair label="Received Via" value={rfa.received_via} mono/>
        <InfoPair label="Urgency" value={rfa.urgency} mono accent={rfa.urgency==='expedited'?C.red:C.blue}/>
        <InfoPair label="Response Due" value={rfa.response_due_at?new Date(rfa.response_due_at).toLocaleString():'—'} mono accent={rfa.response_due_at&&new Date(rfa.response_due_at)<new Date()?C.red:C.dim}/>
        <InfoPair label="Decision" value={rfa.decision||'Pending'} mono accent={decisionColor}/>
        {rfa.enlyte_referral_id&&<InfoPair label="Enlyte Referral" value={rfa.enlyte_referral_id} mono accent={C.purple}/>}
        {ev&&(
          <div style={{marginTop:18,background:C.bg,borderRadius:8,padding:16,border:`1px solid ${C.border}`}}>
            <SectionHead title="AI Evaluation"/>
            <InfoPair label="MTUS Consistent" value={ev.mtus_consistent===true?"Yes":ev.mtus_consistent===false?"No":"—"} accent={ev.mtus_consistent?C.green:C.red}/>
            <InfoPair label="AI Recommendation" value={ev.recommendation} mono accent={C.blue}/>
            {ev.rationale&&<InfoPair label="Rationale" value={ev.rationale}/>}
          </div>
        )}
      </div>
      {rfa.decision==='pending_adjuster_review'&&(
        <div style={{padding:"18px 24px",borderTop:`1px solid ${C.border}`,display:"flex",gap:10}}>
          <Btn variant="green" disabled={approving} onClick={onApprove}>{approving?"Approving…":"Approve Treatment"}</Btn>
          <Btn variant="ghost" disabled={routing} onClick={onRouteURO}>{routing?"Routing…":"Route to URO"}</Btn>
        </div>
      )}
    </div>
  );
}

export function RFACenter({notify}){
  const qc=useQueryClient();
  const [selectedRfa,setSelectedRfa]=useState(null);
  const [approving,setApproving]=useState(false);
  const [routing,setRouting]=useState(false);

  const {data:rfas=[],isLoading}=useQuery({
    queryKey:['rfas','pending'],
    queryFn:()=>fetchRFAs({status:'pending_adjuster_review'}),
    refetchInterval:15_000,
    retry:false,
  });

  const overdueCount=rfas.filter(r=>r.response_due_at&&new Date(r.response_due_at)<new Date()).length;

  const handleApprove=async()=>{
    if(!selectedRfa)return;
    setApproving(true);
    try{
      await approveRFA(selectedRfa.id);
      notify('RFA approved');
      qc.invalidateQueries({queryKey:['rfas']});
      setSelectedRfa(null);
    }catch(e){notify(e.message,'error');}finally{setApproving(false);}
  };

  const handleRouteURO=async()=>{
    if(!selectedRfa)return;
    setRouting(true);
    try{
      await routeToURO(selectedRfa.id,'Adjuster escalation');
      notify('RFA routed to Enlyte URO');
      qc.invalidateQueries({queryKey:['rfas']});
      setSelectedRfa(null);
    }catch(e){notify(e.message,'error');}finally{setRouting(false);}
  };

  return(
    <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:26}}>
        <h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>RFA Queue</h1>
        <p style={{color:C.muted,fontSize:13}}>Requests for Authorization · MTUS Evaluation · Adjuster Review · Enlyte URO Routing</p>
      </div>
      <div style={{display:"flex",gap:14,marginBottom:24}}>
        <StatCard label="Pending Review" value={isLoading?"…":rfas.length} accent={rfas.length>0?C.amber:C.green} sub="Need adjuster decision" delay={0}/>
        <StatCard label="Overdue" value={isLoading?"…":overdueCount} accent={overdueCount>0?C.red:C.green} sub="Past response deadline" delay={.05}/>
      </div>
      {isLoading?(
        <div style={{paddingTop:40,textAlign:"center"}}><Spinner/></div>
      ):rfas.length===0?(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"48px 24px",textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>✓</div>
          <div style={{fontSize:15,fontWeight:600,color:C.text,marginBottom:6}}>Queue is clear</div>
          <div style={{fontSize:12,color:C.muted}}>No RFAs pending adjuster review</div>
        </div>
      ):(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
          <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>
            PENDING ADJUSTER REVIEW — {rfas.length}
          </div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
                  {["Claim","Treatment","CPT Codes","Physician","Urgency","Deadline",""].map(h=>(
                    <th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rfas.map((r,i)=>{
                  const overdue=r.response_due_at&&new Date(r.response_due_at)<new Date();
                  return(
                    <tr key={r.id} className="rh" onClick={()=>setSelectedRfa(r)}
                        style={{borderBottom:i<rfas.length-1?`1px solid ${C.border}`:"none",animation:`fadeUp .3s ease ${i*.04}s both`}}>
                      <td style={{padding:"12px 13px"}}><span style={{fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{r.claim_id}</span></td>
                      <td style={{padding:"12px 13px",fontSize:12,maxWidth:200}}><div style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:C.text}}>{r.treatment_description}</div></td>
                      <td style={{padding:"12px 13px"}}><span style={{fontFamily:C.mono,fontSize:11,color:C.cyan}}>{(r.cpt_codes||[]).slice(0,3).join(', ')||'—'}</span></td>
                      <td style={{padding:"12px 13px",fontSize:12,color:C.dim}}>{r.requesting_physician||'—'}</td>
                      <td style={{padding:"12px 13px"}}><span style={{fontFamily:C.mono,fontSize:11,fontWeight:600,color:r.urgency==='expedited'?C.red:C.blue,background:r.urgency==='expedited'?C.redF:C.blueF,padding:"2px 7px",borderRadius:4}}>{r.urgency}</span></td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:11,color:overdue?C.red:C.dim,fontWeight:overdue?700:400}}>
                        {r.response_due_at?new Date(r.response_due_at).toLocaleDateString():'—'}
                        {overdue&&<span style={{display:"block",fontSize:9,color:C.red,marginTop:1}}>OVERDUE</span>}
                      </td>
                      <td style={{padding:"12px 13px"}} onClick={e=>e.stopPropagation()}>
                        <Btn small variant="ghost" onClick={()=>setSelectedRfa(r)}>Review</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {selectedRfa&&<RFADrawer rfa={selectedRfa} onClose={()=>setSelectedRfa(null)} onApprove={handleApprove} onRouteURO={handleRouteURO} approving={approving} routing={routing}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// NOTICE CENTER (Admin)
// ═══════════════════════════════════════════════════════════
