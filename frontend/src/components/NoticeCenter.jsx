import { useState } from 'react';
import AdminDashboard from '../components/AdminDashboard.jsx';
import { NOTICE_TYPES } from '../mockData.js';
import { generateNoticePDF } from '../noticePdf.js';
import { C } from '../theme.js';
import { Btn, Field, SectionHead } from '../ui/primitives.jsx';

export function NoticeCenter({claims,jsPdfReady,notify}){
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
              <div>{`"from": { "name": "ClaimLayer", ... }`}</div>
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

// ACTION QUEUE + ADMIN DASHBOARD moved to src/components/AdminDashboard.jsx

// ═══════════════════════════════════════════════════════════
// TD PERIOD UI — Benefits tab building blocks
// ═══════════════════════════════════════════════════════════
