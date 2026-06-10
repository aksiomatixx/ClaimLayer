import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { C } from '../theme.js';

export function DemoBanner({claims, notify}){
  const qc = useQueryClient();
  const demoClaims = (claims||[]).filter(c => c?.metadata?.demo === true);
  const [resetting, setResetting] = useState(false);
  if(demoClaims.length === 0) return null;

  const onReset = async () => {
    if(!confirm('Reset all demo data? Real claims are not affected.')) return;
    setResetting(true);
    try {
      const res = await fetch('/api/v1/admin/demo-reset', { method: 'POST', credentials: 'include' });
      if(!res.ok){
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      qc.invalidateQueries({queryKey:['claims']});
      notify(`Demo reset — ${data.count} claims re-seeded`);
    } catch(e){
      notify(`Demo reset failed: ${e.message}`, 'error');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div style={{background:C.amberF,borderBottom:`1px solid ${C.amber}55`,padding:"6px 26px",display:"flex",justifyContent:"center",alignItems:"center",gap:14,fontSize:11,fontFamily:C.mono,color:C.amber,letterSpacing:"0.04em"}}>
      <span>⚡ DEMO DATA LOADED — {demoClaims.length} sample claims (metadata.demo = true)</span>
      <button onClick={onReset} disabled={resetting}
        style={{background:"transparent",border:`1px solid ${C.amber}66`,color:C.amber,padding:"3px 12px",borderRadius:5,fontSize:10,fontFamily:C.mono,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase",cursor:resetting?"wait":"pointer",opacity:resetting?0.5:1}}>
        {resetting?'Resetting…':'Reset Demo'}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════
