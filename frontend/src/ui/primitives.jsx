// ═══════════════════════════════════════════════════════════
// SHARED UI PRIMITIVES (extracted verbatim from App.jsx)
// ═══════════════════════════════════════════════════════════
import { C, STATUS_CFG } from '../theme.js';

export function Badge({status}){const c=STATUS_CFG[status]||STATUS_CFG.pending;return <span style={{display:"inline-block",background:c.bg,color:c.color,border:`1px solid ${c.bd}`,padding:"3px 10px",borderRadius:4,fontSize:10,fontFamily:C.mono,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase",whiteSpace:"nowrap"}}>{c.label}</span>;}
export function Btn({children,onClick,variant="primary",disabled,small,full,icon}){
  const V={primary:{bg:C.amber,color:"#000",bd:"none"},danger:{bg:C.red,color:"#fff",bd:"none"},success:{bg:C.green,color:"#000",bd:"none"},ghost:{bg:"transparent",color:C.dim,bd:`1px solid ${C.border}`},outline:{bg:"transparent",color:C.amber,bd:`1px solid ${C.amber}44`},teal:{bg:C.teal,color:"#000",bd:"none"},rose:{bg:C.rose,color:"#000",bd:"none"},purple:{bg:C.purple,color:"#000",bd:"none"}};
  const s=V[variant]||V.primary;
  return <button onClick={onClick} disabled={disabled} style={{background:disabled?"#182b42":s.bg,color:disabled?C.muted:s.color,border:s.bd,padding:small?"6px 14px":"10px 22px",borderRadius:7,fontSize:small?11:13,fontWeight:700,fontFamily:C.sans,cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.5:1,whiteSpace:"nowrap",width:full?"100%":"auto",display:"inline-flex",alignItems:"center",gap:6}}>{icon&&<span>{icon}</span>}{children}</button>;
}
export function Lbl({children,color,mb=7}){return <div style={{fontSize:10,fontFamily:C.mono,color:color||C.muted,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:mb}}>{children}</div>;}
export function Field({label,children}){return <div style={{marginBottom:16}}><Lbl>{label}</Lbl>{children}</div>;}
export function SectionHead({title,color}){return <div style={{fontSize:10,fontFamily:C.mono,color:color||C.muted,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:14,paddingBottom:10,borderBottom:`1px solid ${C.border}`}}>{title}</div>;}
export function StatCard({label,value,sub,accent,delay=0}){return <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"18px 22px",flex:1,animation:`fadeUp 0.35s ease ${delay}s both`}}><div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12}}>{label}</div><div style={{fontSize:26,fontFamily:C.mono,fontWeight:600,color:accent||C.text,lineHeight:1}}>{value}</div>{sub&&<div style={{fontSize:11,color:C.muted,marginTop:6}}>{sub}</div>}</div>;}
export function Spinner(){return <div className="spin" style={{width:13,height:13,border:`2px solid ${C.amber}33`,borderTopColor:C.amber,borderRadius:"50%",flexShrink:0}}/>;}
export function Toast({msg,type}){const c=type==="error"?C.red:C.green;return <div style={{position:"fixed",top:70,right:22,zIndex:9999,background:type==="error"?C.redF:C.greenF,border:`1px solid ${c}44`,color:c,padding:"11px 18px",borderRadius:8,fontSize:12,fontFamily:C.mono,maxWidth:420,animation:"fadeUp 0.2s ease"}}>{msg}</div>;}
export function Tabs({tabs,active,onChange}){return <div style={{display:"flex",borderBottom:`1px solid ${C.border}`,marginBottom:22}}>{tabs.map(t=><button key={t.key} onClick={()=>onChange(t.key)} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,fontWeight:600,color:active===t.key?C.text:C.muted,padding:"9px 20px",fontFamily:C.sans,borderBottom:`2px solid ${active===t.key?C.amber:"transparent"}`,transition:"all .15s",marginBottom:-1}}>{t.label}</button>)}</div>;}
export function InfoPair({label,value,mono,accent}){return <div style={{marginBottom:9}}><div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:3}}>{label}</div><div style={{fontSize:13,fontFamily:mono?C.mono:C.sans,color:accent||C.text,lineHeight:1.6}}>{value||"—"}</div></div>;}
export function RadioGroup({value,onChange,options,name}){return <div style={{display:"flex",gap:18,paddingTop:8}}>{options.map(([lbl,val])=><label key={lbl} style={{display:"flex",alignItems:"center",gap:7,fontSize:13,cursor:"pointer",color:C.dim}}><input type="radio" name={name} checked={value===val} onChange={()=>onChange(val)}/>{lbl}</label>)}</div>;}
export function StepBar({step,total}){
  return <div style={{display:"flex",gap:6,marginBottom:28}}>
    {Array.from({length:total},(_,i)=>{
      const bg = i<step ? C.amber : i===step ? C.amber+"88" : C.border;
      return <div key={i} style={{flex:1,height:3,borderRadius:2,background:bg,transition:"background .3s"}}/>;
    })}
  </div>;
}

export const SYNC_STATUS_COLOR = {
  native:       C.dim,
  migrated:     C.blue,
  synced:       C.green,
  sync_pending: C.amber,
  sync_failed:  C.red,
};

export function SyncBadge({ source_system, sync_status, small }) {
  if (!source_system || source_system === 'native') return null;
  const color = SYNC_STATUS_COLOR[sync_status] || C.blue;
  return (
    <span style={{
      display:"inline-flex",alignItems:"center",gap:5,
      background:`${color}1f`,color,border:`1px solid ${color}55`,
      padding: small ? "1px 7px" : "2px 9px",borderRadius:10,
      fontSize: small ? 9 : 10, fontFamily:C.mono,fontWeight:600,
      letterSpacing:"0.04em",textTransform:"uppercase",
    }}>
      <span style={{
        width:5,height:5,borderRadius:"50%",background:color,
      }}/>
      Migrated · {source_system}
    </span>
  );
}

