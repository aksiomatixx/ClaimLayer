// ═══════════════════════════════════════════════════════════
// M2 VOICE RECORDER — MediaRecorder → Whisper API
// (extracted verbatim from App.jsx)
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { C } from '../theme.js';
import { Btn, Lbl, Spinner } from '../ui/primitives.jsx';

export default function M2VoiceRecorder({onResult,language='en',claimId}){
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

