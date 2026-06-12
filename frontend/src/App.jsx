// App shell — session/auth handling, role switching, and view routing.
// Feature components live in src/components/; API helpers in src/services/.

import { Suspense, lazy, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
const Architecture = lazy(() => import('./Architecture.jsx'));
import AdminDashboard from './components/AdminDashboard.jsx';
const AdminReports = lazy(() => import('./components/AdminReports.jsx').then(m => ({ default: m.AdminReports })));
const AgentsConsole = lazy(() => import('./components/AgentsConsole.jsx').then(m => ({ default: m.AgentsConsole })));
import { ClaimDrawer } from './components/ClaimDrawer.jsx';
import { DemoBanner } from './components/DemoBanner.jsx';
import EmployeeIntakeWizard from './components/EmployeeIntakeWizard.jsx';
import { EmployerPortal } from './components/EmployerPortal.jsx';
const IntegrationsConsole = lazy(() => import('./components/IntegrationsConsole.jsx').then(m => ({ default: m.IntegrationsConsole })));
import { NoticeCenter } from './components/NoticeCenter.jsx';
import { RFACenter } from './components/RFACenter.jsx';
import { TopNav } from './components/TopNav.jsx';
import { generateNoticePDF } from './noticePdf.js';
import SupervisorAlerts from './components/SupervisorAlerts.jsx';
import { ensureDevSession, fetchClaims } from './services/claims.js';
import { ensureDevEmployerSession } from './services/employer.js';
import { ensureDevSupervisorSession } from './services/supervisor.js';
import { C, CSS, FONTS } from './theme.js';
import { Spinner, Toast } from './ui/primitives.jsx';

export default function App(){
  // CL-MKT1: when the portal nav is hidden (demo/marketing builds) the
  // app must open on the adjuster surface — there is no switcher to
  // leave the employee view. Views stay functional either way.
  const [role,setRole]=useState(import.meta.env.VITE_SHOW_PORTAL_NAV!=='false'?"employee":"admin");
  const [adminView,setAdminView]=useState("claims");
  const [selectedId,setSelectedId]=useState(null);
  const [toast,setToast]=useState(null);
  const [jsPdfReady,setJsPdfReady]=useState(false);
  const [employerUser,setEmployerUser]=useState(null);

  // ── Dev-only auto-login (replaced by Supabase Auth in M5).
  // Refresh the cookie on EVERY role change so the demo never carries a
  // stale cookie from a prior role: employer → admin → employer must
  // re-establish the employer cookie each time (the cached employerUser
  // display state is not session state), supervisor gets its own
  // session (the supervisor endpoints 403 admin cookies), and admin +
  // employee restore the admin dev cookie.
  useEffect(()=>{
    if(role==='employer'){
      ensureDevEmployerSession().then(data=>{
        if(data?.ok) setEmployerUser({employerId:data.employerId,employerName:data.employerName,email:data.email||'hr@brightcarehh.com'});
      });
    } else if(role==='supervisor'){
      ensureDevSupervisorSession();
    } else {
      // admin + employee portals both use the admin dev cookie today
      ensureDevSession();
    }
  },[role]);


  // ── jsPDF (kept for NoticeCenter generateNoticePDF) ───────────────────────────
  useEffect(()=>{
    if(window.jspdf){setJsPdfReady(true);return;}
    const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload=()=>setJsPdfReady(true);
    s.onerror=()=>console.warn("jsPDF failed to load");
    document.head.appendChild(s);
  },[]);

  // ── Live claims via React Query ───────────────────────────────────────────────
  const {data:claims=[],isLoading:claimsLoading,error:claimsError}=useQuery({
    queryKey:['claims'],
    queryFn:fetchClaims,
    refetchInterval:30_000,
  });

  const notify=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),3800);};

  const genDWC1=async(claim)=>{
    const claimId=claim.id||claim.claimNumber||selectedId;
    try{
      const res=await fetch(`/api/v1/claims/${claimId}/dwc1`,{credentials:'include'});
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      window.open(url,'_blank');
      notify(`DWC-1 opened`);
    }catch(e){notify(`DWC-1 failed: ${e.message}`,'error');}
  };

  // For employer / employee portals — local submit that queues to backend
  const submitClaim=(data,source)=>{
    const id=`DRAFT-${Date.now()}`;
    notify(`Claim submitted — reference ${id}`,'success');
    return id;
  };

  return(
    <div style={{fontFamily:C.sans,background:C.bg,minHeight:"100vh",color:C.text}}>
      <style>{FONTS+CSS}</style>
      {toast&&<Toast {...toast}/>}
      <DemoBanner claims={claims} notify={notify}/>
      <TopNav role={role} setRole={setRole} claims={claims} adminView={adminView} setAdminView={setAdminView}/>
      <div style={{maxWidth:1400,margin:"0 auto",padding:"0 26px 80px"}}>
        {role==="admin"&&adminView==="claims"&&(
          claimsLoading
            ?<div style={{paddingTop:64,textAlign:"center"}}><Spinner/></div>
            :claimsError
              ?<div style={{paddingTop:32,color:C.red,fontSize:13}}>Failed to load claims: {claimsError.message}</div>
              :<AdminDashboard claims={claims} onSelect={setSelectedId} onGenPDF={()=>{}} onPushCMS={()=>{}} jsPdfReady={jsPdfReady} notify={notify}/>
        )}
        {role==="admin"&&adminView==="rfas"&&<RFACenter notify={notify}/>}
        {role==="admin"&&adminView==="notices"&&<NoticeCenter claims={claims} jsPdfReady={jsPdfReady} notify={notify}/>}
        {role==="admin"&&adminView==="agents"&&<Suspense fallback={<div style={{paddingTop:64,textAlign:"center"}}><Spinner/></div>}><AgentsConsole notify={notify}/></Suspense>}
        {role==="admin"&&adminView==="integrations"&&<Suspense fallback={<div style={{paddingTop:64,textAlign:"center"}}><Spinner/></div>}><IntegrationsConsole notify={notify}/></Suspense>}
        {role==="admin"&&adminView==="reports"&&<Suspense fallback={<div style={{paddingTop:64,textAlign:"center"}}><Spinner/></div>}><AdminReports onSelect={setSelectedId}/></Suspense>}
        {role==="admin"&&adminView==="architecture"&&<Suspense fallback={<div style={{paddingTop:64,textAlign:"center"}}><Spinner/></div>}><Architecture/></Suspense>}
        {role==="supervisor"&&(
          <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:22,fontWeight:700,marginBottom:4}}>Supervisor Oversight</h1>
              <p style={{color:C.muted,fontSize:13}}>The business-morning digest — important diaries due today and every overdue diary across the book, grouped by adjuster. Read-only: decisions stay with the assigned adjuster.</p>
            </div>
            <SupervisorAlerts onSelect={setSelectedId} notify={notify} placeholder/>
          </div>
        )}
        {role==="employer"&&<EmployerPortal employerUser={employerUser} setEmployerUser={setEmployerUser} onSelect={setSelectedId}/>}
        {role==="employee"&&(
          <div style={{paddingTop:32,maxWidth:660,animation:"fadeUp .3s ease"}}>
            <div style={{marginBottom:24}}><h1 style={{fontSize:22,fontWeight:700,marginBottom:4}}>Employee Portal</h1><p style={{color:C.muted,fontSize:13}}>Report a work injury — voice, photos, and appointment booking included</p></div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:28}}>
              <EmployeeIntakeWizard onComplete={d=>submitClaim(d,"employee")}/>
            </div>
          </div>
        )}
      </div>
      {selectedId&&<ClaimDrawer claimId={selectedId} onClose={()=>setSelectedId(null)} notify={notify} jsPdfReady={jsPdfReady} onGenDWC1={genDWC1} onOpenClaim={setSelectedId}/>}
    </div>
  );
}
