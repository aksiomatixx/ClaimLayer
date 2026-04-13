import { useState, useEffect, useRef, useCallback } from "react";

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

const INIT_CLAIMS=[
  {id:"HHW-2026-041",claimant:"Maria Santos",claimantDOB:"03/15/1981",employer:"BrightCare Home Health",dateOfInjury:"04/01/2026",bodyPart:"Lumbar Spine / Lower Back",injuryType:"Lifting Injury",mechanism:"Lifted 180lb non-ambulatory patient without mechanical lift assist during morning transfer. Immediate sharp pop with left leg radiculopathy.",medTreatment:"ED 4/1 — L4-L5 disc herniation. MRI authorized. Off work.",timeOff:true,priorClaims:"1 prior low back 2023 — C&R $18,500",witnesses:"Client's daughter",aww:750.75,tdRate:500.50,homeZip:"90057",homeAddr:"1842 W 7th St, Los Angeles CA 90057",phone:"(213) 555-0142",media:[],voiceTranscript:"",status:"pending",aiAnalysis:null,adminDecision:null,pdfGenerated:false,cmsPushed:false,appointment:null,dwc1Signed:false,noticeLog:[],filedAt:"04/02/2026 9:15 AM",filedBy:"employer"},
  {id:"HHW-2026-038",claimant:"James Okonkwo",claimantDOB:"07/22/1975",employer:"ComfortFirst Healthcare",dateOfInjury:"03/28/2026",bodyPart:"Right Hand / Wrist",injuryType:"Needlestick / Sharps",mechanism:"Needlestick recapping IV catheter. Client Hep-C positive with elevated viral load.",medTreatment:"Urgent care same day. Prophylactic antiviral initiated.",timeOff:false,priorClaims:"None",witnesses:"None",aww:1120.00,tdRate:746.67,homeZip:"90008",homeAddr:"4320 Crenshaw Blvd Apt 8, Los Angeles CA 90008",phone:"(323) 555-0198",media:[],voiceTranscript:"",status:"pending",aiAnalysis:null,adminDecision:null,pdfGenerated:false,cmsPushed:false,appointment:null,dwc1Signed:false,noticeLog:[],filedAt:"04/01/2026 2:30 PM",filedBy:"employee"},
  {id:"HHW-2026-035",claimant:"Lupe Hernandez",claimantDOB:"11/08/1990",employer:"SunRise Home Care",dateOfInjury:"03/20/2026",bodyPart:"Left Knee",injuryType:"Slip & Fall",mechanism:"Slipped on wet bathroom tile assisting patient. Left knee struck tile. Immediate swelling.",medTreatment:"Orthopedic consult 3/22. MRI: medial meniscus tear grade II. Surgical consult scheduled.",timeOff:true,priorClaims:"None",witnesses:"Patient present",aww:621.00,tdRate:414.00,homeZip:"91405",homeAddr:"7715 Sepulveda Blvd, Van Nuys CA 91405",phone:"(818) 555-0077",media:[],voiceTranscript:"",status:"ai_complete",aiAnalysis:{compensability:"Likely Compensable",compensabilityScore:94,suggestedMedicalReserve:35000,suggestedIndemnityReserve:22000,suggestedExpenseReserve:3200,priority:"High",redFlags:["Surgical case — medial meniscus tear on MRI","Extended TTD if arthroscopic surgery"],nextActions:["Issue DWC-1","Pre-authorize surgical consult","Initiate UR when RFA received","Set TD indemnity"],analysisNotes:"Slip on wet tile during ADL assistance — clearly AOE/COE. Meniscus tear in 35-year-old typically requires arthroscopic repair. Reserve at surgical threshold.",medicalAppointment:{providerType:"Orthopedic Surgery",urgency:"Within 24 hours",recommendedFacility:"SoCal Ortho & Sports — Koreatown",facilityAddress:"3650 W 6th St Ste 400, Los Angeles CA 90020",schedulingAction:"Auth code MPN-2026-9241 issued. Call (213) 383-9898 to schedule."}},adminDecision:null,pdfGenerated:false,cmsPushed:false,appointment:{facility:"SoCal Ortho & Sports — Koreatown",date:"Apr 22, 2026",time:"10:30 AM",authCode:"MPN-2026-9241",confirmed:true},dwc1Signed:true,noticeLog:[{type:"dwc7",sentAt:"03/21/2026 9:00 AM",method:"lob",lobId:"ltr_4kX9m2"}],filedAt:"03/21/2026 8:00 AM",filedBy:"employer"},
];

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
function StepBar({step,total}){return <div style={{display:"flex",gap:6,marginBottom:28}}>{Array.from({length:total},(_,i)=><div key={i} style={{flex:1,height:3,borderRadius:2,background:i<step?C.amber:i===step?C.amber+"88":C.border,transition:"background .3s"}}/>}</div>;}

// ═══════════════════════════════════════════════════════════
// VOICE RECORDER
// ═══════════════════════════════════════════════════════════
function VoiceRecorder({onTranscript,initialText=""}){
  const [listening,setListening]=useState(false);
  const [transcript,setTranscript]=useState(initialText);
  const [interim,setInterim]=useState("");
  const recRef=useRef(null);
  const SR=typeof window!=="undefined"&&(window.SpeechRecognition||window.webkitSpeechRecognition);

  const start=()=>{
    if(!SR){alert("Voice input requires Chrome or Edge browser.");return;}
    const r=new SR(); r.continuous=true; r.interimResults=true; r.lang="en-US";
    r.onresult=e=>{let fin="",intr="";for(const res of e.results){if(res.isFinal)fin+=res[0].transcript+" ";else intr+=res[0].transcript;}setTranscript(t=>t+fin);setInterim(intr);};
    r.onerror=()=>{setListening(false);setInterim("");};
    r.onend=()=>{setListening(false);setInterim("");};
    r.start(); recRef.current=r; setListening(true);
  };
  const stop=()=>{recRef.current?.stop();setListening(false);setInterim("");if(transcript.trim())onTranscript(transcript.trim());};
  const clear=()=>{setTranscript("");setInterim("");};

  return(
    <div style={{background:C.bg,border:`1px solid ${listening?C.red+"88":C.border}`,borderRadius:10,padding:16,transition:"border-color .3s"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <Lbl color={listening?C.red:C.muted} mb={0}>{listening?"● Recording…":"Voice Note"}</Lbl>
        <div style={{display:"flex",gap:8}}>
          {transcript&&<button onClick={clear} style={{background:"none",border:"none",color:C.muted,fontSize:11,cursor:"pointer",fontFamily:C.mono}}>Clear</button>}
          {!listening
            ?<Btn small variant="rose" onClick={start} icon="🎙">Start Recording</Btn>
            :<Btn small variant="danger" onClick={stop}>■ Stop & Save</Btn>}
        </div>
      </div>
      {listening&&(
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <div style={{display:"flex",gap:3}}>{[0,1,2,3,4].map(i=><div key={i} className="blink" style={{width:3,height:8+i*4,background:C.red,borderRadius:2,animationDelay:`${i*0.1}s`}}/>)}</div>
          <span style={{fontSize:12,color:C.dim,fontStyle:"italic"}}>{interim||"Listening… speak clearly"}</span>
        </div>
      )}
      {transcript?(
        <div style={{fontSize:13,color:C.text,lineHeight:1.75,minHeight:48,padding:8,background:C.surface,borderRadius:7,border:`1px solid ${C.border}`}}>
          {transcript}<span className="blink" style={{color:C.amber,marginLeft:2,fontSize:11}}>{listening?"▍":""}</span>
        </div>
      ):(
        <div style={{fontSize:12,color:C.muted,fontStyle:"italic",padding:"8px 0"}}>
          {SR?"Press Start and describe your injury in your own words — your voice will be transcribed automatically.":"Voice input requires Chrome or Edge. Use the text field below instead."}
        </div>
      )}
    </div>
  );
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

// ═══════════════════════════════════════════════════════════
// DWC-1 PDF GENERATOR
// ═══════════════════════════════════════════════════════════
function generateDWC1(claim){
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:"portrait",unit:"mm",format:"letter"});
  const W=215.9,M=14,CW=W-M*2;
  let y=M;

  // Header
  doc.setFillColor(15,30,48); doc.rect(0,0,W,22,"F");
  doc.setFontSize(14);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text("STATE OF CALIFORNIA — WORKERS' COMPENSATION",W/2,10,{align:"center"});
  doc.setFontSize(11);doc.setTextColor(200,220,240);
  doc.text("CLAIM FORM — DWC 1 (Rev. 1/1/2020)",W/2,17,{align:"center"});
  y=30;

  // State notice box
  doc.setFontSize(7);doc.setFont("helvetica","normal");doc.setTextColor(100,120,140);
  doc.setDrawColor(26,46,69); doc.rect(M,y-3,CW,16,"S");
  const notice="Notice: You have the right to compensation benefits if you are injured or become ill because of your job. You also have the right to disagree with decisions affecting your claim. To obtain important information, call the DWC Information and Assistance Line: 1-800-736-7401.";
  const nl=doc.splitTextToSize(notice,CW-4);
  doc.setTextColor(124,154,181); doc.text(nl,M+2,y+2); y+=20;

  const hr=()=>{doc.setDrawColor(26,46,69);doc.line(M,y,W-M,y);y+=3;};
  const lbl=(str,x,yy)=>{doc.setFontSize(7);doc.setFont("helvetica","bold");doc.setTextColor(100,120,140);doc.text(str,x,yy);};
  const val=(str,x,yy,w=80)=>{doc.setFontSize(10);doc.setFont("helvetica","normal");doc.setTextColor(216,232,245);const ls=doc.splitTextToSize(str||"",w);doc.text(ls,x,yy);return ls.length*4.5;};

  // Section: Employee Info
  doc.setFontSize(9);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text("EMPLOYEE",M,y); hr(); y+=2;
  lbl("EMPLOYEE NAME (First, Middle, Last)",M,y); val(claim.claimant,M,y+5,100); y+=12;
  lbl("HOME ADDRESS",M,y); val(claim.homeAddr||"—",M,y+5,100);
  lbl("DATE OF BIRTH",M+120,y); val(claim.claimantDOB,M+120,y+5,40); y+=12;
  lbl("TELEPHONE",M,y); val(claim.phone||"—",M,y+5,60);
  lbl("OCCUPATION / JOB TITLE",M+80,y); val("Home Health Worker",M+80,y+5,80); y+=12;
  lbl("SOCIAL SECURITY NO. (Last 4)",M,y); val("XXX-XX-____",M,y+5,60); y+=14;

  // Section: Injury
  hr();
  doc.setFontSize(9);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text("INJURY / ILLNESS",M,y); y+=5;
  lbl("DATE OF INJURY OR ILLNESS",M,y); val(claim.dateOfInjury,M,y+5,80);
  lbl("TIME OF INJURY",M+100,y); val("See narrative",M+100,y+5,60); y+=12;
  lbl("ADDRESS WHERE ACCIDENT/EXPOSURE OCCURRED (Client's Home)",M,y); val(claim.homeAddr?.split(",")[0]+" (client's residence)",M,y+5,CW); y+=12;
  lbl("DESCRIBE HOW THE INJURY OR ILLNESS OCCURRED",M,y); y+=4;
  doc.setFontSize(8);doc.setFont("helvetica","normal");doc.setTextColor(216,232,245);
  const ml=doc.splitTextToSize(claim.mechanism,CW-4);
  doc.setFillColor(10,22,34); doc.rect(M,y-2,CW,ml.length*4+6,"F");
  doc.text(ml,M+2,y+2); y+=ml.length*4+10;
  lbl("PART OF BODY AFFECTED",M,y); val(claim.bodyPart,M,y+5,80);
  lbl("TYPE OF INJURY",M+100,y); val(claim.injuryType,M+100,y+5,80); y+=12;
  lbl("NAMES OF WITNESSES",M,y); val(claim.witnesses||"None listed",M,y+5,CW); y+=12;

  // Section: Medical
  hr();
  doc.setFontSize(9);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text("MEDICAL TREATMENT",M,y); y+=5;
  lbl("NAME AND ADDRESS OF HEALTH CARE PROVIDER / HOSPITAL",M,y);
  val(claim.appointment?`${claim.appointment.facility}, ${claim.appointment.address}`:(claim.medTreatment?.split(".")[0]||"To be determined"),M,y+5,CW); y+=12;

  // Section: Employer
  hr();
  doc.setFontSize(9);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text("EMPLOYER",M,y); y+=5;
  lbl("EMPLOYER'S NAME",M,y); val(claim.employer,M,y+5,100);
  lbl("DATE EMPLOYER RECEIVED CLAIM",M+110,y); val(claim.filedAt?.split(" ")[0]||new Date().toLocaleDateString(),M+110,y+5,60); y+=12;

  // Signature blocks
  hr();
  doc.setFontSize(8);doc.setFont("helvetica","normal");doc.setTextColor(124,154,181);
  doc.text("EMPLOYEE'S SIGNATURE:",M,y+6); doc.setDrawColor(245,158,11,0.5); doc.line(M+50,y+6,M+120,y+6);
  doc.text("DATE:",M+125,y+6); doc.line(M+135,y+6,W-M,y+6); y+=14;
  if(claim.dwc1Signed){
    doc.setFillColor(0,24,16); doc.rect(M,y-4,CW,12,"F");
    doc.setFontSize(8);doc.setFont("helvetica","bold");doc.setTextColor(15,184,129);
    doc.text(`✓ DIGITALLY SIGNED BY ${claim.claimant.toUpperCase()} — ${new Date().toLocaleDateString()}`,M+4,y+4);
    y+=14;
  }
  doc.setFontSize(8);doc.setFont("helvetica","normal");doc.setTextColor(100,120,140);
  doc.text("EMPLOYER'S SIGNATURE / TITLE:",M,y+6); doc.line(M+60,y+6,W-M,y+6); y+=14;

  // Footer
  doc.setFontSize(7);doc.setTextColor(60,90,110);
  doc.text(`${claim.id} | Generated by HomeCare TPA — ${new Date().toLocaleString()} | CONFIDENTIAL`,W/2,200,{align:"center"});
  return doc;
}

function generateReasoningPDF(claim){
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
  const W=210,M=18,CW=W-M*2; let y=M;
  doc.setFillColor(10,22,34); doc.rect(0,0,W,26,"F");
  doc.setFillColor(245,158,11); doc.rect(0,0,4,26,"F");
  doc.setFontSize(15);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text("HomeCare TPA — AI Reasoning Document",10,12);
  doc.setFontSize(8);doc.setFont("helvetica","normal");doc.setTextColor(100,130,160);
  doc.text(`${claim.id} | ${claim.claimant} | ${claim.employer}`,10,19);
  doc.text(`Generated: ${new Date().toLocaleString()}`,W-M,19,{align:"right"}); y=34;
  const a=claim.aiAnalysis;
  if(!a){doc.setFontSize(10);doc.setTextColor(200,200,200);doc.text("No AI analysis on file.",M,y);return doc;}
  doc.setFontSize(10);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text(`Compensability: ${a.compensability} (${a.compensabilityScore}%)  |  Priority: ${a.priority}`,M,y); y+=8;
  doc.setFontSize(10);doc.setFont("helvetica","bold");doc.setTextColor(34,211,238);
  doc.text(`Suggested Reserves: Medical ${fmt$(a.suggestedMedicalReserve)}  Indemnity ${fmt$(a.suggestedIndemnityReserve)}  Expense ${fmt$(a.suggestedExpenseReserve)}`,M,y); y+=8;
  doc.setDrawColor(26,46,69);doc.line(M,y,W-M,y);y+=5;
  if(a.redFlags?.length){doc.setFontSize(8);doc.setFont("helvetica","bold");doc.setTextColor(240,79,79);doc.text("RED FLAGS:",M,y);y+=4;a.redFlags.forEach(f=>{doc.setFont("helvetica","normal");doc.setTextColor(248,113,113);const ls=doc.splitTextToSize("⚠ "+f,CW);doc.text(ls,M,y);y+=ls.length*4+2;});}
  y+=2;doc.setFontSize(8);doc.setFont("helvetica","bold");doc.setTextColor(74,141,240);doc.text("ACTIONS:",M,y);y+=4;
  a.nextActions?.forEach((act,i)=>{doc.setFont("helvetica","normal");doc.setTextColor(216,232,245);const ls=doc.splitTextToSize(`${i+1}. ${act}`,CW);doc.text(ls,M,y);y+=ls.length*4+2;});
  y+=4;doc.setFontSize(8);doc.setFont("helvetica","normal");doc.setTextColor(124,154,181);
  const nl=doc.splitTextToSize(a.analysisNotes,CW);doc.text(nl,M,y);
  doc.setFontSize(7);doc.setTextColor(60,90,110);
  doc.text("AI analysis is advisory. Final authority rests with the supervising adjuster.",W/2,285,{align:"center"});
  return doc;
}

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
// EMPLOYEE INTAKE WIZARD
// ═══════════════════════════════════════════════════════════
const EMPTY={claimant:"",claimantDOB:"",homeAddr:"",homeZip:"",phone:"",employer:"",dateOfInjury:"",bodyPart:"",injuryType:"",mechanism:"",voiceTranscript:"",medTreatment:"",timeOff:false,priorClaims:"None",witnesses:"",media:[],aww:null,tdRate:null};

function EmployeeIntakeWizard({onComplete}){
  const [step,setStep]=useState(0);
  const [form,setForm]=useState(EMPTY);
  const [submittedId,setSubmittedId]=useState(null);
  const [appointment,setAppointment]=useState(null);
  const f=k=>e=>setForm(p=>({...p,[k]:e.target.value}));

  const next=()=>setStep(s=>Math.min(s+1,3));
  const back=()=>setStep(s=>Math.max(s-1,0));

  const submit=()=>{
    const id=onComplete({...form,appointment});
    setSubmittedId(id);
    setStep(4);
  };

  const handleBook=appt=>{
    setAppointment(appt);
    setTimeout(()=>setStep(3),1200);
  };

  const stepTitles=["Your Information","Describe the Injury","Choose Your Doctor","Review & Submit"];

  if(step===4) return(
    <div style={{textAlign:"center",padding:"40px 20px",animation:"fadeUp 0.3s ease"}}>
      <div style={{width:64,height:64,background:C.greenF,border:`2px solid ${C.green}`,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 18px",fontSize:28,color:C.green}}>✓</div>
      <div style={{fontSize:20,fontWeight:700,color:C.green,marginBottom:6}}>Claim Submitted</div>
      <div style={{fontFamily:C.mono,color:C.amber,fontSize:16,fontWeight:600,marginBottom:10,letterSpacing:"0.04em"}}>{submittedId}</div>
      {appointment&&(
        <div style={{background:C.tealF,border:`1px solid ${C.teal}33`,borderRadius:10,padding:"14px 20px",display:"inline-block",marginBottom:16,textAlign:"left"}}>
          <div style={{fontSize:11,fontFamily:C.mono,color:C.teal,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.06em"}}>Appointment Confirmed</div>
          <div style={{fontSize:14,fontWeight:600,color:C.text}}>{appointment.facility}</div>
          <div style={{fontSize:13,color:C.dim,marginTop:3}}>{appointment.date} at {appointment.time}</div>
          <div style={{fontFamily:C.mono,fontSize:12,color:C.amber,marginTop:4}}>Auth: {appointment.authCode}</div>
        </div>
      )}
      <div style={{fontSize:12,color:C.muted,maxWidth:380,margin:"0 auto 20px",lineHeight:1.8}}>
        A DWC-1 claim form has been sent to your phone and email for your signature. SMS confirmation was sent to {form.phone||"your phone"}. You cannot be retaliated against for filing this claim.
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"center"}}>
        <div style={{fontSize:12,background:C.greenF,border:`1px solid ${C.green}33`,color:C.green,padding:"6px 14px",borderRadius:5,fontFamily:C.mono}}>✓ SMS sent to worker</div>
        <div style={{fontSize:12,background:C.bluef||C.blueF,border:`1px solid ${C.blue}33`,color:C.blue,padding:"6px 14px",borderRadius:5,fontFamily:C.mono}}>✓ DWC-1 sent for e-sign</div>
      </div>
    </div>
  );

  return(
    <div style={{maxWidth:640,margin:"0 auto"}}>
      <div style={{marginBottom:18}}>
        <div style={{fontSize:11,fontFamily:C.mono,color:C.muted,marginBottom:4}}>STEP {step+1} OF 4</div>
        <div style={{fontSize:18,fontWeight:700,color:C.text}}>{stepTitles[step]}</div>
      </div>
      <StepBar step={step} total={4}/>

      {step===0&&(
        <div style={{animation:"fadeUp 0.25s ease"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 20px"}}>
            <Field label="Your Full Legal Name *"><input value={form.claimant} onChange={f("claimant")} placeholder="As on your ID or paycheck"/></Field>
            <Field label="Date of Birth"><input value={form.claimantDOB} onChange={f("claimantDOB")} placeholder="MM/DD/YYYY"/></Field>
            <Field label="Your Employer *">
              <select value={form.employer} onChange={f("employer")}><option value="">Select employer…</option>{EMPLOYERS.map(e=><option key={e}>{e}</option>)}</select>
            </Field>
            <Field label="Phone Number"><input value={form.phone} onChange={f("phone")} placeholder="(xxx) xxx-xxxx"/></Field>
            <Field label="Home Address"><input value={form.homeAddr} onChange={f("homeAddr")} placeholder="Street address"/></Field>
            <Field label="Home Zip Code *"><input value={form.homeZip} onChange={f("homeZip")} placeholder="xxxxx"/></Field>
          </div>
          <div style={{display:"flex",justifyContent:"flex-end",marginTop:8}}>
            <Btn onClick={next} disabled={!form.claimant||!form.employer||!form.homeZip}>Next: Describe Injury →</Btn>
          </div>
        </div>
      )}

      {step===1&&(
        <div style={{animation:"fadeUp 0.25s ease"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 20px",marginBottom:8}}>
            <Field label="Date of Injury *"><input value={form.dateOfInjury} onChange={f("dateOfInjury")} placeholder="MM/DD/YYYY"/></Field>
            <Field label="Body Part Affected">
              <select value={form.bodyPart} onChange={f("bodyPart")}><option value="">Select…</option>{BODY_PARTS.map(b=><option key={b}>{b}</option>)}</select>
            </Field>
            <Field label="Type of Injury">
              <select value={form.injuryType} onChange={f("injuryType")}><option value="">Select…</option>{INJURY_TYPES.map(t=><option key={t}>{t}</option>)}</select>
            </Field>
            <Field label="Did your doctor take you off work?">
              <RadioGroup value={form.timeOff} onChange={v=>setForm(p=>({...p,timeOff:v}))} options={[["Yes",true],["No",false]]} name="tof"/>
            </Field>
          </div>

          <Field label="🎙 Describe Your Injury — Voice or Text">
            <VoiceRecorder onTranscript={t=>setForm(p=>({...p,voiceTranscript:t,mechanism:t}))} initialText={form.voiceTranscript}/>
          </Field>
          {form.voiceTranscript&&(
            <Field label="Review / Edit Transcription">
              <textarea value={form.mechanism} onChange={f("mechanism")} rows={3} placeholder="Edit the transcription if needed…"/>
            </Field>
          )}
          {!form.voiceTranscript&&(
            <Field label="Or Type Your Description *">
              <textarea value={form.mechanism} onChange={f("mechanism")} rows={4} placeholder="Describe exactly what happened: what were you doing, what caused the injury, which body part was hurt…"/>
            </Field>
          )}

          <Field label="📎 Photos & Videos of Injury / Incident Site">
            <MediaUploader files={form.media} onAdd={newFiles=>setForm(p=>({...p,media:[...p.media,...newFiles]}))} onRemove={i=>setForm(p=>({...p,media:p.media.filter((_,idx)=>idx!==i)}))}/>
          </Field>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 20px"}}>
            <Field label="Medical Treatment Received"><textarea value={form.medTreatment} onChange={f("medTreatment")} rows={2} placeholder="Where did you go? What did the doctor say?"/></Field>
            <Field label="Were there witnesses?"><input value={form.witnesses} onChange={f("witnesses")} placeholder="Names / relationship"/></Field>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:8}}>
            <Btn variant="ghost" onClick={back}>← Back</Btn>
            <Btn onClick={next} disabled={!form.dateOfInjury||!form.mechanism}>Next: Choose Your Doctor →</Btn>
          </div>
        </div>
      )}

      {step===2&&(
        <div style={{animation:"fadeUp 0.25s ease"}}>
          <ProviderFinder zip={form.homeZip} injuryType={form.injuryType} onBook={handleBook}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:8}}>
            <Btn variant="ghost" onClick={back}>← Back</Btn>
            <Btn variant="ghost" onClick={()=>setStep(3)}>Skip — I'll arrange later</Btn>
          </div>
        </div>
      )}

      {step===3&&(
        <div style={{animation:"fadeUp 0.25s ease"}}>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:20,marginBottom:20}}>
            <SectionHead title="Claim Summary"/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 24px"}}>
              <InfoPair label="Claimant" value={form.claimant}/>
              <InfoPair label="Employer" value={form.employer}/>
              <InfoPair label="Date of Injury" value={form.dateOfInjury} mono/>
              <InfoPair label="Body Part" value={form.bodyPart}/>
              <InfoPair label="Off Work" value={form.timeOff?"Yes":"No"} accent={form.timeOff?C.amber:C.green}/>
              <InfoPair label="Media Attached" value={`${form.media.length} file${form.media.length!==1?"s":""}`} accent={form.media.length>0?C.teal:C.muted}/>
            </div>
            {form.mechanism&&<InfoPair label="Injury Description" value={form.mechanism.slice(0,120)+(form.mechanism.length>120?"…":"")}/>}
          </div>
          {appointment&&(
            <div style={{background:C.tealF,border:`1px solid ${C.teal}33`,borderRadius:10,padding:16,marginBottom:20}}>
              <SectionHead title="Appointment Confirmed" color={C.teal}/>
              <InfoPair label="Facility" value={appointment.facility} accent={C.teal}/>
              <InfoPair label="Date & Time" value={`${appointment.date} at ${appointment.time}`} mono/>
              <InfoPair label="Address" value={appointment.address}/>
              <InfoPair label="Auth Code" value={appointment.authCode} mono accent={C.amber}/>
            </div>
          )}
          <div style={{background:C.blueF,border:`1px solid ${C.blue}22`,borderRadius:9,padding:"12px 16px",fontSize:12,color:C.dim,lineHeight:1.75,marginBottom:20}}>
            <strong style={{color:C.text}}>By submitting: </strong>
            A DWC-1 claim form will be sent to your phone ({form.phone||"on file"}) and email for your e-signature. Your employer will be notified. AI analysis will be queued. All information is confidential. You cannot be retaliated against.
          </div>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <Btn variant="ghost" onClick={back}>← Back</Btn>
            <Btn onClick={submit} icon="✓">Submit Claim & Send DWC-1</Btn>
          </div>
        </div>
      )}
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
// ADMIN DASHBOARD
// ═══════════════════════════════════════════════════════════
async function runAIAnalysis(claim){
  const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:"You are a senior CA workers' compensation adjuster for home health workers. Respond ONLY with valid JSON, no markdown.",messages:[{role:"user",content:`Analyze this CA WC claim:
ID:${claim.id} Claimant:${claim.claimant} DOI:${claim.dateOfInjury} Body:${claim.bodyPart} Mechanism:${claim.mechanism} Medical:${claim.medTreatment} OffWork:${claim.timeOff} AWW:${claim.aww} PriorClaims:${claim.priorClaims}

Return ONLY JSON: {"compensability":"Likely Compensable|Questionable|Likely Non-Compensable","compensabilityScore":0-100,"suggestedMedicalReserve":int,"suggestedIndemnityReserve":int,"suggestedExpenseReserve":int,"priority":"Critical|High|Medium|Low","redFlags":["str"],"nextActions":["str"],"analysisNotes":"str","medicalAppointment":{"providerType":"str","urgency":"Immediate|Within 24 hours|Within 72 hours|Routine","recommendedFacility":"str","facilityAddress":"str","schedulingAction":"str"}}`}]})});
  if(!res.ok) throw new Error(`API ${res.status}`);
  const d=await res.json();
  return JSON.parse((d.content?.find(b=>b.type==="text")?.text||"{}").replace(/```json|```/g,"").trim());
}

function AdminDashboard({claims,onSelect,onAnalyze,aiLoading,onGenPDF,onPushCMS,jsPdfReady}){
  const pending=claims.filter(c=>c.status==="pending").length;
  const aiReady=claims.filter(c=>c.status==="ai_complete").length;
  const res=claims.reduce((s,c)=>c.aiAnalysis?s+(c.aiAnalysis.suggestedMedicalReserve||0)+(c.aiAnalysis.suggestedIndemnityReserve||0)+(c.aiAnalysis.suggestedExpenseReserve||0):s,0);
  const appts=claims.filter(c=>c.appointment?.confirmed).length;

  return(
    <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:26}}><h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Claims Console</h1><p style={{color:C.muted,fontSize:13}}>Review AI decisions · Generate PDFs · Push to FileHandler · Send notices via Lob.com</p></div>
      <div style={{display:"flex",gap:14,marginBottom:30}}>
        <StatCard label="Total Claims" value={claims.length} delay={0}/>
        <StatCard label="Awaiting AI" value={pending} accent={pending>0?C.amber:C.green} sub="Need analysis" delay={.05}/>
        <StatCard label="AI Ready" value={aiReady} accent={aiReady>0?C.blue:C.green} sub="Pending decision" delay={.1}/>
        <StatCard label="AI Reserves" value={res>0?fmt$(res):"—"} accent={C.purple} sub="Total suggested" delay={.15}/>
        <StatCard label="Appointments" value={appts} accent={C.teal} sub="Confirmed" delay={.2}/>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>AI DECISION QUEUE — {claims.length} CLAIMS</div>
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
                      {c.status==="pending"&&<Btn small variant="outline" onClick={()=>onAnalyze(c)} disabled={aiLoading===c.id}>{aiLoading===c.id?<Spinner/>:"Run AI"}</Btn>}
                      {c.aiAnalysis&&!c.pdfGenerated&&jsPdfReady&&<Btn small variant="teal" onClick={()=>onGenPDF(c)}>PDF</Btn>}
                      {c.pdfGenerated&&!c.cmsPushed&&<Btn small variant="ghost" onClick={()=>onPushCMS(c.id)}>CMS</Btn>}
                      <Btn small variant="ghost" onClick={()=>onSelect(c.id)}>Review</Btn>
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// CLAIM DRAWER (Admin)
// ═══════════════════════════════════════════════════════════
function ClaimDrawer({claim,onClose,onDecision,onAnalyze,onGenPDF,onPushCMS,aiLoading,jsPdfReady,onGenDWC1}){
  const [note,setNote]=useState(claim.adminDecision?.note||"");
  const a=claim.aiAnalysis;
  const decided=["approved","denied","modified"].includes(claim.status);
  const res=a?a.suggestedMedicalReserve+a.suggestedIndemnityReserve+a.suggestedExpenseReserve:null;

  return(
    <>
      <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(2,8,18,.75)",zIndex:200,backdropFilter:"blur(3px)"}}/>
      <div style={{position:"fixed",top:0,right:0,bottom:0,width:600,background:C.surface,borderLeft:`1px solid ${C.border}`,zIndex:201,overflowY:"auto",animation:"slideR .22s ease"}}>
        <div style={{padding:"18px 26px",borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,background:C.surface,zIndex:1,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontFamily:C.mono,color:C.amber,fontSize:12,fontWeight:600,marginBottom:4}}>{claim.id}</div>
            <div style={{fontSize:19,fontWeight:700}}>{claim.claimant}</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>{claim.employer} · {claim.filedAt}</div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",paddingTop:4}}>
            <Badge status={claim.status}/>
            <button onClick={onClose} style={{background:C.card,border:`1px solid ${C.border}`,color:C.dim,cursor:"pointer",width:28,height:28,borderRadius:6,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
          </div>
        </div>
        <div style={{padding:"22px 26px"}}>
          <SectionHead title="Claim Facts"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 22px",marginBottom:12}}>
            <InfoPair label="DOI" value={claim.dateOfInjury} mono/>
            <InfoPair label="DOB" value={claim.claimantDOB} mono/>
            <InfoPair label="Body Part" value={claim.bodyPart}/>
            <InfoPair label="Injury Type" value={claim.injuryType}/>
            <InfoPair label="Off Work" value={claim.timeOff?"Yes":"No"} accent={claim.timeOff?C.amber:C.green}/>
            {claim.aww&&<InfoPair label="AWW / TD Rate" value={`${fmt$(claim.aww)} / ${fmt$(claim.tdRate)}/wk`} mono accent={C.cyan}/>}
            {claim.homeAddr&&<InfoPair label="Home Address" value={claim.homeAddr}/>}
          </div>
          <InfoPair label="Mechanism" value={claim.mechanism}/>
          {claim.voiceTranscript&&<div style={{background:C.roseF,border:`1px solid ${C.rose}22`,borderRadius:8,padding:"10px 13px",marginBottom:10}}><div style={{fontSize:10,fontFamily:C.mono,color:C.rose,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.06em"}}>🎙 Voice Transcript</div><div style={{fontSize:12,color:C.dim,lineHeight:1.7}}>{claim.voiceTranscript}</div></div>}
          {claim.media?.length>0&&<div style={{marginBottom:14}}><Lbl color={C.blue}>Attached Media ({claim.media.length})</Lbl><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{claim.media.map((f,i)=><div key={i} style={{width:60,height:60,borderRadius:6,overflow:"hidden",border:`1px solid ${C.border}`,background:C.bg}}>{f.type?.startsWith("image/")?<img src={f.preview} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🎬</div>}</div>)}</div></div>}
          {claim.appointment?.confirmed&&(
            <div style={{background:C.tealF,border:`1px solid ${C.teal}33`,borderRadius:9,padding:"12px 15px",marginBottom:16}}>
              <Lbl color={C.teal} mb={6}>Appointment Confirmed</Lbl>
              <div style={{fontSize:13,fontWeight:600}}>{claim.appointment.facility}</div>
              <div style={{fontSize:12,color:C.dim,marginTop:3}}>{claim.appointment.date} at {claim.appointment.time}</div>
              <div style={{fontFamily:C.mono,fontSize:11,color:C.amber,marginTop:4}}>Auth: {claim.appointment.authCode}</div>
            </div>
          )}
          {a?(
            <>
              <div style={{height:1,background:C.border,margin:"18px 0"}}/>
              <SectionHead title="AI Analysis"/>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
                {[["Compensability",a.compensability.replace("Likely ",""),COMP_COLOR[a.compensability]],["Confidence",`${a.compensabilityScore}%`,a.compensabilityScore>=80?C.green:C.amber],["Priority",a.priority,PRI_COLOR[a.priority]]].map(([l,v,c])=>(
                  <div key={l} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"11px 14px"}}>
                    <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:6}}>{l}</div>
                    <div style={{fontSize:13,fontWeight:700,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:9,padding:"14px 18px",marginBottom:14}}>
                <Lbl>Suggested Reserves</Lbl>
                <div style={{display:"flex",gap:0}}>
                  {[["Medical",a.suggestedMedicalReserve],["Indemnity",a.suggestedIndemnityReserve],["Expense",a.suggestedExpenseReserve]].map(([l,v],i,arr)=>(
                    <div key={l} style={{flex:1,borderRight:i<arr.length-1?`1px solid ${C.border}`:"none",paddingRight:i<arr.length-1?16:0,marginRight:i<arr.length-1?16:0}}>
                      <div style={{fontSize:11,color:C.muted,marginBottom:4}}>{l}</div>
                      <div style={{fontFamily:C.mono,fontSize:16,fontWeight:600}}>{fmt$(v)}</div>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between"}}>
                  <span style={{fontSize:11,color:C.muted}}>Total</span>
                  <span style={{fontFamily:C.mono,fontWeight:700,color:C.cyan,fontSize:17}}>{fmt$(res)}</span>
                </div>
              </div>
              {a.redFlags?.length>0&&<div style={{marginBottom:14}}><Lbl color={C.red}>⚠ Red Flags</Lbl>{a.redFlags.map((f,i)=><div key={i} style={{background:C.redF,border:`1px solid ${C.red}22`,borderRadius:6,padding:"8px 12px",marginBottom:6,fontSize:12,color:"#f87171"}}>{f}</div>)}</div>}
              <div style={{marginBottom:14}}><Lbl color={C.blue}>Recommended Actions</Lbl>{a.nextActions?.map((act,i)=><div key={i} style={{display:"flex",gap:9,marginBottom:8,alignItems:"flex-start"}}><div style={{width:19,height:19,borderRadius:"50%",background:C.blueF,border:`1px solid ${C.blue}33`,color:C.blue,fontSize:10,fontFamily:C.mono,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{i+1}</div><div style={{fontSize:12,color:C.dim,lineHeight:1.65}}>{act}</div></div>)}</div>
              <div style={{background:C.blueF,border:`1px solid ${C.blue}22`,borderRadius:9,padding:"12px 15px",marginBottom:18}}><Lbl color={C.blue}>AI Analysis Notes</Lbl><div style={{fontSize:12,color:C.dim,lineHeight:1.75}}>{a.analysisNotes}</div></div>
              {/* Action buttons */}
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
                {!claim.pdfGenerated&&jsPdfReady&&<Btn small variant="teal" onClick={()=>onGenPDF(claim)}>📄 AI Reasoning PDF</Btn>}
                {jsPdfReady&&<Btn small variant="ghost" onClick={()=>onGenDWC1(claim)}>📋 DWC-1 Form</Btn>}
                {claim.pdfGenerated&&!claim.cmsPushed&&<Btn small variant="purple" onClick={()=>onPushCMS(claim.id)}>⬆ Push to FileHandler</Btn>}
                {claim.pdfGenerated&&<span style={{fontSize:11,color:C.teal,display:"flex",alignItems:"center"}}>✓ PDF ready</span>}
                {claim.cmsPushed&&<span style={{fontSize:11,color:C.purple,display:"flex",alignItems:"center"}}>✓ In FileHandler</span>}
              </div>
              {!decided?(
                <div style={{borderTop:`1px solid ${C.border}`,paddingTop:18}}>
                  <Lbl>Supervisor Note</Lbl>
                  <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} placeholder="Optional note before deciding…" style={{marginBottom:12,resize:"vertical"}}/>
                  <div style={{display:"flex",gap:8}}>
                    <Btn onClick={()=>onDecision(claim.id,"approved",note)}>✓ Approve</Btn>
                    <Btn variant="ghost" onClick={()=>onDecision(claim.id,"modified",note)}>✎ Approve w/ Mods</Btn>
                    <Btn variant="danger" onClick={()=>onDecision(claim.id,"denied",note)}>✕ Deny</Btn>
                  </div>
                </div>
              ):(
                <div style={{background:C.greenF,border:`1px solid ${C.green}33`,borderRadius:9,padding:"13px 16px"}}><Lbl color={C.green}>Decision Recorded</Lbl><div style={{fontSize:12,color:C.dim}}>{claim.adminDecision?.action?.toUpperCase()} — {claim.adminDecision?.at}</div>{claim.adminDecision?.note&&<div style={{fontSize:12,color:C.muted,marginTop:4,fontStyle:"italic"}}>{claim.adminDecision.note}</div>}</div>
              )}
            </>
          ):(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"28px 22px",textAlign:"center",marginTop:16}}>
              <div style={{fontSize:22,marginBottom:10}}>🤖</div>
              <div style={{fontSize:13,fontWeight:600,marginBottom:12}}>No AI analysis yet</div>
              <Btn onClick={()=>onAnalyze(claim)} disabled={aiLoading}>{aiLoading?<span style={{display:"flex",alignItems:"center",gap:8}}><Spinner/>Analyzing…</span>:"Run AI Analysis"}</Btn>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// EMPLOYER PORTAL
// ═══════════════════════════════════════════════════════════
function EmployerPortal({claims,onSubmit,onSelect}){
  const [view,setView]=useState("new");
  const [linkEmail,setLinkEmail]=useState("");
  const [linkName,setLinkName]=useState("");
  const [genLink,setGenLink]=useState(null);
  const myClaims=claims.filter(c=>c.employer==="BrightCare Home Health");

  const makeLink=()=>{if(!linkEmail||!linkName) return;const t=btoa(`${linkName}:${linkEmail}:${Date.now()}`).slice(0,22);setGenLink(`https://homecare-tpa.com/claim?t=${t}&e=BrightCare`);};

  return(
    <div style={{paddingTop:32,maxWidth:860,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:22}}><h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Employer Portal</h1><p style={{color:C.muted,fontSize:13}}>BrightCare Home Health</p></div>
      <Tabs tabs={[{key:"new",label:"Report Injury"},{key:"link",label:"Send Employee Link"},{key:"list",label:`Claims (${myClaims.length})`}]} active={view} onChange={setView}/>
      {view==="new"&&(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:28}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:18}}>File First Report of Injury (FROI)</div>
          <EmployeeIntakeWizard onComplete={d=>onSubmit({...d,employer:"BrightCare Home Health"},"employer")}/>
        </div>
      )}
      {view==="link"&&(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:28}}>
          <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>Send Employee Claim Link</div>
          <div style={{fontSize:12,color:C.muted,marginBottom:20}}>Employee receives a secure magic link. Their ADP data auto-populates — they only describe their injury. Expires in 72 hours.</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 20px"}}>
            <Field label="Employee Name"><input value={linkName} onChange={e=>setLinkName(e.target.value)} placeholder="Employee full name"/></Field>
            <Field label="Employee Email"><input value={linkEmail} onChange={e=>setLinkEmail(e.target.value)} placeholder="employee@email.com"/></Field>
          </div>
          <Btn onClick={makeLink} disabled={!linkEmail||!linkName}>Generate Claim Link →</Btn>
          {genLink&&(
            <div style={{marginTop:18,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:18,animation:"fadeUp .2s ease"}}>
              <Lbl color={C.green}>✓ Link Generated for {linkName}</Lbl>
              <div style={{fontFamily:C.mono,fontSize:11,color:C.cyan,background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:"10px 13px",wordBreak:"break-all",marginBottom:12}}>{genLink}</div>
              <div style={{display:"flex",gap:8}}>
                <Btn small onClick={()=>navigator.clipboard?.writeText(genLink)}>Copy Link</Btn>
                <Btn small variant="ghost">Send Email to {linkEmail}</Btn>
              </div>
              <div style={{marginTop:12,fontSize:11,color:C.muted,lineHeight:1.7}}>When opened: ADP demographics auto-fill · Employee completes injury description · Voice notes and photos supported · DWC-1 auto-generated on submit</div>
            </div>
          )}
        </div>
      )}
      {view==="list"&&(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
          {myClaims.length===0?<div style={{padding:36,textAlign:"center",color:C.muted}}>No claims on file.</div>:(
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>{["Claim ID","Employee","DOI","Body Part","AWW","Appt","Status",""].map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>)}</tr></thead>
              <tbody>{myClaims.map((c,i)=>(
                <tr key={c.id} className="rh" style={{borderBottom:i<myClaims.length-1?`1px solid ${C.border}`:"none"}}>
                  <td style={{padding:"12px 14px",fontFamily:C.mono,fontSize:12,color:C.amber,fontWeight:600}}>{c.id}</td>
                  <td style={{padding:"12px 14px",fontSize:13,fontWeight:500}}>{c.claimant}</td>
                  <td style={{padding:"12px 14px",fontSize:12,fontFamily:C.mono,color:C.dim}}>{c.dateOfInjury}</td>
                  <td style={{padding:"12px 14px",fontSize:12,color:C.dim}}>{c.bodyPart}</td>
                  <td style={{padding:"12px 14px",fontFamily:C.mono,fontSize:12,color:C.cyan}}>{c.aww?fmt$(c.aww):"—"}</td>
                  <td style={{padding:"12px 14px"}}>{c.appointment?.confirmed?<span style={{fontSize:10,background:C.tealF,color:C.teal,padding:"2px 7px",borderRadius:4,fontFamily:C.mono,border:`1px solid ${C.teal}33`}}>✓ {c.appointment.date}</span>:<span style={{color:C.muted,fontSize:11}}>—</span>}</td>
                  <td style={{padding:"12px 14px"}}><Badge status={c.status}/></td>
                  <td style={{padding:"12px 14px"}}><Btn small variant="ghost" onClick={()=>onSelect(c.id)}>View</Btn></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TOP NAV
// ═══════════════════════════════════════════════════════════
function TopNav({role,setRole,claims,adminView,setAdminView}){
  const att=claims.filter(c=>["pending","ai_complete"].includes(c.status)).length;
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
            {[{key:"claims",label:"Claims"},{key:"notices",label:"Notices"}].map(({key,label})=>(
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
  const [claims,setClaims]=useState(INIT_CLAIMS);
  const [selectedId,setSelectedId]=useState(null);
  const [aiLoading,setAiLoading]=useState(null);
  const [toast,setToast]=useState(null);
  const [cmsModal,setCmsModal]=useState(null);
  const [jsPdfReady,setJsPdfReady]=useState(false);

  const selected=claims.find(c=>c.id===selectedId);
  const notify=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),3800);};

  useEffect(()=>{
    if(window.jspdf){setJsPdfReady(true);return;}
    const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload=()=>setJsPdfReady(true);
    s.onerror=()=>console.warn("jsPDF failed to load");
    document.head.appendChild(s);
  },[]);

  const analyzeWithAI=async(claim)=>{
    setAiLoading(claim.id);
    try{const a=await runAIAnalysis(claim);setClaims(p=>p.map(c=>c.id===claim.id?{...c,aiAnalysis:a,status:"ai_complete"}:c));notify(`AI analysis complete for ${claim.id}`);}
    catch(e){notify(`AI failed: ${e.message}`,"error");}
    finally{setAiLoading(null);}
  };

  const makeDecision=(id,action,note="")=>{
    setClaims(p=>p.map(c=>c.id===id?{...c,status:action,adminDecision:{action,note,at:new Date().toLocaleString()}}:c));
    setSelectedId(null);notify(`${id} marked: ${action}`);
  };

  const genPDF=(claim)=>{
    if(!jsPdfReady||!window.jspdf){notify("PDF library loading…","error");return;}
    try{const doc=generateReasoningPDF(claim);doc.save(`AI-Reasoning-${claim.id}.pdf`);setClaims(p=>p.map(c=>c.id===claim.id?{...c,pdfGenerated:true}:c));notify(`AI Reasoning PDF downloaded`);}
    catch(e){notify(`PDF failed: ${e.message}`,"error");}
  };

  const genDWC1=(claim)=>{
    if(!jsPdfReady||!window.jspdf){notify("PDF library loading…","error");return;}
    try{const doc=generateDWC1(claim);doc.save(`DWC1-${claim.id}.pdf`);notify(`DWC-1 downloaded — send to ${claim.claimant} for signature`);}
    catch(e){notify(`DWC-1 failed: ${e.message}`,"error");}
  };

  const pushCMS=(id)=>{
    const c=claims.find(x=>x.id===id);
    if(!c?.pdfGenerated){notify("Generate PDF before pushing to CMS","error");return;}
    setClaims(p=>p.map(c=>c.id===id?{...c,cmsPushed:true}:c));
    notify(`${id} pushed to FileHandler CMS — reserves set, PDF attached`);
    setSelectedId(null);
  };

  const submitClaim=(data,source)=>{
    const id=`HHW-2026-${String(claims.length+42).padStart(3,"0")}`;
    const claim={id,...data,status:"pending",aiAnalysis:null,adminDecision:null,pdfGenerated:false,cmsPushed:false,noticeLog:[],filedAt:new Date().toLocaleString(),filedBy:source};
    setClaims(p=>[claim,...p]);
    return id;
  };

  return(
    <div style={{fontFamily:C.sans,background:C.bg,minHeight:"100vh",color:C.text}}>
      <style>{FONTS+CSS}</style>
      {toast&&<Toast {...toast}/>}
      <TopNav role={role} setRole={setRole} claims={claims} adminView={adminView} setAdminView={setAdminView}/>
      <div style={{maxWidth:1400,margin:"0 auto",padding:"0 26px 80px"}}>
        {role==="admin"&&adminView==="claims"&&<AdminDashboard claims={claims} onSelect={setSelectedId} onAnalyze={analyzeWithAI} aiLoading={aiLoading} onGenPDF={genPDF} onPushCMS={pushCMS} jsPdfReady={jsPdfReady}/>}
        {role==="admin"&&adminView==="notices"&&<NoticeCenter claims={claims} jsPdfReady={jsPdfReady} notify={notify}/>}
        {role==="employer"&&<EmployerPortal claims={claims} onSubmit={submitClaim} onSelect={setSelectedId}/>}
        {role==="employee"&&(
          <div style={{paddingTop:32,maxWidth:660,animation:"fadeUp .3s ease"}}>
            <div style={{marginBottom:24}}><h1 style={{fontSize:22,fontWeight:700,marginBottom:4}}>Employee Portal</h1><p style={{color:C.muted,fontSize:13}}>Report a work injury — voice, photos, and appointment booking included</p></div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:28}}>
              <EmployeeIntakeWizard onComplete={d=>submitClaim(d,"employee")}/>
            </div>
          </div>
        )}
      </div>
      {selected&&<ClaimDrawer claim={selected} onClose={()=>setSelectedId(null)} onDecision={makeDecision} onAnalyze={analyzeWithAI} onGenPDF={genPDF} onPushCMS={pushCMS} onGenDWC1={genDWC1} aiLoading={aiLoading===selected.id} jsPdfReady={jsPdfReady}/>}
    </div>
  );
}
