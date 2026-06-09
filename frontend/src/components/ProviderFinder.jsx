// ═══════════════════════════════════════════════════════════
// MEDICAL PROVIDER FINDER — extracted verbatim from App.jsx
// ═══════════════════════════════════════════════════════════
import { useState } from 'react';
import { C } from '../theme.js';
import { Btn } from '../ui/primitives.jsx';
import { getProvidersNearZip, getSlots, dayLabel } from '../utils.js';

export default function ProviderFinder({zip,injuryType,onBook}){
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

