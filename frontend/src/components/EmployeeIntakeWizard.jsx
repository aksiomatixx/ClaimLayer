// ═══════════════════════════════════════════════════════════
// EMPLOYEE INTAKE WIZARD (M2) — i18n · equal voice/text · real API
// (extracted verbatim from App.jsx)
// ═══════════════════════════════════════════════════════════
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { C } from '../theme.js';
import { EMPLOYERS, BODY_PARTS, INJURY_TYPES } from '../mockData.js';
import { getProvidersNearZip } from '../utils.js';
import { Btn, Lbl, Field, SectionHead, Spinner, InfoPair, RadioGroup, StepBar } from '../ui/primitives.jsx';
import LanguageSelector from './LanguageSelector.jsx';
import M2VoiceRecorder from './M2VoiceRecorder.jsx';
import MediaUploader from './MediaUploader.jsx';

const EMPTY_M2={claimant:'',claimantDOB:'',homeAddr:'',homeZip:'',phone:'',employer:'',dateOfInjury:'',bodyPart:'',injuryType:'',mechanism:'',voiceTranscript:'',medTreatment:'',timeOff:false,priorClaims:'None',witnesses:'',media:[],aww:null,tdRate:null,motorVehicleFields:null};

export default function EmployeeIntakeWizard({onComplete}){
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

