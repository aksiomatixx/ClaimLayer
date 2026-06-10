import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EMPLOYERS } from '../mockData.js';
import { fetchCrossEmployerReport, fetchMissedDeadlines } from '../services/reporting.js';
import { C } from '../theme.js';
import { Spinner, StatCard, Tabs } from '../ui/primitives.jsx';
import { fmt$ } from '../utils.js';

export function AdminReports({onSelect}){
  const [tab,setTab]=useState("overview");

  const {data:crossReport,isLoading:crossLoading}=useQuery({
    queryKey:['admin-cross-employer'],
    queryFn:fetchCrossEmployerReport,
    staleTime:60_000,
  });

  const {data:deadlines,isLoading:dlLoading}=useQuery({
    queryKey:['admin-missed-deadlines'],
    queryFn:fetchMissedDeadlines,
    staleTime:60_000,
  });

  return(
    <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:26}}>
        <h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Reporting</h1>
        <p style={{color:C.muted,fontSize:13}}>Cross-employer analytics · Compliance monitoring</p>
      </div>

      {/* Summary cards */}
      {crossReport&&(
        <div style={{display:"flex",gap:14,marginBottom:24}}>
          <StatCard label="Total Open Claims" value={crossReport.totalOpenClaims} accent={crossReport.totalOpenClaims>0?C.amber:C.green} delay={0}/>
          <StatCard label="All Claims" value={crossReport.totalAllClaims} delay={.05}/>
          <StatCard label="Total Incurred" value={fmt$(crossReport.totalIncurred)} accent={C.cyan} delay={.1}/>
          <StatCard label="Compliance Flags" value={deadlines?.totalViolations||0} accent={deadlines?.totalViolations>0?C.red:C.green} sub={deadlines?.totalViolations>0?"Action required":""} delay={.15}/>
        </div>
      )}

      <Tabs tabs={[{key:"overview",label:"Employer Overview"},{key:"compliance",label:`Missed Deadlines (${deadlines?.totalViolations||0})`}]} active={tab} onChange={setTab}/>

      {tab==="overview"&&(
        crossLoading?<div style={{padding:36,textAlign:"center"}}><Spinner/></div>:(
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>ALL EMPLOYERS — {crossReport?.employers?.length||0}</div>
            {(!crossReport?.employers?.length)?<div style={{padding:36,textAlign:"center",color:C.muted}}>No employer data.</div>:(
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
                  {["Employer","Total Claims","Open","Total Incurred"].map(h=>
                    <th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                  )}
                </tr></thead>
                <tbody>{crossReport.employers.map((e,i)=>(
                  <tr key={e.employerId} className="rh" style={{borderBottom:i<crossReport.employers.length-1?`1px solid ${C.border}`:"none"}}>
                    <td style={{padding:"12px 13px",fontSize:13,fontWeight:600,color:C.text}}>{e.employerName}</td>
                    <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.dim}}>{e.totalClaims}</td>
                    <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:e.openClaims>0?C.amber:C.green,fontWeight:600}}>{e.openClaims}</td>
                    <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.cyan}}>{fmt$(e.totalIncurred)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )
      )}

      {tab==="compliance"&&(
        dlLoading?<div style={{padding:36,textAlign:"center"}}><Spinner/></div>:(
          <div>
            {/* Violation type summary */}
            {deadlines&&(
              <div style={{display:"flex",gap:14,marginBottom:22}}>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 20px",flex:1}}>
                  <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",marginBottom:6}}>TD Late (LC §4650)</div>
                  <div style={{fontSize:22,fontFamily:C.mono,fontWeight:600,color:deadlines.byType?.TD_LATE>0?C.red:C.green}}>{deadlines.byType?.TD_LATE||0}</div>
                </div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 20px",flex:1}}>
                  <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",marginBottom:6}}>DWC-7 Late</div>
                  <div style={{fontSize:22,fontFamily:C.mono,fontWeight:600,color:deadlines.byType?.DWC7_LATE>0?C.red:C.green}}>{deadlines.byType?.DWC7_LATE||0}</div>
                </div>
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 20px",flex:1}}>
                  <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",marginBottom:6}}>RFA Expired</div>
                  <div style={{fontSize:22,fontFamily:C.mono,fontWeight:600,color:deadlines.byType?.RFA_EXPIRED>0?C.red:C.green}}>{deadlines.byType?.RFA_EXPIRED||0}</div>
                </div>
              </div>
            )}

            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
              <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>COMPLIANCE VIOLATIONS — {deadlines?.totalViolations||0}</div>
              {(!deadlines?.violations?.length)?<div style={{padding:36,textAlign:"center",color:C.green,fontFamily:C.mono,fontSize:13}}>No missed deadlines. All statutory timelines met.</div>:(
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
                    {["Claim","Worker","Type","Description","Days Over","Penalty"].map(h=>
                      <th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>
                    )}
                  </tr></thead>
                  <tbody>{deadlines.violations.map((v,i)=>(
                    <tr key={`${v.claimId}-${v.type}-${i}`} className="rh" style={{borderBottom:i<deadlines.violations.length-1?`1px solid ${C.border}`:"none"}} onClick={()=>v.claimId&&onSelect(v.claimId)}>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{v.claimNumber||v.claimId||'—'}</td>
                      <td style={{padding:"12px 13px",fontSize:12,color:C.dim}}>{v.worker||'—'}</td>
                      <td style={{padding:"12px 13px"}}><span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,fontWeight:600,background:v.type==='RFA_EXPIRED'?C.redF:v.type==='TD_LATE'?C.amberF:C.blueF,color:v.type==='RFA_EXPIRED'?C.red:v.type==='TD_LATE'?C.amber:C.blue,border:`1px solid ${v.type==='RFA_EXPIRED'?C.red:v.type==='TD_LATE'?C.amber:C.blue}33`}}>{v.type.replace(/_/g,' ')}</span></td>
                      <td style={{padding:"12px 13px",fontSize:12,color:C.dim}}>{v.description}</td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,fontWeight:700,color:C.red}}>{v.daysOverdue}d</td>
                      <td style={{padding:"12px 13px",fontSize:11,color:C.rose}}>{v.penalty}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// EMPLOYER PORTAL
// ═══════════════════════════════════════════════════════════
