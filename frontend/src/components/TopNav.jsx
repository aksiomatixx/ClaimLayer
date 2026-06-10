import { C } from '../theme.js';
import { SYNC_STATUS_COLOR, SyncBadge } from '../ui/primitives.jsx';

export function TopNav({role,setRole,claims,adminView,setAdminView}){
  const today=new Date().toISOString().split('T')[0];
  const att=claims.filter(c=>["new_claim","intake_complete","under_investigation"].includes(c.status)||(c.diaries||[]).some(d=>d.status==='open'&&d.dueDate<today)).length;
  return(
    <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:22,height:60,padding:"0 26px",position:"sticky",top:0,zIndex:100}}>
      <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        <div style={{width:32,height:32,background:`linear-gradient(135deg,${C.amber},${C.amberD})`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 2px 10px ${C.amber}44`}}><span style={{fontFamily:C.mono,fontWeight:700,fontSize:11,color:"#000"}}>CL</span></div>
        <div><div style={{fontFamily:C.mono,fontWeight:600,fontSize:13,color:C.text}}>ClaimLayer</div><div style={{fontSize:9,color:C.muted}}>Workers' Compensation · v3</div></div>
      </div>
      <div style={{display:"flex",background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:3,gap:2,margin:"0 auto"}}>
        {[{key:"admin",label:"⚡ Admin"},{key:"employer",label:"🏢 Employer"},{key:"employee",label:"👤 Employee"}].map(({key,label})=>(
          <button key={key} onClick={()=>setRole(key)} style={{background:role===key?C.amber:"transparent",color:role===key?"#000":C.dim,border:"none",padding:"6px 16px",borderRadius:6,fontSize:12,fontWeight:700,fontFamily:C.sans,cursor:"pointer",transition:"all .18s"}}>{label}</button>
        ))}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        {role==="admin"&&(
          <div style={{display:"flex",background:C.bg,border:`1px solid ${C.border}`,borderRadius:7,padding:2,gap:2}}>
            {[{key:"claims",label:"Claims"},{key:"rfas",label:"RFAs"},{key:"notices",label:"Notices"},{key:"agents",label:"Agents"},{key:"integrations",label:"Integrations"},{key:"reports",label:"Reports"},{key:"architecture",label:"Architecture"}].map(({key,label})=>(
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
// INTEGRATIONS CONSOLE — legacy claims adapter layer
// (M_legacy_integration). The product story is: ClaimLayer
// runs agentic workflows on top of a customer's retained
// claims system-of-record via a pluggable adapter interface,
// rather than rip-and-replacing it.
// ═══════════════════════════════════════════════════════════
// SyncBadge + SYNC_STATUS_COLOR moved to src/ui/primitives.jsx
