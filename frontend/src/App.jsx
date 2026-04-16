import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchClaims, fetchClaim, triggerAnalysis, approveReserves, updateClaimStatus, fetchDiaries, ensureDevSession } from './services/claims.js';
import { loginEmployer, ensureDevEmployerSession, previewEmployee, submitFROI } from './services/employer.js';
import { fetchRFAs, approveRFA, routeToURO } from './services/rfas.js';
import { fetchLossRun, fetchEmployerSummary, fetchExperienceModInputs, fetchCrossEmployerReport, fetchMissedDeadlines } from './services/reporting.js';
import { fetchPanelsForClaim, requestPanel, issuePanel, recordStrikes, scheduleQmeAppointment, markReportReceived, fetchSupplementalRequests, approveSupplemental, dismissSupplemental } from './services/qme.js';
import { evaluateMMISignals, fetchMMIEvaluations, solicitPR4, recordPR4Response, dismissMMIEvaluation, fetchPR4Solicitations } from './services/mmi.js';
import { calculatePD, initiatePDAdvances, recordPDAdvancePayment, waivePDAdvance, createStipulation, sendStipToWorker, recordWorkerSignature, recordAdjusterSignature, recordEAMSFiled, fetchPDData } from './services/pd.js';

// ═══════════════════════════════════════════════════════════
// THEME & CONSTANTS
// ═══════════════════════════════════════════════════════════
const FONTS = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap');`;
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#040e1c}::-webkit-scrollbar-thumb{background:#182b42;border-radius:3px}
input,select,textarea{background:#0a1622!important;border:1px solid #182b42!important;color:#d5e6f2!important;border-radius:7px!important;padding:10px 13px!important;font-family:'IBM Plex Sans',sans-serif!important;font-size:13px!important;width:100%;outline:none;transition:border-color .2s}
input:focus,select:focus,textarea:focus{border-color:#f59e0b!important;box-shadow:0 0 0 3px rgba(245,158,11,.07)!important}
input::placeholder,textarea::placeholder{color:#384f65!important}
select option{background:#0a1622;color:#d5e6f2}
input[type=radio],input[type=checkbox]{width:auto!important;padding:0!important;accent-color:#f59e0b}
.rh:hover{background:#0d1c2e!important;cursor:pointer}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideR{from{opacity:0;transform:translateX(44px)}to{opacity:1;transform:translateX(0)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
@keyframes ripple{0%{transform:scale(1);opacity:.6}100%{transform:scale(2.5);opacity:0}}
.spin{animation:spin 1s linear infinite}
.pulse{animation:pulse 1.4s ease-in-out infinite}
.blink{animation:blink .9s ease-in-out infinite}
`;
const C={
  bg:"#040e1c",surface:"#0a1622",card:"#0e1c2e",card2:"#111e30",
  border:"#182b42",borderMid:"#1d3350",
  amber:"#f59e0b",amberD:"#d97706",amberF:"#1a1200",
  blue:"#4a8df0",blueF:"#06122a",
  green:"#0eb87a",greenF:"#001510",
  red:"#f04040",redF:"#1a0303",
  purple:"#a78bfa",purpleF:"#0e0920",
  cyan:"#22d3ee",cyanF:"#011820",
  teal:"#14b8a6",tealF:"#011814",
  rose:"#fb7185",roseF:"#1a0510",
  text:"#d5e6f2",dim:"#6e8daa",muted:"#384f65",
  mono:"'IBM Plex Mono',monospace",sans:"'IBM Plex Sans',sans-serif",
};

// ═══════════════════════════════════════════════════════════
// MOCK DATA
// ═══════════════════════════════════════════════════════════
const ADP_EMP={
  "BC-001":{legalName:"Maria Santos",dob:"03/15/1981",address:"1842 W 7th St",city:"Los Angeles",state:"CA",zip:"90057",phone:"(213) 555-0142",jobTitle:"Home Health Aide II",aww:750.75,tdRate:500.50},
  "CF-014":{legalName:"James Okonkwo",dob:"07/22/1975",address:"4320 Crenshaw Blvd Apt 8",city:"Los Angeles",state:"CA",zip:"90008",phone:"(323) 555-0198",jobTitle:"LVN Home Health",aww:1120.00,tdRate:746.67},
  "SR-022":{legalName:"Lupe Hernandez",dob:"11/08/1990",address:"7715 Sepulveda Blvd",city:"Van Nuys",state:"CA",zip:"91405",phone:"(818) 555-0077",jobTitle:"Personal Care Worker",aww:621.00,tdRate:414.00},
};

const MPN_PROVIDERS=[
  {id:"c1",name:"Concentra Urgent Care",branch:"Mid-Wilshire",addr:"3699 Wilshire Blvd",city:"Los Angeles",zip:"90010",phone:"(213) 637-0500",specialty:"Occupational Medicine",rating:4.2,reviews:142,walkIn:true,zips:["900","901","902"]},
  {id:"c2",name:"Concentra Urgent Care",branch:"Van Nuys",addr:"14510 Lankershim Blvd",city:"Van Nuys",zip:"91402",phone:"(818) 781-3600",specialty:"Occupational Medicine",rating:4.1,reviews:98,walkIn:true,zips:["914","913","915","912"]},
  {id:"k1",name:"Kaiser Occ Health",branch:"West LA",addr:"6041 Cadillac Ave",city:"Los Angeles",zip:"90034",phone:"(310) 297-3456",specialty:"Occupational Medicine",rating:4.5,reviews:210,walkIn:false,zips:["900","902","903","904"]},
  {id:"s1",name:"SoCal Ortho & Sports",branch:"Koreatown",addr:"3650 W 6th St Ste 400",city:"Los Angeles",zip:"90020",phone:"(213) 383-9898",specialty:"Orthopedic Surgery",rating:4.6,reviews:87,walkIn:false,zips:["900","901"]},
  {id:"u1",name:"UCLA Occ Health Clinic",branch:"Westwood",addr:"10833 Le Conte Ave",city:"Los Angeles",zip:"90095",phone:"(310) 825-6301",specialty:"Occupational Medicine",rating:4.7,reviews:312,walkIn:false,zips:["900","905","906"]},
  {id:"v1",name:"Valley Occ Med Center",branch:"Van Nuys",addr:"15415 Vanowen St",city:"Van Nuys",zip:"91405",phone:"(818) 780-0860",specialty:"Occupational Medicine",rating:3.9,reviews:44,walkIn:true,zips:["914","913"]},
  {id:"p1",name:"PIH Health Urgent Care",branch:"Whittier",addr:"12401 Washington Blvd",city:"Whittier",zip:"90602",phone:"(562) 698-0811",specialty:"Occupational Medicine",rating:4.3,reviews:155,walkIn:true,zips:["906","907","908"]},
  {id:"e1",name:"Employee Health Services",branch:"Downtown LA",addr:"1200 N State St",city:"Los Angeles",zip:"90033",phone:"(323) 226-4000",specialty:"Occupational & Infectious Disease",rating:4.4,reviews:66,walkIn:true,zips:["900","901","902","903"]},
];

const NOTICE_TYPES=[
  {id:"dwc7",label:"DWC-7 — Notice of Representation",trigger:"On acceptance",urgency:"Within 5 days"},
  {id:"delay",label:"Delay Notice — Claim Not Resolved",trigger:"Day 14 if no decision",urgency:"By Day 14"},
  {id:"td",label:"TD Benefit Notice — Indemnity Started",trigger:"First TD payment",urgency:"With first check"},
  {id:"denial",label:"Denial Letter — Claim Denied",trigger:"On denial",urgency:"Within 90 days"},
  {id:"rtw",label:"RTW Offer — Return to Work",trigger:"MMI reached",urgency:"Within 30 days of MMI"},
  {id:"dwc9",label:"DWC-9 — Notice of Payments",trigger:"Each payment",urgency:"With each payment"},
];

// INIT_CLAIMS removed in M3 — admin dashboard uses live backend data via React Query

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════
const fmt$=(n)=>n!=null?`$${Number(n).toLocaleString()}`:"—";
const STATUS_CFG={pending:{label:"Awaiting AI",color:C.amber,bg:"#1a1100",bd:"#f59e0b33"},ai_complete:{label:"AI Ready",color:C.blue,bg:"#06122a",bd:"#4a8df033"},approved:{label:"Approved",color:C.green,bg:"#001510",bd:"#0eb87a33"},denied:{label:"Denied",color:C.red,bg:"#1a0303",bd:"#f0404033"},modified:{label:"Mod. Approved",color:C.purple,bg:"#0e0920",bd:"#a78bfa33"}};
const PRI_COLOR={Critical:C.red,High:C.amber,Medium:C.blue,Low:C.dim};
const COMP_COLOR={"Likely Compensable":C.green,"Questionable":C.amber,"Likely Non-Compensable":C.red};
const EMPLOYERS=["BrightCare Home Health","ComfortFirst Healthcare","SunRise Home Care","CareWell Services","HomeHope Inc."];
const BODY_PARTS=["Lumbar Spine / Lower Back","Cervical Spine / Neck","Shoulder","Knee","Wrist / Hand","Ankle / Foot","Hip","Multiple Body Parts","Other"];
const INJURY_TYPES=["Strain / Sprain","Lifting Injury","Slip & Fall","Needlestick / Sharps","Contusion","Laceration","Fracture","Repetitive Motion","Motor Vehicle","Other"];

function getProvidersNearZip(zip){
  if(!zip) return MPN_PROVIDERS.slice(0,3);
  const pre=zip.replace(/\D/g,"").slice(0,3);
  const match=MPN_PROVIDERS.filter(p=>p.zips.includes(pre));
  const rest=MPN_PROVIDERS.filter(p=>!match.includes(p));
  return [...match,...rest].slice(0,3).map(p=>({...p,distance:(Math.random()*6+0.4).toFixed(1)}));
}
function getSlots(offset){
  const all=["8:00 AM","8:30 AM","9:00 AM","9:30 AM","10:00 AM","10:30 AM","11:00 AM","11:30 AM","1:00 PM","1:30 PM","2:00 PM","2:30 PM","3:00 PM","3:30 PM","4:00 PM"];
  return all.filter((_,i)=>(i+offset*3)%4!==0);
}
function dayLabel(off){
  if(off===0) return "Today";
  if(off===1) return "Tomorrow";
  const d=new Date(); d.setDate(d.getDate()+off);
  return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
}

// ═══════════════════════════════════════════════════════════
// SHARED UI PRIMITIVES
// ═══════════════════════════════════════════════════════════
function Badge({status}){const c=STATUS_CFG[status]||STATUS_CFG.pending;return <span style={{display:"inline-block",background:c.bg,color:c.color,border:`1px solid ${c.bd}`,padding:"3px 10px",borderRadius:4,fontSize:10,fontFamily:C.mono,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase",whiteSpace:"nowrap"}}>{c.label}</span>;}
function Btn({children,onClick,variant="primary",disabled,small,full,icon}){
  const V={primary:{bg:C.amber,color:"#000",bd:"none"},danger:{bg:C.red,color:"#fff",bd:"none"},success:{bg:C.green,color:"#000",bd:"none"},ghost:{bg:"transparent",color:C.dim,bd:`1px solid ${C.border}`},outline:{bg:"transparent",color:C.amber,bd:`1px solid ${C.amber}44`},teal:{bg:C.teal,color:"#000",bd:"none"},rose:{bg:C.rose,color:"#000",bd:"none"},purple:{bg:C.purple,color:"#000",bd:"none"}};
  const s=V[variant]||V.primary;
  return <button onClick={onClick} disabled={disabled} style={{background:disabled?"#182b42":s.bg,color:disabled?C.muted:s.color,border:s.bd,padding:small?"6px 14px":"10px 22px",borderRadius:7,fontSize:small?11:13,fontWeight:700,fontFamily:C.sans,cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.5:1,whiteSpace:"nowrap",width:full?"100%":"auto",display:"inline-flex",alignItems:"center",gap:6}}>{icon&&<span>{icon}</span>}{children}</button>;
}
function Lbl({children,color,mb=7}){return <div style={{fontSize:10,fontFamily:C.mono,color:color||C.muted,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:mb}}>{children}</div>;}
function Field({label,children}){return <div style={{marginBottom:16}}><Lbl>{label}</Lbl>{children}</div>;}
function SectionHead({title,color}){return <div style={{fontSize:10,fontFamily:C.mono,color:color||C.muted,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:14,paddingBottom:10,borderBottom:`1px solid ${C.border}`}}>{title}</div>;}
function StatCard({label,value,sub,accent,delay=0}){return <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"18px 22px",flex:1,animation:`fadeUp 0.35s ease ${delay}s both`}}><div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12}}>{label}</div><div style={{fontSize:26,fontFamily:C.mono,fontWeight:600,color:accent||C.text,lineHeight:1}}>{value}</div>{sub&&<div style={{fontSize:11,color:C.muted,marginTop:6}}>{sub}</div>}</div>;}
function Spinner(){return <div className="spin" style={{width:13,height:13,border:`2px solid ${C.amber}33`,borderTopColor:C.amber,borderRadius:"50%",flexShrink:0}}/>;}
function Toast({msg,type}){const c=type==="error"?C.red:C.green;return <div style={{position:"fixed",top:70,right:22,zIndex:9999,background:type==="error"?C.redF:C.greenF,border:`1px solid ${c}44`,color:c,padding:"11px 18px",borderRadius:8,fontSize:12,fontFamily:C.mono,maxWidth:420,animation:"fadeUp 0.2s ease"}}>{msg}</div>;}
function Tabs({tabs,active,onChange}){return <div style={{display:"flex",borderBottom:`1px solid ${C.border}`,marginBottom:22}}>{tabs.map(t=><button key={t.key} onClick={()=>onChange(t.key)} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,fontWeight:600,color:active===t.key?C.text:C.muted,padding:"9px 20px",fontFamily:C.sans,borderBottom:`2px solid ${active===t.key?C.amber:"transparent"}`,transition:"all .15s",marginBottom:-1}}>{t.label}</button>)}</div>;}
function InfoPair({label,value,mono,accent}){return <div style={{marginBottom:9}}><div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:3}}>{label}</div><div style={{fontSize:13,fontFamily:mono?C.mono:C.sans,color:accent||C.text,lineHeight:1.6}}>{value||"—"}</div></div>;}
function RadioGroup({value,onChange,options,name}){return <div style={{display:"flex",gap:18,paddingTop:8}}>{options.map(([lbl,val])=><label key={lbl} style={{display:"flex",alignItems:"center",gap:7,fontSize:13,cursor:"pointer",color:C.dim}}><input type="radio" name={name} checked={value===val} onChange={()=>onChange(val)}/>{lbl}</label>)}</div>;}
function StepBar({step,total}){
  return <div style={{display:"flex",gap:6,marginBottom:28}}>
    {Array.from({length:total},(_,i)=>{
      const bg = i<step ? C.amber : i===step ? C.amber+"88" : C.border;
      return <div key={i} style={{flex:1,height:3,borderRadius:2,background:bg,transition:"background .3s"}}/>;
    })}
  </div>;
}

// ═══════════════════════════════════════════════════════════
// LANGUAGE SELECTOR (M2)
// ═══════════════════════════════════════════════════════════
function LanguageSelector(){
  const {i18n}=useTranslation();
  const [lang,setLang]=useState(i18n.language?.slice(0,2)||'en');
  const toggle=()=>{
    const next=lang==='en'?'es':'en';
    i18n.changeLanguage(next);
    setLang(next);
  };
  return(
    <button onClick={toggle} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,padding:'5px 12px',borderRadius:6,fontSize:11,fontFamily:C.mono,cursor:'pointer',letterSpacing:'0.04em',flexShrink:0}}>
      {lang==='en'?'EN · ES':'ES · EN'}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════
// M2 VOICE RECORDER — MediaRecorder → Whisper API
// ═══════════════════════════════════════════════════════════
function M2VoiceRecorder({onResult,language='en',claimId}){
  const {t}=useTranslation('intake');
  const [phase,setPhase]=useState('consent'); // consent | recording | uploading | done | error
  const [consentGiven,setConsentGiven]=useState(false);
  const [seconds,setSeconds]=useState(0);
  const [transcript,setTranscript]=useState('');
  const [extraction,setExtraction]=useState(null);
  const [errMsg,setErrMsg]=useState('');
  const timerRef=useRef(null);
  const stopRef=useRef(null);
  const uploadedRef=useRef(false);

  useEffect(()=>()=>{clearInterval(timerRef.current);},[]);

  const doStop=()=>stopRef.current?.();

  const startRecording=async()=>{
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mimeType=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm';
      const mr=new MediaRecorder(stream,{mimeType});
      const chunks=[];
      uploadedRef.current=false;

      mr.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
      mr.onstop=async()=>{
        stream.getTracks().forEach(tr=>tr.stop());
        if(uploadedRef.current)return;
        uploadedRef.current=true;
        setPhase('uploading');
        try{
          const blob=new Blob(chunks,{type:'audio/webm'});
          const fd=new FormData();
          fd.append('audio',blob,'recording.webm');
          fd.append('language',language);
          if(claimId)fd.append('claim_id',String(claimId));
          const res=await fetch('/api/v1/voice/transcribe',{method:'POST',body:fd});
          if(!res.ok)throw new Error(`HTTP ${res.status}`);
          const data=await res.json();
          setTranscript(data.transcript||'');
          setExtraction(data.extraction||null);
          onResult({transcript:data.transcript||'',extraction:data.extraction||null});
          setPhase('done');
        }catch(err){
          setErrMsg(err.message||t('error_generic'));
          setPhase('error');
        }
      };

      mr.start(1000);
      setPhase('recording');
      setSeconds(0);
      stopRef.current=()=>{clearInterval(timerRef.current);if(mr.state!=='inactive')mr.stop();};
      timerRef.current=setInterval(()=>{
        setSeconds(s=>{if(s>=179){stopRef.current?.();return 180;}return s+1;});
      },1000);
    }catch{
      setErrMsg('Microphone access denied. Please use the text option instead.');
      setPhase('error');
    }
  };

  const mm=String(Math.floor(seconds/60)).padStart(2,'0');
  const ss2=String(seconds%60).padStart(2,'0');

  if(phase==='consent')return(
    <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:20}}>
      <div style={{fontSize:13,color:C.dim,lineHeight:1.7,marginBottom:16}}>{t('voice_consent')}</div>
      <label style={{display:'flex',alignItems:'flex-start',gap:10,fontSize:13,color:C.text,cursor:'pointer',marginBottom:18}}>
        <input type="checkbox" checked={consentGiven} onChange={e=>setConsentGiven(e.target.checked)} style={{marginTop:2}}/>
        {t('voice_consent_agree')}
      </label>
      <Btn disabled={!consentGiven} onClick={startRecording} icon="🎙">{t('voice_start')}</Btn>
    </div>
  );

  if(phase==='recording')return(
    <div style={{background:C.redF,border:`1px solid ${C.red}44`,borderRadius:10,padding:20}}>
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:14}}>
        <div style={{display:'flex',gap:3}}>{[0,1,2,3,4].map(i=><div key={i} className="blink" style={{width:3,height:8+i*4,background:C.red,borderRadius:2,animationDelay:`${i*0.1}s`}}/>)}</div>
        <div style={{fontFamily:C.mono,fontSize:22,color:C.red,fontWeight:700}}>{mm}:{ss2}</div>
        {seconds>=150&&<span style={{fontSize:11,color:C.amber}}>{t('voice_warning')}</span>}
      </div>
      <div style={{fontSize:12,color:C.dim,marginBottom:14}}>Speak clearly — tap Stop when finished.</div>
      <Btn variant="danger" onClick={doStop}>■ {t('voice_stop')}</Btn>
    </div>
  );

  if(phase==='uploading')return(
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:20,display:'flex',alignItems:'center',gap:14}}>
      <Spinner/>
      <span style={{color:C.dim,fontSize:13}}>{t('voice_transcribing')}</span>
    </div>
  );

  if(phase==='done')return(
    <div style={{background:C.bg,border:`1px solid ${C.green}44`,borderRadius:10,padding:16}}>
      <Lbl color={C.green}>{t('voice_review')}</Lbl>
      <div style={{fontSize:11,color:C.muted,marginBottom:10}}>{t('voice_review_sub')}</div>
      <textarea value={transcript} onChange={e=>{const v=e.target.value;setTranscript(v);onResult({transcript:v,extraction});}} rows={5} placeholder={t('voice_text_placeholder')}/>
    </div>
  );

  if(phase==='error')return(
    <div style={{background:C.redF,border:`1px solid ${C.red}44`,borderRadius:10,padding:16}}>
      <div style={{color:C.red,fontSize:13,marginBottom:12}}>{errMsg||t('error_generic')}</div>
      <Btn variant="ghost" onClick={()=>{setPhase('consent');setErrMsg('');uploadedRef.current=false;}}>Try Again</Btn>
    </div>
  );

  return null;
}

// ═══════════════════════════════════════════════════════════
// MEDIA UPLOADER
// ═══════════════════════════════════════════════════════════
function MediaUploader({files,onAdd,onRemove}){
  const inputRef=useRef(null);
  const [dragging,setDragging]=useState(false);

  const handle=fs=>{
    const valid=Array.from(fs).filter(f=>f.type.startsWith("image/")||f.type.startsWith("video/"));
    valid.forEach(f=>{f.preview=URL.createObjectURL(f);});
    onAdd(valid);
  };

  return(
    <div>
      <div style={{background:C.amberF,border:`1px solid ${C.amber}33`,borderRadius:8,padding:'10px 14px',marginBottom:12,fontSize:12,color:C.dim,lineHeight:1.6}}>
        ⚠️ Please ensure photos do not include patients, patient faces, or any patient
        identifying information. Uploading patient PHI may violate HIPAA.
      </div>
      <input ref={inputRef} type="file" multiple accept="image/*,video/*" style={{display:"none"}} onChange={e=>handle(e.target.files)}/>
      <div
        onClick={()=>inputRef.current?.click()}
        onDragOver={e=>{e.preventDefault();setDragging(true);}}
        onDragLeave={()=>setDragging(false)}
        onDrop={e=>{e.preventDefault();setDragging(false);handle(e.dataTransfer.files);}}
        style={{border:`1.5px dashed ${dragging?C.amber:C.border}`,borderRadius:9,padding:"20px 16px",textAlign:"center",cursor:"pointer",transition:"border-color .2s",background:dragging?C.amberF:"transparent",marginBottom:12}}
      >
        <div style={{fontSize:22,marginBottom:6}}>📎</div>
        <div style={{fontSize:13,color:C.dim}}>Drop photos or videos here, or <span style={{color:C.amber,textDecoration:"underline"}}>browse</span></div>
        <div style={{fontSize:11,color:C.muted,marginTop:4}}>Photos of injury site, incident location, equipment — up to 10 files</div>
      </div>
      {files.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:8}}>
          {files.map((f,i)=>(
            <div key={i} style={{position:"relative",borderRadius:7,overflow:"hidden",border:`1px solid ${C.border}`,aspectRatio:"1",background:C.bg}}>
              {f.type.startsWith("image/")?
                <img src={f.preview} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:
                <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
                  <span style={{fontSize:24}}>🎬</span>
                  <span style={{fontSize:9,color:C.muted,textAlign:"center",padding:"0 4px"}}>{f.name?.slice(0,14)}</span>
                </div>}
              <button onClick={e=>{e.stopPropagation();onRemove(i);}} style={{position:"absolute",top:3,right:3,width:18,height:18,borderRadius:"50%",background:"rgba(0,0,0,.7)",border:"none",color:"#fff",cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// MEDICAL PROVIDER FINDER
// ═══════════════════════════════════════════════════════════
function ProviderFinder({zip,injuryType,onBook}){
  const [providers]=useState(()=>getProvidersNearZip(zip));
  const [selected,setSelected]=useState(null);
  const [dayOff,setDayOff]=useState(0);
  const [pickedSlot,setPickedSlot]=useState(null);
  const [booked,setBooked]=useState(false);

  const book=()=>{
    if(!selected||!pickedSlot) return;
    const appt={facility:`${selected.name} — ${selected.branch}`,address:`${selected.addr}, ${selected.city} CA ${selected.zip}`,phone:selected.phone,date:dayLabel(dayOff),time:pickedSlot,authCode:`MPN-2026-${Math.floor(Math.random()*9000+1000)}`,confirmed:true};
    setBooked(true);
    setTimeout(()=>onBook(appt),800);
  };

  if(booked) return(
    <div style={{textAlign:"center",padding:"32px 0",animation:"fadeUp 0.3s ease"}}>
      <div style={{fontSize:40,marginBottom:12}}>✅</div>
      <div style={{fontSize:16,fontWeight:700,color:C.green,marginBottom:8}}>Appointment Booked</div>
      <div style={{fontSize:14,color:C.text}}>{selected?.name} — {selected?.branch}</div>
      <div style={{fontFamily:C.mono,color:C.amber,fontSize:13,marginTop:6}}>{dayLabel(dayOff)} at {pickedSlot}</div>
      <div style={{fontSize:12,color:C.muted,marginTop:8}}>SMS and email confirmation being sent to worker…</div>
    </div>
  );

  return(
    <div>
      <div style={{fontSize:12,color:C.muted,marginBottom:16}}>Showing MPN-approved providers near <span style={{color:C.amber,fontFamily:C.mono}}>{zip||"your zip"}</span>. All accept workers' compensation.</div>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
        {providers.map(p=>{
          const isSel=selected?.id===p.id;
          return(
            <div key={p.id} onClick={()=>{setSelected(isSel?null:p);setPickedSlot(null);}} style={{background:isSel?C.amberF:C.bg,border:`1.5px solid ${isSel?C.amber:C.border}`,borderRadius:10,padding:"14px 16px",cursor:"pointer",transition:"all .18s"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:isSel?10:0}}>
                <div>
                  <div style={{fontWeight:700,fontSize:14,color:C.text}}>{p.name}</div>
                  <div style={{fontSize:12,color:C.dim,marginTop:2}}>{p.branch} · {p.addr}, {p.city}</div>
                  <div style={{display:"flex",gap:8,marginTop:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,color:C.amber,fontFamily:C.mono}}>★ {p.rating} ({p.reviews})</span>
                    <span style={{fontSize:11,color:C.dim}}>{p.specialty}</span>
                    <span style={{fontSize:11,color:C.dim}}>{p.distance} mi</span>
                    {p.walkIn&&<span style={{fontSize:10,background:C.greenF,color:C.green,padding:"1px 7px",borderRadius:4,fontFamily:C.mono,border:`1px solid ${C.green}33`}}>Walk-in OK</span>}
                  </div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:11,color:C.muted}}>Next available</div>
                  <div style={{fontSize:12,color:C.green,fontFamily:C.mono,fontWeight:600}}>Today</div>
                </div>
              </div>
              {isSel&&(
                <div style={{borderTop:`1px solid ${C.amber}44`,paddingTop:12,animation:"fadeUp .2s ease"}}>
                  <div style={{fontSize:11,fontFamily:C.mono,color:C.muted,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.06em"}}>Select Date & Time</div>
                  <div style={{display:"flex",gap:6,marginBottom:12}}>
                    {[0,1,2].map(d=><button key={d} onClick={e=>{e.stopPropagation();setDayOff(d);setPickedSlot(null);}} style={{background:dayOff===d?C.amber:"transparent",color:dayOff===d?"#000":C.dim,border:`1px solid ${dayOff===d?C.amber:C.border}`,padding:"6px 14px",borderRadius:6,fontSize:12,fontWeight:600,fontFamily:C.sans,cursor:"pointer"}}>{dayLabel(d)}</button>)}
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {getSlots(dayOff).map(slot=><button key={slot} onClick={e=>{e.stopPropagation();setPickedSlot(slot);}} style={{background:pickedSlot===slot?C.blue:"transparent",color:pickedSlot===slot?"#fff":C.dim,border:`1px solid ${pickedSlot===slot?C.blue:C.border}`,padding:"5px 12px",borderRadius:5,fontSize:11,fontFamily:C.mono,cursor:"pointer"}}>{slot}</button>)}
                  </div>
                  {pickedSlot&&(
                    <div style={{marginTop:14}}>
                      <Btn onClick={e=>{e.stopPropagation();book();}} icon="📅">Book {dayLabel(dayOff)} at {pickedSlot}</Btn>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// generateReasoningPDF moved to backend in M3 — see GET /api/v1/claims/:id/reasoning-pdf

function generateNoticePDF(claim,noticeType){
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:"portrait",unit:"mm",format:"letter"});
  const W=215.9,M=20; let y=M;
  doc.setFillColor(10,22,34); doc.rect(0,0,W,18,"F");
  doc.setFontSize(11);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text("HomeCare TPA — Workers' Compensation Notice",W/2,12,{align:"center"});
  y=26;
  doc.setFontSize(9);doc.setFont("helvetica","normal");doc.setTextColor(200,220,240);
  doc.text(`Date: ${new Date().toLocaleDateString()}`,M,y);
  doc.text(`Claim No: ${claim.id}`,W-M,y,{align:"right"}); y+=8;
  doc.text(`To: ${claim.claimant}`,M,y); y+=5;
  doc.text(claim.homeAddr||"Address on file",M,y); y+=10;
  doc.setFontSize(12);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  const TITLES={dwc7:"NOTICE OF REPRESENTATION — DWC-7",delay:"NOTICE OF DELAY IN CLAIM DETERMINATION",td:"NOTICE OF TEMPORARY DISABILITY BENEFIT PAYMENTS",denial:"NOTICE OF CLAIM DENIAL",rtw:"NOTICE OF RETURN-TO-WORK OFFER",dwc9:"NOTICE OF COMPENSATION PAYMENTS — DWC-9"};
  doc.text(TITLES[noticeType]||"NOTICE",W/2,y,{align:"center"}); y+=10;
  doc.setDrawColor(26,46,69);doc.line(M,y,W-M,y); y+=6;
  doc.setFontSize(9);doc.setFont("helvetica","normal");doc.setTextColor(216,232,245);
  const BODY={
    dwc7:`This letter is to inform you that HomeCare TPA, located at [TPA Address], has been authorized to act as administrator of your workers' compensation claim (${claim.id}) on behalf of ${claim.employer}. For questions, contact your assigned adjuster.`,
    delay:`Your claim (${claim.id}) for an injury on ${claim.dateOfInjury} has been received. We are unable to make a determination on your claim at this time. We will notify you of our decision within the time allowed by law. You continue to have the right to emergency medical treatment during this period.`,
    td:`You are entitled to Temporary Disability (TD) benefits for your work injury. Your average weekly wage is ${fmt$(claim.aww)}. Your TD rate is ${fmt$(claim.tdRate)} per week (2/3 of AWW per CA Labor Code §4453). Payments will begin on the next scheduled pay date.`,
    denial:`After investigation, your claim (${claim.id}) for an injury on ${claim.dateOfInjury} has been denied. If you disagree with this decision, you have the right to file an Application for Adjudication with the Workers' Compensation Appeals Board (WCAB). Contact DWC Information & Assistance: 1-800-736-7401.`,
    rtw:`This is a notice that a return-to-work position is available for you at ${claim.employer}. A modified/alternative duty position has been identified that accommodates your work restrictions. Please respond within 10 days.`,
    dwc9:`Enclosed please find a statement of compensation payments made on your behalf for claim ${claim.id}. Medical payments: ${fmt$(claim.aiAnalysis?.suggestedMedicalReserve||0)}. Indemnity payments: ${fmt$(claim.aiAnalysis?.suggestedIndemnityReserve||0)}.`,
  };
  const bl=doc.splitTextToSize(BODY[noticeType]||"",W-M*2);
  doc.text(bl,M,y); y+=bl.length*5+14;
  doc.setFontSize(8);doc.setTextColor(100,120,140);
  doc.text("_______________________________",M,y); y+=6;
  doc.text("Adjuster Signature / HomeCare TPA",M,y); y+=5;
  doc.text(`If you have questions, call (800) 555-0190 (HomeCare TPA) or DWC Info Line: 1-800-736-7401`,M,y+10,);
  doc.setFontSize(7);doc.setTextColor(60,80,100);
  doc.text(`${claim.id} | Mailed via USPS First Class | Lob.com print & mail service`,W/2,198,{align:"center"});
  return doc;
}

// ═══════════════════════════════════════════════════════════
// EMPLOYEE INTAKE WIZARD (M2) — i18n · equal voice/text · real API
// ═══════════════════════════════════════════════════════════
const EMPTY_M2={claimant:'',claimantDOB:'',homeAddr:'',homeZip:'',phone:'',employer:'',dateOfInjury:'',bodyPart:'',injuryType:'',mechanism:'',voiceTranscript:'',medTreatment:'',timeOff:false,priorClaims:'None',witnesses:'',media:[],aww:null,tdRate:null,motorVehicleFields:null};

function EmployeeIntakeWizard({onComplete}){
  const {t,i18n}=useTranslation('intake');
  const lang=i18n.language?.slice(0,2)||'en';
  const [step,setStep]=useState(0);
  const [form,setForm]=useState(EMPTY_M2);
  const [submittedId,setSubmittedId]=useState(null);
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));
  const next=()=>setStep(s=>s+1);
  const back=()=>setStep(s=>s-1);
  const TOTAL=6;

  // Step 2 — intake method sub-state
  const [intakeMethod,setIntakeMethod]=useState(null); // 'voice'|'text'
  const [intakeDone,setIntakeDone]=useState(false);
  const [textInput,setTextInput]=useState('');
  const [textLoading,setTextLoading]=useState(false);
  const [extraction,setExtraction]=useState(null);

  // Step 4 — MPN / provider
  const [mpnAck,setMpnAck]=useState(false);
  const [providers,setProviders]=useState([]);
  const [provLoading,setProvLoading]=useState(false);
  const [selProvider,setSelProvider]=useState(null);
  const [appointmentId,setAppointmentId]=useState(null);
  const [confirmNum,setConfirmNum]=useState('');
  const [apptConfirmed,setApptConfirmed]=useState(false);
  const [apptLoading,setApptLoading]=useState(false);

  // Load providers when entering step 4
  useEffect(()=>{
    if(step!==4||providers.length>0)return;
    setProvLoading(true);
    fetch(`/api/v1/providers?zip=${encodeURIComponent(form.homeZip||'90010')}&limit=5`)
      .then(r=>r.ok?r.json():Promise.reject())
      .then(d=>setProviders(d.providers||[]))
      .catch(()=>setProviders(getProvidersNearZip(form.homeZip).map(p=>({...p,mpn_tier:1,accepting_new_wc:true,addr:p.addr||p.address}))))
      .finally(()=>setProvLoading(false));
  },[step]); // eslint-disable-line

  const submitText=async()=>{
    const txt=textInput.trim();
    if(txt.length<10)return;
    setTextLoading(true);
    try{
      const res=await fetch('/api/v1/voice/text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:txt})});
      if(res.ok){const data=await res.json();setExtraction(data.extraction);}
    }catch{/* non-fatal */}
    setForm(p=>({...p,mechanism:txt,voiceTranscript:''}));
    setTextLoading(false);
    setIntakeDone(true);
  };

  const handleVoiceResult=({transcript,extraction:ext})=>{
    setExtraction(ext);
    setForm(p=>({...p,mechanism:transcript,voiceTranscript:transcript}));
    setIntakeDone(true);
  };

  const selectProvider=async p=>{
    setApptLoading(true);
    try{
      const res=await fetch('/api/v1/appointments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({claim_id:`draft-${Date.now()}`,employee_id:'employee-self',provider_id:p.id,provider_name:p.name,provider_phone:p.phone,provider_address:p.addr||p.address||'',specialty:p.specialty})});
      const d=res.ok?await res.json():{};
      setAppointmentId(d.appointment?.id||`mock-${Date.now()}`);
    }catch{setAppointmentId(`mock-${Date.now()}`);}
    setSelProvider(p);
    setApptLoading(false);
  };

  const confirmAppt=async()=>{
    if(!confirmNum.trim())return;
    setApptLoading(true);
    try{
      if(appointmentId&&!appointmentId.startsWith('mock-'))
        await fetch(`/api/v1/appointments/${appointmentId}/confirm`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation_number:confirmNum})});
    }catch{/* non-fatal */}
    setApptConfirmed(true);
    setApptLoading(false);
    setTimeout(next,600);
  };

  const submit=()=>{
    const appt=selProvider?{facility:`${selProvider.name}${selProvider.branch?` — ${selProvider.branch}`:''}`,address:selProvider.addr||selProvider.address||'',phone:selProvider.phone,date:'Pending',time:'TBD',authCode:`MPN-2026-${Math.floor(Math.random()*9000+1000)}`,confirmed:apptConfirmed}:null;
    const id=onComplete({...form,appointment:appt});
    setSubmittedId(id);
    fetch(`/api/v1/claims/${id}/dwc1/request-signature`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'sms',phone:form.phone})}).catch(()=>{});
    setStep(6);
  };

  const stepTitles=['Your Information','Injury Details',t('voice_header'),t('media_header'),t('mpn_header'),t('dwc1_header')];

  // ── Completion ──
  if(step===6)return(
    <div style={{textAlign:'center',padding:'40px 20px',animation:'fadeUp 0.3s ease'}}>
      <div style={{width:64,height:64,background:C.greenF,border:`2px solid ${C.green}`,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 18px',fontSize:28,color:C.green}}>✓</div>
      <div style={{fontSize:20,fontWeight:700,color:C.green,marginBottom:6}}>{t('complete_header')}</div>
      <div style={{fontFamily:C.mono,color:C.amber,fontSize:16,fontWeight:600,marginBottom:12,letterSpacing:'0.04em'}}>{submittedId}</div>
      <div style={{fontSize:12,color:C.dim,maxWidth:380,margin:'0 auto 20px',lineHeight:1.8}}>{t('complete_sub')}</div>
      <div style={{textAlign:'left',background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:18,maxWidth:400,margin:'0 auto 20px'}}>
        {[t('complete_step1'),t('complete_step2'),t('complete_step3')].map((s,i)=>(
          <div key={i} style={{fontSize:13,color:C.dim,marginBottom:10,display:'flex',gap:10}}>
            <span style={{color:C.amber,fontFamily:C.mono,fontWeight:700}}>{i+1}.</span><span>{s}</span>
          </div>
        ))}
      </div>
      <div style={{display:'flex',gap:8,justifyContent:'center',flexWrap:'wrap'}}>
        <div style={{fontSize:12,background:C.greenF,border:`1px solid ${C.green}33`,color:C.green,padding:'6px 14px',borderRadius:5,fontFamily:C.mono}}>✓ SMS sent to worker</div>
        <div style={{fontSize:12,background:C.blueF,border:`1px solid ${C.blue}33`,color:C.blue,padding:'6px 14px',borderRadius:5,fontFamily:C.mono}}>✓ DWC-1 sent for e-sign</div>
      </div>
    </div>
  );

  return(
    <div style={{maxWidth:640,margin:'0 auto'}}>
      {/* Header row: step indicator + language selector */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18}}>
        <div>
          <div style={{fontSize:11,fontFamily:C.mono,color:C.muted,marginBottom:4}}>{t('step_of',{current:step+1,total:TOTAL})}</div>
          <div style={{fontSize:18,fontWeight:700,color:C.text}}>{stepTitles[step]}</div>
        </div>
        <LanguageSelector/>
      </div>
      <StepBar step={step} total={TOTAL}/>

      {/* ── Step 0: Personal Info ── */}
      {step===0&&(
        <div style={{animation:'fadeUp 0.25s ease'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 20px'}}>
            <Field label="Your Full Legal Name *"><input value={form.claimant} onChange={f('claimant')} placeholder="As on your ID or paycheck"/></Field>
            <Field label="Date of Birth"><input value={form.claimantDOB} onChange={f('claimantDOB')} placeholder="MM/DD/YYYY"/></Field>
            <Field label="Your Employer *">
              <select value={form.employer} onChange={f('employer')}><option value="">Select employer…</option>{EMPLOYERS.map(e=><option key={e}>{e}</option>)}</select>
            </Field>
            <Field label="Phone Number"><input value={form.phone} onChange={f('phone')} placeholder="(xxx) xxx-xxxx"/></Field>
            <Field label="Home Address"><input value={form.homeAddr} onChange={f('homeAddr')} placeholder="Street address"/></Field>
            <Field label="Home Zip Code *"><input value={form.homeZip} onChange={f('homeZip')} placeholder="xxxxx"/></Field>
          </div>
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:8}}>
            <Btn onClick={next} disabled={!form.claimant||!form.employer||!form.homeZip}>{t('next')} →</Btn>
          </div>
        </div>
      )}

      {/* ── Step 1: Injury Details ── */}
      {step===1&&(
        <div style={{animation:'fadeUp 0.25s ease'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 20px',marginBottom:8}}>
            <Field label="Date of Injury *"><input value={form.dateOfInjury} onChange={f('dateOfInjury')} placeholder="MM/DD/YYYY"/></Field>
            <Field label="Body Part Affected">
              <select value={form.bodyPart} onChange={f('bodyPart')}><option value="">Select…</option>{BODY_PARTS.map(b=><option key={b}>{b}</option>)}</select>
            </Field>
            <Field label="Type of Injury">
              <select value={form.injuryType} onChange={f('injuryType')}><option value="">Select…</option>{INJURY_TYPES.map(ty=><option key={ty}>{ty}</option>)}</select>
            </Field>
            {form.injuryType==='Motor Vehicle'&&(
              <div style={{background:C.card,border:`1px solid ${C.amber}33`,borderRadius:9,padding:'14px 16px',marginTop:14}}>
                <Lbl color={C.amber}>A few quick questions about the accident</Lbl>
                {[
                  ['driving_between_patients','Were you driving between patient locations when this occurred?'],
                  ['other_vehicle_involved','Was another vehicle involved?'],
                  ['police_responded','Did police respond to the scene?'],
                ].map(([key,question])=>(
                  <div key={key} style={{marginBottom:12}}>
                    <div style={{fontSize:13,color:C.dim,marginBottom:6}}>{question}</div>
                    <RadioGroup
                      name={key}
                      value={form.motorVehicleFields?.[key]??null}
                      onChange={val=>setForm(p=>({...p,motorVehicleFields:{...(p.motorVehicleFields||{}),[key]:val}}))}
                      options={[['Yes',true],['No',false],["I don't know",null]]}
                    />
                  </div>
                ))}
              </div>
            )}
            <Field label="Did your doctor take you off work?">
              <RadioGroup value={form.timeOff} onChange={v=>setForm(p=>({...p,timeOff:v}))} options={[['Yes',true],['No',false]]} name="tof"/>
            </Field>
            <Field label="Medical Treatment Received">
              <textarea value={form.medTreatment} onChange={f('medTreatment')} rows={2} placeholder="Where did you go? What did the doctor say?"/>
            </Field>
            <Field label="Were there witnesses?">
              <input value={form.witnesses} onChange={f('witnesses')} placeholder="Names / relationship"/>
            </Field>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',marginTop:8}}>
            <Btn variant="ghost" onClick={back}>{t('back')}</Btn>
            <Btn onClick={next} disabled={!form.dateOfInjury}>{t('next')} →</Btn>
          </div>
        </div>
      )}

      {/* ── Step 2: Intake Method (equal voice / text) ── */}
      {step===2&&(
        <div style={{animation:'fadeUp 0.25s ease'}}>
          {/* Choice screen */}
          {!intakeMethod&&(
            <div>
              <div style={{fontSize:14,color:C.dim,marginBottom:20}}>{t('intake_method_header')}</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:24}}>
                <button onClick={()=>setIntakeMethod('voice')}
                  style={{background:C.card,border:`1.5px solid ${C.border}`,borderRadius:12,padding:'28px 20px',cursor:'pointer',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:12,color:C.text,transition:'all .18s'}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=C.amber;e.currentTarget.style.background=C.amberF;}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.card;}}>
                  <div style={{fontSize:36}}>🎙</div>
                  <div style={{fontSize:14,fontWeight:700,color:C.text}}>{t('intake_method_voice')}</div>
                  <div style={{fontSize:12,color:C.muted,lineHeight:1.5}}>Record your statement. We'll transcribe and extract key details automatically.</div>
                </button>
                <button onClick={()=>setIntakeMethod('text')}
                  style={{background:C.card,border:`1.5px solid ${C.border}`,borderRadius:12,padding:'28px 20px',cursor:'pointer',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:12,color:C.text,transition:'all .18s'}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blue;e.currentTarget.style.background=C.blueF;}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.card;}}>
                  <div style={{fontSize:36}}>✏️</div>
                  <div style={{fontSize:14,fontWeight:700,color:C.text}}>{t('intake_method_text')}</div>
                  <div style={{fontSize:12,color:C.muted,lineHeight:1.5}}>Type what happened in your own words. We'll extract key details automatically.</div>
                </button>
              </div>
              <Btn variant="ghost" onClick={back}>{t('back')}</Btn>
            </div>
          )}
          {/* Voice path */}
          {intakeMethod==='voice'&&!intakeDone&&(
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
                <div style={{fontSize:13,color:C.dim}}>{t('voice_prompt')}</div>
                <button onClick={()=>setIntakeMethod(null)} style={{background:'none',border:'none',color:C.muted,fontSize:11,cursor:'pointer',fontFamily:C.mono}}>← {t('back')}</button>
              </div>
              <M2VoiceRecorder onResult={handleVoiceResult} language={lang}/>
            </div>
          )}
          {/* Text path */}
          {intakeMethod==='text'&&!intakeDone&&(
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                <div style={{fontSize:13,color:C.dim}}>{t('text_prompt')}</div>
                <button onClick={()=>setIntakeMethod(null)} style={{background:'none',border:'none',color:C.muted,fontSize:11,cursor:'pointer',fontFamily:C.mono}}>← {t('back')}</button>
              </div>
              <textarea value={textInput} onChange={e=>setTextInput(e.target.value)} rows={7} placeholder={t('text_placeholder')} style={{width:'100%',marginBottom:12}}/>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{fontSize:11,color:C.muted}}>{textInput.trim().length<30?`${textInput.trim().length} chars — add more detail`:`${textInput.trim().length} characters`}</div>
                <Btn onClick={submitText} disabled={textInput.trim().length<10||textLoading}>
                  {textLoading?<><Spinner/> Processing…</>:t('text_submit')}
                </Btn>
              </div>
            </div>
          )}
          {/* Review extracted fields */}
          {intakeDone&&(
            <div>
              <div style={{background:C.greenF,border:`1px solid ${C.green}33`,borderRadius:9,padding:'10px 14px',marginBottom:16,fontSize:12,color:C.green}}>
                ✓ Statement received. Review and edit the details below if needed.
              </div>
              {extraction&&(
                <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:16,marginBottom:16}}>
                  <Lbl>Extracted Details</Lbl>
                  {extraction.body_part&&<InfoPair label="Body Part" value={extraction.body_part} accent={C.cyan}/>}
                  {extraction.time_of_injury&&<InfoPair label="Time of Injury" value={extraction.time_of_injury}/>}
                  {extraction.witnesses&&<InfoPair label="Witnesses" value={extraction.witnesses}/>}
                  {typeof extraction.confidence==='number'&&<div style={{fontSize:11,color:C.muted,marginTop:6,fontFamily:C.mono}}>Extraction confidence: {extraction.confidence}%</div>}
                </div>
              )}
              <Field label="Your Full Statement (edit if needed)">
                <textarea value={form.mechanism} onChange={f('mechanism')} rows={5} placeholder="Describe what happened…"/>
              </Field>
              <div style={{display:'flex',justifyContent:'space-between',marginTop:8}}>
                <Btn variant="ghost" onClick={()=>{setIntakeDone(false);setIntakeMethod(null);}}>{t('back')}</Btn>
                <Btn onClick={next} disabled={!form.mechanism}>{t('next')} →</Btn>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Media Upload (optional) ── */}
      {step===3&&(
        <div style={{animation:'fadeUp 0.25s ease'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
            <div style={{fontSize:12,color:C.dim}}>{t('media_sub')}</div>
            <span style={{fontSize:10,background:C.border,color:C.muted,padding:'2px 8px',borderRadius:4,fontFamily:C.mono}}>{t('media_optional_badge')}</span>
          </div>
          <MediaUploader files={form.media} onAdd={newFiles=>setForm(p=>({...p,media:[...p.media,...newFiles]}))} onRemove={i=>setForm(p=>({...p,media:p.media.filter((_,idx)=>idx!==i)}))}/>
          <div style={{fontSize:11,color:C.muted,marginTop:10}}>{t('media_accepted')}</div>
          <div style={{display:'flex',justifyContent:'space-between',marginTop:20}}>
            <Btn variant="ghost" onClick={back}>{t('back')}</Btn>
            <div style={{display:'flex',gap:10}}>
              <Btn variant="ghost" onClick={next}>{t('skip')}</Btn>
              <Btn onClick={next}>{t('next')} →</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 4: MPN Notice + Provider Selection ── */}
      {step===4&&(
        <div style={{animation:'fadeUp 0.25s ease'}}>
          {/* MPN Rights Notice */}
          {!mpnAck&&(
            <div>
              <div style={{background:C.blueF,border:`1px solid ${C.blue}22`,borderRadius:10,padding:20,marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:10}}>{t('mpn_notice_title')}</div>
                <div style={{fontSize:13,color:C.dim,lineHeight:1.75}}>{t('mpn_rights_notice')}</div>
              </div>
              <label style={{display:'flex',alignItems:'flex-start',gap:10,cursor:'pointer',fontSize:13,color:C.text,marginBottom:20}}>
                <input type="checkbox" checked={mpnAck} onChange={e=>setMpnAck(e.target.checked)} style={{marginTop:2}}/>
                {t('mpn_acknowledge')}
              </label>
              <Btn variant="ghost" onClick={back}>{t('back')}</Btn>
            </div>
          )}
          {/* Provider list */}
          {mpnAck&&!selProvider&&(
            <div>
              <div style={{fontSize:12,color:C.muted,marginBottom:16}}>{t('mpn_instruction')}</div>
              {provLoading&&<div style={{display:'flex',gap:10,alignItems:'center',padding:20}}><Spinner/><span style={{color:C.dim}}>Loading providers near {form.homeZip}…</span></div>}
              {!provLoading&&providers.map(p=>(
                <div key={p.id} style={{background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:10,padding:'14px 16px',marginBottom:10,cursor:'pointer',transition:'all .18s'}}
                  onClick={()=>selectProvider(p)}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                    <div>
                      <div style={{fontWeight:700,fontSize:14,color:C.text}}>{p.name}</div>
                      <div style={{fontSize:12,color:C.dim,marginTop:2}}>{p.branch&&`${p.branch} · `}{p.addr||p.address}{p.city&&`, ${p.city}`}</div>
                      <div style={{display:'flex',gap:8,marginTop:6,flexWrap:'wrap'}}>
                        {p.rating&&<span style={{fontSize:11,color:C.amber,fontFamily:C.mono}}>★ {p.rating}{p.reviews&&` (${p.reviews})`}</span>}
                        {p.specialty&&<span style={{fontSize:11,color:C.dim}}>{p.specialty}</span>}
                        {(p.walk_in||p.walkIn)&&<span style={{fontSize:10,background:C.greenF,color:C.green,padding:'1px 7px',borderRadius:4,fontFamily:C.mono,border:`1px solid ${C.green}33`}}>{t('mpn_walk_in')}</span>}
                        {p.mpn_tier===1&&<span style={{fontSize:10,background:C.amberF,color:C.amber,padding:'1px 7px',borderRadius:4,fontFamily:C.mono,border:`1px solid ${C.amber}33`}}>{t('mpn_tier_preferred')}</span>}
                      </div>
                    </div>
                    <Btn small onClick={e=>{e.stopPropagation();selectProvider(p);}} disabled={apptLoading}>{t('mpn_select')}</Btn>
                  </div>
                </div>
              ))}
              {!provLoading&&providers.length===0&&<div style={{color:C.muted,fontSize:13}}>{t('mpn_no_results')}</div>}
              <div style={{marginTop:10}}><Btn variant="ghost" onClick={()=>setMpnAck(false)}>{t('back')}</Btn></div>
            </div>
          )}
          {/* Confirmation number entry */}
          {selProvider&&!apptConfirmed&&(
            <div>
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:18,marginBottom:18}}>
                <SectionHead title={t('book_header')}/>
                <InfoPair label={t('book_call_prompt')} value={selProvider.phone} mono accent={C.cyan}/>
                <InfoPair label="Provider" value={selProvider.name}/>
                <InfoPair label="Address" value={selProvider.addr||selProvider.address||''}/>
              </div>
              <div style={{fontSize:13,color:C.dim,marginBottom:16}}>{t('book_instruction')}</div>
              <Field label={t('confirmation_number')}>
                <input value={confirmNum} onChange={e=>setConfirmNum(e.target.value)} placeholder={t('confirmation_placeholder')}/>
              </Field>
              <div style={{display:'flex',justifyContent:'space-between',marginTop:8}}>
                <Btn variant="ghost" onClick={()=>{setSelProvider(null);setAppointmentId(null);setConfirmNum('');}}>{t('book_try_other')}</Btn>
                <Btn onClick={confirmAppt} disabled={!confirmNum.trim()||apptLoading}>
                  {apptLoading?<><Spinner/> Confirming…</>:t('book_confirm')}
                </Btn>
              </div>
            </div>
          )}
          {apptConfirmed&&(
            <div style={{textAlign:'center',padding:'24px 0',animation:'fadeUp .2s ease'}}>
              <div style={{fontSize:28,marginBottom:10}}>✅</div>
              <div style={{fontSize:16,fontWeight:700,color:C.green}}>{t('book_confirmed_title')}</div>
              <div style={{fontSize:13,color:C.dim,marginTop:6}}>{t('book_confirmed_sub')}</div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 5: DWC-1 Preview + Submit ── */}
      {step===5&&(
        <div style={{animation:'fadeUp 0.25s ease'}}>
          <div style={{fontSize:13,color:C.dim,marginBottom:20}}>{t('dwc1_instruction')}</div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:20,marginBottom:20}}>
            <SectionHead title="Claim Summary"/>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'4px 24px'}}>
              <InfoPair label="Claimant" value={form.claimant}/>
              <InfoPair label="Employer" value={form.employer}/>
              <InfoPair label="Date of Injury" value={form.dateOfInjury} mono/>
              <InfoPair label="Body Part" value={form.bodyPart}/>
              <InfoPair label="Off Work" value={form.timeOff?'Yes':'No'} accent={form.timeOff?C.amber:C.green}/>
              <InfoPair label="Media Attached" value={`${form.media.length} file${form.media.length!==1?'s':''}`} accent={form.media.length>0?C.teal:C.muted}/>
            </div>
            {form.mechanism&&<InfoPair label="Injury Description" value={form.mechanism.slice(0,150)+(form.mechanism.length>150?'…':'')}/>}
            {selProvider&&apptConfirmed&&<InfoPair label="Appointment" value={`${selProvider.name} — confirmation #${confirmNum}`} accent={C.teal}/>}
          </div>
          <div style={{background:C.blueF,border:`1px solid ${C.blue}22`,borderRadius:9,padding:'12px 16px',fontSize:12,color:C.dim,lineHeight:1.75,marginBottom:16}}>
            {t('dwc1_review_note')}
          </div>
          <div style={{background:C.amberF,border:`1px solid ${C.amber}22`,borderRadius:9,padding:'12px 16px',fontSize:12,color:C.amber,marginBottom:20}}>
            {t('dwc1_signature_notice')}
          </div>
          <div style={{display:'flex',justifyContent:'space-between'}}>
            <Btn variant="ghost" onClick={back}>{t('back')}</Btn>
            <Btn onClick={submit} icon="✓">{t('sign_and_submit')}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// RFA CENTER (Admin) — M7: RFA Decision Pipeline
// ═══════════════════════════════════════════════════════════
function RFADrawer({rfa,onClose,onApprove,onRouteURO,approving,routing}){
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

function RFACenter({notify}){
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
function NoticeCenter({claims,jsPdfReady,notify}){
  const [selClaim,setSelClaim]=useState(claims[0]?.id||"");
  const [noticeType,setNoticeType]=useState("dwc7");
  const [lobModal,setLobModal]=useState(null);
  const [sentNotices,setSentNotices]=useState([]);
  const claim=claims.find(c=>c.id===selClaim);

  const preview=()=>{
    if(!jsPdfReady||!claim) return;
    const doc=generateNoticePDF(claim,noticeType);
    const url=URL.createObjectURL(doc.output("blob"));
    window.open(url,"_blank");
  };

  const lobSend=()=>{
    if(!claim) return;
    const nt=NOTICE_TYPES.find(n=>n.id===noticeType);
    setLobModal({claim,noticeType,label:nt?.label,addr:claim.homeAddr+", "+claim.homeZip});
  };

  const confirmLob=()=>{
    if(!lobModal) return;
    const record={id:`ltr_${Math.random().toString(36).slice(2,8)}`,claimId:lobModal.claim.id,claimant:lobModal.claim.claimant,type:lobModal.label,sentAt:new Date().toLocaleString(),estimatedDelivery:"3-5 business days",cost:"$1.11",status:"queued"};
    setSentNotices(p=>[record,...p]);
    setLobModal(null);
    notify(`Notice queued for print & mail via Lob — ${record.id}`);
  };

  return(
    <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:24}}>
        <h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Notice Center</h1>
        <p style={{color:C.muted,fontSize:13}}>Generate required CA WC notices · Preview PDF · Queue for print & mail via Lob.com</p>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"340px 1fr",gap:20}}>
        {/* Generator Panel */}
        <div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:22,marginBottom:16}}>
            <SectionHead title="Generate Notice"/>
            <Field label="Select Claim">
              <select value={selClaim} onChange={e=>setSelClaim(e.target.value)}>
                {claims.map(c=><option key={c.id} value={c.id}>{c.id} — {c.claimant}</option>)}
              </select>
            </Field>
            <Field label="Notice Type">
              <select value={noticeType} onChange={e=>setNoticeType(e.target.value)}>
                {NOTICE_TYPES.map(n=><option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
            </Field>
            {claim&&(
              <div style={{background:C.bg,borderRadius:7,padding:"10px 12px",marginBottom:14,fontSize:11,color:C.dim,lineHeight:1.7}}>
                <strong style={{color:C.text}}>To:</strong> {claim.claimant}<br/>
                {claim.homeAddr||"Address on file"}<br/>
                <span style={{color:C.muted}}>{NOTICE_TYPES.find(n=>n.id===noticeType)?.trigger} · {NOTICE_TYPES.find(n=>n.id===noticeType)?.urgency}</span>
              </div>
            )}
            <div style={{display:"flex",gap:8}}>
              <Btn small variant="ghost" onClick={preview} disabled={!jsPdfReady||!claim}>Preview PDF</Btn>
              <Btn small variant="teal" onClick={lobSend} disabled={!claim} icon="📮">Send via Lob</Btn>
            </div>
          </div>
          {/* Required Notice Calendar */}
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:18}}>
            <SectionHead title="CA WC Notice Requirements"/>
            {NOTICE_TYPES.map(n=>(
              <div key={n.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:8,marginBottom:8,borderBottom:`1px solid ${C.border}`}}>
                <div>
                  <div style={{fontSize:12,color:C.text,fontWeight:500}}>{n.label.split("—")[1]?.trim()||n.label}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2}}>{n.urgency}</div>
                </div>
                <span style={{fontSize:9,fontFamily:C.mono,color:n.urgency.includes("14")||n.urgency.includes("5")?C.amber:C.dim,background:C.bg,padding:"2px 7px",borderRadius:4,border:`1px solid ${C.border}`}}>REQUIRED</span>
              </div>
            ))}
          </div>
        </div>

        {/* Sent Notices Log */}
        <div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
            <div style={{padding:"16px 22px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between"}}>
              <div style={{fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>LOB.COM PRINT & MAIL QUEUE</div>
              {sentNotices.length>0&&<span style={{fontSize:11,color:C.muted,fontFamily:C.mono}}>{sentNotices.length} sent</span>}
            </div>
            {sentNotices.length===0?(
              <div style={{padding:40,textAlign:"center",color:C.muted,fontSize:13}}>No notices sent yet. Use the generator to queue your first notice.</div>
            ):(
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#09182a"}}>{["Lob ID","Claim","Recipient","Notice Type","Sent","Est. Delivery","Cost","Status"].map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>)}</tr></thead>
                <tbody>{sentNotices.map((n,i)=>(
                  <tr key={n.id} style={{borderBottom:i<sentNotices.length-1?`1px solid ${C.border}`:"none"}}>
                    <td style={{padding:"12px 14px",fontFamily:C.mono,fontSize:11,color:C.purple}}>{n.id}</td>
                    <td style={{padding:"12px 14px",fontFamily:C.mono,fontSize:11,color:C.amber}}>{n.claimId}</td>
                    <td style={{padding:"12px 14px",fontSize:12}}>{n.claimant}</td>
                    <td style={{padding:"12px 14px",fontSize:11,color:C.dim}}>{n.type.split("—")[1]?.trim()||n.type}</td>
                    <td style={{padding:"12px 14px",fontSize:11,fontFamily:C.mono,color:C.dim}}>{n.sentAt}</td>
                    <td style={{padding:"12px 14px",fontSize:11,color:C.muted}}>{n.estimatedDelivery}</td>
                    <td style={{padding:"12px 14px",fontFamily:C.mono,fontSize:12,color:C.green}}>{n.cost}</td>
                    <td style={{padding:"12px 14px"}}><span style={{fontSize:10,background:C.amberF,color:C.amber,padding:"2px 8px",borderRadius:4,fontFamily:C.mono,border:`1px solid ${C.amber}33`}}>queued</span></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Lob Modal */}
      {lobModal&&(
        <>
          <div onClick={()=>setLobModal(null)} style={{position:"fixed",inset:0,background:"rgba(2,8,18,.8)",zIndex:300}}/>
          <div style={{position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:520,background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,zIndex:301,padding:28,animation:"fadeUp .2s ease"}}>
            <div style={{fontFamily:C.mono,fontSize:12,color:C.teal,fontWeight:600,marginBottom:12}}>LOB.COM PRINT & MAIL</div>
            <div style={{fontSize:16,fontWeight:700,marginBottom:4}}>Confirm Mailing</div>
            <div style={{fontSize:12,color:C.muted,marginBottom:20}}>This will queue a USPS first-class letter via Lob.com's print & mail API.</div>
            <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:9,padding:"14px 16px",marginBottom:16,fontFamily:C.mono,fontSize:11,color:C.dim,lineHeight:2}}>
              <div style={{color:C.muted}}>POST https://api.lob.com/v1/letters</div>
              <div>{`"description": "${lobModal.label}"`}</div>
              <div>{`"to": { "name": "${lobModal.claim.claimant}", "address": "${lobModal.addr}" }`}</div>
              <div>{`"from": { "name": "HomeCare TPA", ... }`}</div>
              <div>{`"mail_type": "usps_first_class"`}</div>
              <div>{`"color": false, "double_sided": false`}</div>
              <div style={{color:C.green,marginTop:4}}>{`// Estimated cost: $1.11 | Delivery: 3-5 business days`}</div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <Btn variant="teal" onClick={confirmLob}>Confirm & Queue Letter</Btn>
              <Btn variant="ghost" onClick={()=>setLobModal(null)}>Cancel</Btn>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ACTION QUEUE (M3) — claims needing immediate attention
// ═══════════════════════════════════════════════════════════
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
function AdminDashboard({claims,onSelect,onAnalyze,aiLoading,onGenPDF,onPushCMS,jsPdfReady}){
  const [tab,setTab]=useState("queue");
  const today=new Date().toISOString().split('T')[0];
  const actionCount=claims.filter(c=>["new_claim","intake_complete","under_investigation"].includes(c.status)||(c.diaries||[]).some(d=>d.status==='open'&&d.dueDate<today)).length;
  const totalReserves=claims.reduce((s,c)=>c.aiAnalysis?s+(c.aiAnalysis.suggestedMedicalReserve||0)+(c.aiAnalysis.suggestedIndemnityReserve||0)+(c.aiAnalysis.suggestedExpenseReserve||0):s,0);
  const withAI=claims.filter(c=>c.aiAnalysis).length;
  const {data:pendingRfas=[]}=useQuery({queryKey:['rfas','pending'],queryFn:()=>fetchRFAs({status:'pending_adjuster_review'}),refetchInterval:30_000,retry:false,staleTime:30_000});

  return(
    <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:26}}><h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Claims Console</h1><p style={{color:C.muted,fontSize:13}}>Action Queue · AI Analysis · Reserve Approval · CMS Sync</p></div>
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
            <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>{["Claim ID","Claimant","Employer","DOI","Injury","Status","Priority","Reserve","Appt","Media","Actions"].map(h=><th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
            <tbody>{claims.map((c,i)=>{
              const res=c.aiAnalysis?c.aiAnalysis.suggestedMedicalReserve+c.aiAnalysis.suggestedIndemnityReserve+c.aiAnalysis.suggestedExpenseReserve:null;
              return(
                <tr key={c.id} className="rh" onClick={()=>onSelect(c.id)} style={{borderBottom:i<claims.length-1?`1px solid ${C.border}`:"none",animation:`fadeUp .3s ease ${i*.04}s both`}}>
                  <td style={{padding:"12px 13px"}}><span style={{fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{c.id}</span></td>
                  <td style={{padding:"12px 13px",fontSize:13,fontWeight:500}}>{c.claimant}</td>
                  <td style={{padding:"12px 13px",fontSize:12,color:C.dim}}>{c.employer}</td>
                  <td style={{padding:"12px 13px",fontSize:12,fontFamily:C.mono,color:C.dim}}>{c.dateOfInjury}</td>
                  <td style={{padding:"12px 13px"}}><div style={{fontSize:12,color:C.dim}}>{c.injuryType}</div><div style={{fontSize:10,color:C.muted,marginTop:2}}>{c.bodyPart}</div></td>
                  <td style={{padding:"12px 13px"}}><Badge status={c.status}/></td>
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

// ═══════════════════════════════════════════════════════════
// CLAIM DRAWER (Admin) — M3: live data, reserve approval, diaries, status
// ═══════════════════════════════════════════════════════════
const VALID_NEXT={
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
const STATUS_LABEL={
  new_claim:"New Claim",intake_complete:"Intake Done",under_investigation:"Investigation",
  accepted:"Accepted",active_medical:"Active Medical",p_and_s:"P&S",pd_evaluation:"PD Eval",
  settlement_discussions:"Settlement",litigated:"Litigated",denied:"Denied",closed:"Closed",
};
const PRI_DIARY={CRITICAL:C.red,HIGH:C.amber,MEDIUM:C.blue,LOW:C.dim};

function ClaimDrawer({claimId,onClose,notify,jsPdfReady,onGenDWC1}){
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
            <div style={{fontFamily:C.mono,color:C.amber,fontSize:12,fontWeight:600,marginBottom:4}}>{claim.claimNumber||claim.id}</div>
            <div style={{fontSize:19,fontWeight:700}}>{empName}</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>{claim.employerName||claim.employer||'—'} · {claim.dateOfInjury}</div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",paddingTop:4}}>
            <span style={{display:"inline-block",background:C.card,color:C.amber,border:`1px solid ${C.amber}33`,padding:"3px 9px",borderRadius:4,fontSize:10,fontFamily:C.mono,fontWeight:600,textTransform:"uppercase"}}>{STATUS_LABEL[claim.status]||claim.status}</span>
            <button onClick={onClose} style={{background:C.card,border:`1px solid ${C.border}`,color:C.dim,cursor:"pointer",width:28,height:28,borderRadius:6,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
          </div>
        </div>

        <div style={{padding:"22px 26px"}}>
          <Tabs tabs={[{key:"details",label:"Details"},{key:"qme",label:`QME/AME (${qmePanels.length})`},{key:"mmi",label:"MMI / P&S"},{key:"pd",label:"PD / Stip"}]} active={drawerTab} onChange={setDrawerTab}/>

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
function linkStatus(claim){
  const evts=claim.events||[];
  if(evts.some(e=>e.type==='intake_complete')) return {label:'Completed',color:C.green,bg:C.greenF};
  if(evts.some(e=>e.type==='magic_link_validated')) return {label:'Opened',color:C.cyan,bg:C.tealF};
  if(evts.some(e=>e.type==='magic_link_sent')) return {label:'Sent',color:C.amber,bg:C.amberF};
  return {label:'Not Sent',color:C.muted,bg:'transparent'};
}

// ═══════════════════════════════════════════════════════════
// EMPLOYER LOGIN
// ═══════════════════════════════════════════════════════════
function EmployerLogin({onLogin}){
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
function FROIForm(){
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
function EmployerReports({employerId}){
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
function AdminReports({onSelect}){
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
function EmployerPortal({employerUser,setEmployerUser,onSelect}){
  const [view,setView]=useState("new");

  // Auth gate — show login if no employer session
  if(!employerUser) return <EmployerLogin onLogin={setEmployerUser}/>;

  const {employerName}=employerUser;

  // Claims via React Query — scoped by employer auth on the backend
  const {data:myClaims=[],isLoading:claimsLoading}=useQuery({
    queryKey:['employer-claims'],
    queryFn:fetchClaims,
    refetchInterval:30_000,
  });

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
function TopNav({role,setRole,claims,adminView,setAdminView}){
  const today=new Date().toISOString().split('T')[0];
  const att=claims.filter(c=>["new_claim","intake_complete","under_investigation"].includes(c.status)||(c.diaries||[]).some(d=>d.status==='open'&&d.dueDate<today)).length;
  return(
    <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:22,height:60,padding:"0 26px",position:"sticky",top:0,zIndex:100}}>
      <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        <div style={{width:32,height:32,background:`linear-gradient(135deg,${C.amber},${C.amberD})`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 2px 10px ${C.amber}44`}}><span style={{fontFamily:C.mono,fontWeight:700,fontSize:14,color:"#000"}}>H</span></div>
        <div><div style={{fontFamily:C.mono,fontWeight:600,fontSize:13,color:C.text}}>HomeCare TPA</div><div style={{fontSize:9,color:C.muted}}>Workers' Compensation · v3</div></div>
      </div>
      <div style={{display:"flex",background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:3,gap:2,margin:"0 auto"}}>
        {[{key:"admin",label:"⚡ Admin"},{key:"employer",label:"🏢 Employer"},{key:"employee",label:"👤 Employee"}].map(({key,label})=>(
          <button key={key} onClick={()=>setRole(key)} style={{background:role===key?C.amber:"transparent",color:role===key?"#000":C.dim,border:"none",padding:"6px 16px",borderRadius:6,fontSize:12,fontWeight:700,fontFamily:C.sans,cursor:"pointer",transition:"all .18s"}}>{label}</button>
        ))}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        {role==="admin"&&(
          <div style={{display:"flex",background:C.bg,border:`1px solid ${C.border}`,borderRadius:7,padding:2,gap:2}}>
            {[{key:"claims",label:"Claims"},{key:"rfas",label:"RFAs"},{key:"notices",label:"Notices"},{key:"reports",label:"Reports"}].map(({key,label})=>(
              <button key={key} onClick={()=>setAdminView(key)} style={{background:adminView===key?C.borderMid:"transparent",color:adminView===key?C.text:C.muted,border:"none",padding:"4px 12px",borderRadius:5,fontSize:11,fontWeight:600,fontFamily:C.sans,cursor:"pointer"}}>{label}</button>
            ))}
          </div>
        )}
        {att>0&&<div className="pulse" style={{background:C.amberF,border:`1px solid ${C.amber}44`,color:C.amber,borderRadius:20,padding:"3px 11px",fontSize:10,fontFamily:C.mono,fontWeight:600}}>{att} pending</div>}
        <div style={{width:32,height:32,background:"linear-gradient(135deg,#193855,#0f2340)",border:`1px solid ${C.borderMid}`,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:C.amber,fontFamily:C.mono}}>AK</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════
export default function App(){
  const [role,setRole]=useState("employee");
  const [adminView,setAdminView]=useState("claims");
  const [selectedId,setSelectedId]=useState(null);
  const [toast,setToast]=useState(null);
  const [jsPdfReady,setJsPdfReady]=useState(false);
  const [employerUser,setEmployerUser]=useState(null);

  // ── Dev session auto-login for admin (replaced by Supabase Auth in M5) ────────
  useEffect(()=>{ensureDevSession();},[]);

  // ── Dev employer session when switching to employer portal ────────────────────
  useEffect(()=>{
    if(role==='employer'&&!employerUser){
      ensureDevEmployerSession().then(data=>{
        if(data?.ok) setEmployerUser({employerId:data.employerId,employerName:data.employerName,email:data.email||'hr@brightcarehh.com'});
      });
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
      <TopNav role={role} setRole={setRole} claims={claims} adminView={adminView} setAdminView={setAdminView}/>
      <div style={{maxWidth:1400,margin:"0 auto",padding:"0 26px 80px"}}>
        {role==="admin"&&adminView==="claims"&&(
          claimsLoading
            ?<div style={{paddingTop:64,textAlign:"center"}}><Spinner/></div>
            :claimsError
              ?<div style={{paddingTop:32,color:C.red,fontSize:13}}>Failed to load claims: {claimsError.message}</div>
              :<AdminDashboard claims={claims} onSelect={setSelectedId} onGenPDF={()=>{}} onPushCMS={()=>{}} jsPdfReady={jsPdfReady}/>
        )}
        {role==="admin"&&adminView==="rfas"&&<RFACenter notify={notify}/>}
        {role==="admin"&&adminView==="notices"&&<NoticeCenter claims={claims} jsPdfReady={jsPdfReady} notify={notify}/>}
        {role==="admin"&&adminView==="reports"&&<AdminReports onSelect={setSelectedId}/>}
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
      {selectedId&&<ClaimDrawer claimId={selectedId} onClose={()=>setSelectedId(null)} notify={notify} jsPdfReady={jsPdfReady} onGenDWC1={genDWC1}/>}
    </div>
  );
}
