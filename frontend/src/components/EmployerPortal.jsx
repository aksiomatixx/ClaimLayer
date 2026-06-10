import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BODY_PARTS, INJURY_TYPES } from '../mockData.js';
import { fetchClaims } from '../services/claims.js';
import { loginEmployer, previewEmployee, submitFROI } from '../services/employer.js';
import { fetchEmployerSummary, fetchExperienceModInputs, fetchLossRun } from '../services/reporting.js';
import { C, CSS } from '../theme.js';
import { Badge, Btn, Field, InfoPair, Lbl, Spinner, StatCard, Tabs } from '../ui/primitives.jsx';
import { fmt$, linkStatus } from '../utils.js';

export function EmployerLogin({onLogin}){
  const [email,setEmail]=useState('hr@brightcarehh.com');
  const [password,setPassword]=useState('test1234');
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);

  const submit=async(e)=>{
    e.preventDefault();
    setLoading(true);setError(null);
    try{
      const data=await loginEmployer(email,password);
      onLogin({employerId:data.employer_id,employerName:data.employer_name,email:data.email});
    }catch(err){
      setError(err.data?.error==='invalid_credentials'?'Invalid email or password.':err.message||'Login failed.');
    }finally{setLoading(false);}
  };

  return(
    <div style={{paddingTop:64,maxWidth:400,margin:"0 auto",animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:28,textAlign:"center"}}>
        <div style={{fontSize:22,fontWeight:700,marginBottom:6}}>Employer Portal</div>
        <div style={{fontSize:13,color:C.muted}}>Sign in to manage your workers' compensation claims</div>
      </div>
      <form onSubmit={submit} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:28}}>
        <Field label="Email"><input type="email" value={email} onChange={e=>setEmail(e.target.value)} required autoComplete="username"/></Field>
        <Field label="Password"><input type="password" value={password} onChange={e=>setPassword(e.target.value)} required autoComplete="current-password"/></Field>
        {error&&<div style={{marginBottom:14,padding:"10px 14px",background:C.redF,border:`1px solid ${C.red}44`,borderRadius:8,fontSize:12,color:C.red}}>{error}</div>}
        <Btn type="submit" disabled={loading} style={{width:"100%"}}>{loading?'Signing in…':'Sign In →'}</Btn>
      </form>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// FROI FORM
// ═══════════════════════════════════════════════════════════
export function FROIForm(){
  const today=new Date().toISOString().split('T')[0];
  const oneYearAgo=new Date(Date.now()-365*24*60*60*1000).toISOString().split('T')[0];

  const [adpId,setAdpId]=useState('');
  const [doi,setDoi]=useState('');
  const [bodyPart,setBodyPart]=useState('');
  const [injuryType,setInjuryType]=useState('');
  const [preview,setPreview]=useState(null);   // {found,first_name,last_name,job_title,email_masked}
  const [previewLoading,setPreviewLoading]=useState(false);
  const [submitState,setSubmitState]=useState('idle'); // idle|loading|success|error
  const [result,setResult]=useState(null);
  const [errorMsg,setErrorMsg]=useState(null);

  const handleAdpBlur=async()=>{
    if(!adpId.trim()){setPreview(null);return;}
    setPreviewLoading(true);
    try{setPreview(await previewEmployee(adpId.trim()));}
    catch{setPreview({found:false});}
    finally{setPreviewLoading(false);}
  };

  const handleSubmit=async(e)=>{
    e.preventDefault();
    setSubmitState('loading');setErrorMsg(null);
    try{
      const data=await submitFROI({adpEmployeeId:adpId.trim(),dateOfInjury:doi,bodyPart:bodyPart||undefined,injuryType:injuryType||undefined});
      setResult(data);setSubmitState('success');
    }catch(err){
      setErrorMsg(err.data?.error||err.message||'Submission failed');
      setSubmitState('error');
    }
  };

  if(submitState==='success'&&result){
    const ls=linkStatus({events:[{type:'magic_link_sent'}]});
    return(
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:28,animation:"fadeUp .3s ease"}}>
        <Lbl color={C.green} style={{fontSize:16,marginBottom:16}}>Claim Created</Lbl>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 24px",marginBottom:20}}>
          <InfoPair label="Claim Number" value={result.claim_number} mono accent={C.amber}/>
          <InfoPair label="Employee" value={`${result.employee_name} · ${result.adp_data?.job_title||'—'}`}/>
        </div>
        {result.warning==='no_employee_email'?(
          <div style={{marginBottom:18,padding:"14px 16px",background:C.amberF,border:`1px solid ${C.amber}44`,borderRadius:8}}>
            <div style={{fontSize:12,fontWeight:700,color:C.amber,marginBottom:6}}>No email on file</div>
            <div style={{fontSize:12,color:C.dim,marginBottom:10}}>{result.warning_message}</div>
            <div style={{fontFamily:C.mono,fontSize:10,color:C.cyan,background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:"8px 12px",wordBreak:"break-all",marginBottom:10}}>{result.magic_link_url}</div>
            <Btn small onClick={()=>navigator.clipboard?.writeText(result.magic_link_url)}>Copy Link</Btn>
          </div>
        ):(
          <div style={{marginBottom:18,padding:"14px 16px",background:C.greenF,border:`1px solid ${C.green}44`,borderRadius:8}}>
            <div style={{fontSize:12,color:C.dim}}>Magic link sent to <strong style={{color:C.text}}>{result.email_masked}</strong></div>
            <div style={{fontSize:11,color:C.muted,marginTop:4}}>Expires in 72 hours · {new Date(result.expires_at).toLocaleString()}</div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <Btn small onClick={()=>navigator.clipboard?.writeText(result.magic_link_url)}>Copy Link</Btn>
              <Btn small variant="ghost" onClick={()=>{setSubmitState('idle');setResult(null);setAdpId('');setDoi('');setBodyPart('');setInjuryType('');setPreview(null);}}>File Another Injury</Btn>
            </div>
          </div>
        )}
        <div style={{marginTop:18,borderTop:`1px solid ${C.border}`,paddingTop:16}}>
          <div style={{fontSize:11,color:C.muted,marginBottom:8,fontWeight:600}}>WHAT HAPPENS NEXT</div>
          {["Employee opens link and describes their injury","System books MPN provider and generates DWC-1","Track progress in the Claims tab"].map((s,i)=>(
            <div key={i} style={{display:"flex",gap:10,marginBottom:6,alignItems:"flex-start"}}>
              <span style={{fontFamily:C.mono,fontSize:10,color:C.amber,minWidth:16}}>{i+1}.</span>
              <span style={{fontSize:12,color:C.dim}}>{s}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const steps=['Pulling ADP data…','Creating claim…','Sending link…'];
  const loadingStep=submitState==='loading'?1:0;

  return(
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:28}}>
      <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>File First Report of Injury (FROI)</div>
      <div style={{fontSize:12,color:C.muted,marginBottom:20}}>Employee receives a secure magic link. ADP data auto-populates — they only describe their injury.</div>
      {submitState==='loading'&&(
        <div style={{marginBottom:18,display:"flex",gap:14,alignItems:"center",padding:"12px 16px",background:C.bg,borderRadius:8,border:`1px solid ${C.border}`}}>
          <Spinner/>
          <div>{steps.map((s,i)=><div key={i} style={{fontSize:12,color:i===loadingStep?C.text:C.muted}}>{s}</div>)}</div>
        </div>
      )}
      {submitState==='error'&&<div style={{marginBottom:14,padding:"10px 14px",background:C.redF,border:`1px solid ${C.red}44`,borderRadius:8,fontSize:12,color:C.red}}>{errorMsg}</div>}
      <form onSubmit={handleSubmit}>
        <Field label="ADP Employee ID *">
          <input value={adpId} onChange={e=>setAdpId(e.target.value)} onBlur={handleAdpBlur} placeholder="e.g. BC-001" required/>
          {previewLoading&&<div style={{fontSize:11,color:C.muted,marginTop:5}}>Looking up in ADP…</div>}
          {preview&&!previewLoading&&(
            preview.found
              ?<div style={{fontSize:11,marginTop:5,color:C.green}}>&#10003; {preview.first_name} {preview.last_name} — {preview.job_title||'—'}{preview.email_masked?` · ${preview.email_masked}`:''}</div>
              :<div style={{fontSize:11,marginTop:5,color:C.amber}}>&#9888; Employee not found in ADP</div>
          )}
        </Field>
        <Field label="Date of Injury *">
          <input type="date" value={doi} onChange={e=>setDoi(e.target.value)} max={today} min={oneYearAgo} required/>
        </Field>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 20px"}}>
          <Field label="Body Part Affected">
            <select value={bodyPart} onChange={e=>setBodyPart(e.target.value)}>
              <option value="">Select… (optional)</option>
              {BODY_PARTS.map(b=><option key={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Injury Type">
            <select value={injuryType} onChange={e=>setInjuryType(e.target.value)}>
              <option value="">Select… (optional)</option>
              {INJURY_TYPES.map(t=><option key={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        <Btn type="submit" disabled={submitState==='loading'||!adpId.trim()||!doi}>Submit &amp; Send Employee Link →</Btn>
      </form>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// M10: EMPLOYER REPORTS — Summary, Loss Run, Experience Mod
// ═══════════════════════════════════════════════════════════
export function EmployerReports({employerId}){
  const [tab,setTab]=useState("summary");

  const {data:summary,isLoading:sumLoading}=useQuery({
    queryKey:['employer-summary',employerId],
    queryFn:()=>fetchEmployerSummary(employerId),
    enabled:!!employerId,
    staleTime:60_000,
  });

  const {data:lossRunData,isLoading:lrLoading}=useQuery({
    queryKey:['employer-loss-run',employerId],
    queryFn:()=>fetchLossRun(employerId),
    enabled:!!employerId,
    staleTime:60_000,
  });

  const {data:emod,isLoading:emodLoading}=useQuery({
    queryKey:['employer-emod',employerId],
    queryFn:()=>fetchExperienceModInputs(employerId),
    enabled:!!employerId,
    staleTime:60_000,
  });

  const lossRun=lossRunData?.lossRun||[];

  // CSV export
  const exportCSV=()=>{
    if(!lossRun.length) return;
    const headers=["Claim Number","Worker","Date of Injury","Injury Type","Body Part","Status","Medical","Indemnity","Expense","Total Incurred","Open/Closed"];
    const rows=lossRun.map(r=>[
      r.claimNumber,r.worker,r.dateOfInjury,r.injuryType||'',r.bodyPart||'',r.status,
      r.medical.toFixed(2),r.indemnity.toFixed(2),r.expense.toFixed(2),r.totalIncurred.toFixed(2),
      r.isOpen?'Open':'Closed'
    ]);
    const csv=[headers,...rows].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download=`loss_run_${employerId}_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();URL.revokeObjectURL(url);
  };

  return(
    <div>
      {/* Summary cards */}
      {sumLoading?<div style={{padding:36,textAlign:"center"}}><Spinner/></div>:summary&&(
        <div style={{display:"flex",gap:14,marginBottom:24}}>
          <StatCard label="Open Claims" value={summary.openClaimCount} accent={summary.openClaimCount>0?C.amber:C.green} delay={0}/>
          <StatCard label="Total Incurred YTD" value={fmt$(summary.totalIncurredYTD)} accent={C.cyan} delay={.05}/>
          <StatCard label="TD Weeks Paid YTD" value={summary.tdWeeksPaidYTD} accent={C.blue} delay={.1}/>
          <StatCard label="Avg Days to 1st Payment" value={summary.avgDaysToFirstPayment!=null?summary.avgDaysToFirstPayment:'—'} accent={summary.avgDaysToFirstPayment!=null&&summary.avgDaysToFirstPayment>14?C.red:C.green} sub={summary.avgDaysToFirstPayment!=null&&summary.avgDaysToFirstPayment>14?"Exceeds 14-day target":""} delay={.15}/>
        </div>
      )}

      <Tabs tabs={[{key:"summary",label:"Loss Run"},{key:"emod",label:"Experience Mod"}]} active={tab} onChange={setTab}/>

      {tab==="summary"&&(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
          <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>LOSS RUN — {lossRun.length} CLAIMS</span>
            <Btn small variant="outline" onClick={exportCSV} disabled={!lossRun.length}>Export CSV</Btn>
          </div>
          {lrLoading?<div style={{padding:36,textAlign:"center"}}><Spinner/></div>:lossRun.length===0
            ?<div style={{padding:36,textAlign:"center",color:C.muted}}>No claims on file.</div>
            :(
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
                    {["Claim #","Worker","DOI","Injury","Status","Medical","Indemnity","Expense","Total","Open"].map(h=>
                      <th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>
                    )}
                  </tr></thead>
                  <tbody>{lossRun.map((r,i)=>(
                    <tr key={r.claimId} className="rh" style={{borderBottom:i<lossRun.length-1?`1px solid ${C.border}`:"none"}}>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{r.claimNumber}</td>
                      <td style={{padding:"12px 13px",fontSize:13,fontWeight:500}}>{r.worker}</td>
                      <td style={{padding:"12px 13px",fontSize:12,fontFamily:C.mono,color:C.dim}}>{r.dateOfInjury||'—'}</td>
                      <td style={{padding:"12px 13px",fontSize:12,color:C.dim}}>{[r.injuryType,r.bodyPart].filter(Boolean).join(' · ')||'—'}</td>
                      <td style={{padding:"12px 13px"}}><Badge status={r.status}/></td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.cyan}}>{fmt$(r.medical)}</td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.blue}}>{fmt$(r.indemnity)}</td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.purple}}>{fmt$(r.expense)}</td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>{fmt$(r.totalIncurred)}</td>
                      <td style={{padding:"12px 13px"}}><span style={{fontSize:10,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,background:r.isOpen?C.amberF:C.greenF,color:r.isOpen?C.amber:C.green,border:`1px solid ${r.isOpen?C.amber:C.green}33`}}>{r.isOpen?'Open':'Closed'}</span></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )
          }
        </div>
      )}

      {tab==="emod"&&(
        emodLoading?<div style={{padding:36,textAlign:"center"}}><Spinner/></div>:emod&&(
          <div>
            {/* Payroll by class code */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",marginBottom:22}}>
              <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>PAYROLL BY CLASS CODE — {emod.experiencePeriod?.label||''}</div>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
                  {["Class Code","Description","Rate","Annual Payroll","Est. Premium"].map(h=>
                    <th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                  )}
                </tr></thead>
                <tbody>{(emod.payrollByClass||[]).map((p,i)=>(
                  <tr key={p.classCode} style={{borderBottom:i<emod.payrollByClass.length-1?`1px solid ${C.border}`:"none"}}>
                    <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{p.classCode}</td>
                    <td style={{padding:"12px 13px",fontSize:12,color:C.dim}}>{p.description}</td>
                    <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.text}}>{p.rate}%</td>
                    <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.cyan}}>{fmt$(p.annualPayroll)}</td>
                    <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.green}}>{fmt$(p.premium)}</td>
                  </tr>
                ))}</tbody>
              </table>
              <div style={{padding:"12px 22px",borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between"}}>
                <span style={{fontFamily:C.mono,fontSize:11,color:C.muted}}>Total Payroll: <span style={{color:C.cyan,fontWeight:600}}>{fmt$(emod.totalPayroll)}</span></span>
                <span style={{fontFamily:C.mono,fontSize:11,color:C.muted}}>Total Premium: <span style={{color:C.green,fontWeight:600}}>{fmt$(emod.totalPremium)}</span></span>
              </div>
            </div>

            {/* Loss trend chart (CSS bar chart) */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:22}}>
              <div style={{fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text,marginBottom:18}}>LOSS TREND — 5 YEAR</div>
              {(()=>{
                const trend=emod.trendData||[];
                const maxLoss=Math.max(...trend.map(t=>t.totalLosses),1);
                const maxCount=Math.max(...trend.map(t=>t.claimCount),1);
                return(
                  <div style={{display:"flex",gap:12,alignItems:"flex-end",height:180}}>
                    {trend.map(t=>{
                      const barH=Math.max((t.totalLosses/maxLoss)*150,4);
                      const countH=Math.max((t.claimCount/maxCount)*150,4);
                      return(
                        <div key={t.year} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                          <div style={{fontSize:10,fontFamily:C.mono,color:C.cyan,fontWeight:600}}>{fmt$(t.totalLosses)}</div>
                          <div style={{display:"flex",gap:3,alignItems:"flex-end",height:150}}>
                            <div style={{width:20,height:barH,background:`linear-gradient(180deg,${C.cyan},${C.blue})`,borderRadius:"3px 3px 0 0",transition:"height .4s ease"}} title={`Losses: ${fmt$(t.totalLosses)}`}/>
                            <div style={{width:14,height:countH,background:`linear-gradient(180deg,${C.amber},${C.amberD})`,borderRadius:"3px 3px 0 0",transition:"height .4s ease"}} title={`Claims: ${t.claimCount}`}/>
                          </div>
                          <div style={{fontSize:11,fontFamily:C.mono,color:C.muted}}>{t.year}</div>
                          <div style={{fontSize:9,fontFamily:C.mono,color:C.dim}}>{t.claimCount} claims</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <div style={{display:"flex",gap:20,justifyContent:"center",marginTop:16}}>
                <span style={{display:"flex",alignItems:"center",gap:6,fontSize:10,color:C.muted}}><span style={{width:10,height:10,background:C.cyan,borderRadius:2,display:"inline-block"}}/> Losses</span>
                <span style={{display:"flex",alignItems:"center",gap:6,fontSize:10,color:C.muted}}><span style={{width:10,height:10,background:C.amber,borderRadius:2,display:"inline-block"}}/> Claims</span>
              </div>
            </div>

            {/* Losses by class code */}
            {(emod.lossesByClass||[]).length>0&&(
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",marginTop:22}}>
                <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>LOSSES BY CLASS CODE</div>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
                    {["Class Code","Description","Claims","Open","Total Losses"].map(h=>
                      <th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                    )}
                  </tr></thead>
                  <tbody>{emod.lossesByClass.map((l,i)=>(
                    <tr key={l.classCode} style={{borderBottom:i<emod.lossesByClass.length-1?`1px solid ${C.border}`:"none"}}>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{l.classCode}</td>
                      <td style={{padding:"12px 13px",fontSize:12,color:C.dim}}>{l.description}</td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:C.text}}>{l.claimCount}</td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,color:l.openClaims>0?C.amber:C.green}}>{l.openClaims}</td>
                      <td style={{padding:"12px 13px",fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.cyan}}>{fmt$(l.totalLosses)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// M10: ADMIN REPORTS — Cross-Employer, Missed Deadlines
// ═══════════════════════════════════════════════════════════

export function EmployerPortal({employerUser,setEmployerUser,onSelect}){
  const [view,setView]=useState("new");

  // Claims via React Query — scoped by employer auth on the backend.
  // MUST be called before any conditional return: React's rules-of-hooks
  // require the hook list to match across renders. The login-gate render
  // returned 1 hook (useState only); this render returned 2 (useState +
  // useQuery), which fired "Rendered more hooks than during the previous
  // render" the moment setEmployerUser flipped null → object.
  const {data:myClaims=[],isLoading:claimsLoading}=useQuery({
    queryKey:['employer-claims'],
    queryFn:fetchClaims,
    refetchInterval:30_000,
    enabled:!!employerUser,
  });

  // Auth gate — show login if no employer session
  if(!employerUser) return <EmployerLogin onLogin={setEmployerUser}/>;

  const {employerName}=employerUser;

  return(
    <div style={{paddingTop:32,maxWidth:960,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:22}}>
        <h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Employer Portal</h1>
        <p style={{color:C.muted,fontSize:13}}>{employerName}</p>
      </div>
      <Tabs tabs={[{key:"new",label:"Report Injury"},{key:"list",label:`All Claims (${myClaims.length})`},{key:"reports",label:"Reports"}]} active={view} onChange={setView}/>
      {view==="new"&&<FROIForm/>}
      {view==="list"&&(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
          {claimsLoading
            ?<div style={{padding:36,textAlign:"center"}}><Spinner/></div>
            :myClaims.length===0
              ?<div style={{padding:36,textAlign:"center",color:C.muted}}>No claims on file.</div>
              :(
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
                      {["Claim ID","Employee","DOI","Injury / Body Part","Status","Link Status","Filed",""].map(h=>(
                        <th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {myClaims.map((c,i)=>{
                      const ls=linkStatus(c);
                      const empName=c.employee?`${c.employee.firstName||''} ${c.employee.lastName||''}`.trim():c.claimant||'—';
                      const injLabel=[c.injuryType,c.bodyPart].filter(Boolean).join(' · ')||'—';
                      return(
                        <tr key={c.id} className="rh" style={{borderBottom:i<myClaims.length-1?`1px solid ${C.border}`:"none"}}>
                          <td style={{padding:"12px 14px",fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{c.claimNumber||c.id}</td>
                          <td style={{padding:"12px 14px",fontSize:13,fontWeight:500}}>{empName}</td>
                          <td style={{padding:"12px 14px",fontSize:12,fontFamily:C.mono,color:C.dim}}>{c.dateOfInjury||'—'}</td>
                          <td style={{padding:"12px 14px",fontSize:12,color:C.dim}}>{injLabel}</td>
                          <td style={{padding:"12px 14px"}}><Badge status={c.status}/></td>
                          <td style={{padding:"12px 14px"}}>
                            <span style={{fontSize:10,background:ls.bg,color:ls.color,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,border:`1px solid ${ls.color}33`}}>{ls.label}</span>
                          </td>
                          <td style={{padding:"12px 14px",fontSize:11,fontFamily:C.mono,color:C.muted}}>{c.filed_at?new Date(c.filed_at).toLocaleDateString():'—'}</td>
                          <td style={{padding:"12px 14px"}}><Btn small variant="ghost" onClick={()=>onSelect(c.id)}>View</Btn></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )
          }
        </div>
      )}
      {view==="reports"&&<EmployerReports employerId={employerUser.employerId}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TOP NAV
// ═══════════════════════════════════════════════════════════
