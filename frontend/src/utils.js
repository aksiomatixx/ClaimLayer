// ═══════════════════════════════════════════════════════════
// UTILITIES (extracted verbatim from App.jsx)
// ═══════════════════════════════════════════════════════════
import { MPN_PROVIDERS } from './mockData.js';

export const fmt$=(n)=>n!=null?`$${Number(n).toLocaleString()}`:"—";

export function getProvidersNearZip(zip){
  if(!zip) return MPN_PROVIDERS.slice(0,3);
  const pre=zip.replace(/\D/g,"").slice(0,3);
  const match=MPN_PROVIDERS.filter(p=>p.zips.includes(pre));
  const rest=MPN_PROVIDERS.filter(p=>!match.includes(p));
  return [...match,...rest].slice(0,3).map(p=>({...p,distance:(Math.random()*6+0.4).toFixed(1)}));
}
export function getSlots(offset){
  const all=["8:00 AM","8:30 AM","9:00 AM","9:30 AM","10:00 AM","10:30 AM","11:00 AM","11:30 AM","1:00 PM","1:30 PM","2:00 PM","2:30 PM","3:00 PM","3:30 PM","4:00 PM"];
  return all.filter((_,i)=>(i+offset*3)%4!==0);
}
export function dayLabel(off){
  if(off===0) return "Today";
  if(off===1) return "Tomorrow";
  const d=new Date(); d.setDate(d.getDate()+off);
  return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
}
