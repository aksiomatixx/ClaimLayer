// ═══════════════════════════════════════════════════════════
// LANGUAGE SELECTOR (M2) — extracted verbatim from App.jsx
// ═══════════════════════════════════════════════════════════
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { C } from '../theme.js';

export default function LanguageSelector(){
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

