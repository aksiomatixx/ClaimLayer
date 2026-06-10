import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchIntegrationSystems, fetchLegacyRecord, fetchMigratedClaims, migrateFromLegacy } from '../services/integrations.js';
import { C } from '../theme.js';
import { Btn, Field, Spinner, SyncBadge } from '../ui/primitives.jsx';

export function IntegrationsConsole({ notify }) {
  const qc = useQueryClient();
  const { data: sys, isLoading } = useQuery({
    queryKey: ['integrations-systems'],
    queryFn:  fetchIntegrationSystems,
    refetchInterval: 30_000,
  });
  const { data: migrated } = useQuery({
    queryKey: ['integrations-migrated'],
    queryFn:  fetchMigratedClaims,
    refetchInterval: 30_000,
  });
  const [legacyRecord, setLegacyRecord] = useState(null);
  const [migrating,    setMigrating]    = useState(false);

  const runMigrate = async (system) => {
    setMigrating(true);
    try {
      const r = await migrateFromLegacy(system);
      notify(`Migrated ${r.migrated} claim${r.migrated === 1 ? '' : 's'} from ${system}` +
             (r.skipped ? ` (${r.skipped} already migrated)` : ''), 'success');
      qc.invalidateQueries({ queryKey: ['claims'] });
      qc.invalidateQueries({ queryKey: ['integrations-systems'] });
      qc.invalidateQueries({ queryKey: ['integrations-migrated'] });
    } catch (e) {
      notify(`Migration failed: ${e.message}`, 'error');
    } finally { setMigrating(false); }
  };

  const viewLegacy = async (system, externalId) => {
    try {
      const r = await fetchLegacyRecord(system, externalId);
      setLegacyRecord(r);
    } catch (e) { notify(`Fetch legacy record failed: ${e.message}`, 'error'); }
  };

  return (
    <div style={{paddingTop:32,animation:"fadeUp .3s ease"}}>
      <div style={{marginBottom:22}}>
        <h1 style={{fontSize:22,fontWeight:700,color:C.text,marginBottom:4}}>Integrations Console</h1>
        <p style={{color:C.muted,fontSize:13,maxWidth:760,lineHeight:1.6}}>
          ClaimLayer runs agentic workflows on top of a customer's existing claims
          system-of-record. Each connected legacy system is a pluggable adapter — ingest claims
          from it, push diaries / documents / status updates back to it.
        </p>
      </div>

      {isLoading
        ? <Spinner/>
        : (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:24}}>
            {(sys?.systems || []).map(s => (
              <SystemCard key={s.system} system={s} migrating={migrating} onMigrate={() => runMigrate(s.system)}/>
            ))}
          </div>
        )}

      <MigratedClaimsTable
        rows={migrated?.claims || []}
        onView={(c) => viewLegacy(c.source_system, c.external_claim_id)}
      />

      {legacyRecord && <LegacyRecordModal data={legacyRecord} onClose={()=>setLegacyRecord(null)}/>}
    </div>
  );
}

export function SystemCard({ system, migrating, onMigrate }) {
  const health = system.health || {};
  const ok = !!health.ok;
  const color = ok ? C.green : C.red;
  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"22px 24px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
        <div>
          <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:3}}>{system.label}</div>
          <div style={{fontFamily:C.mono,fontSize:10,color:C.muted}}>{system.system} · {system.direction}</div>
        </div>
        <span style={{
          display:"inline-flex",alignItems:"center",gap:6,
          background:`${color}1f`,color,border:`1px solid ${color}55`,
          padding:"3px 10px",borderRadius:12,fontSize:10,fontFamily:C.mono,fontWeight:600,
        }}>
          <span style={{width:6,height:6,borderRadius:"50%",background:color}}/>
          {ok ? 'healthy' : 'unhealthy'}
        </span>
      </div>
      <div style={{fontSize:12,color:C.dim,marginBottom:14,lineHeight:1.6}}>{system.description}</div>
      <div style={{display:"flex",gap:14,marginBottom:14,fontSize:11,fontFamily:C.mono}}>
        <span style={{color:C.muted}}>Role: <span style={{color:C.text}}>{system.role}</span></span>
        <span style={{color:C.muted}}>Claims: <span style={{color:C.amber}}>{system.claim_count ?? 0}</span></span>
      </div>
      {health.detail && (
        <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,marginBottom:14,wordBreak:"break-all"}}>
          {health.detail}
        </div>
      )}
      {system.system === 'mock_legacy' && (
        <Btn small onClick={onMigrate} disabled={migrating}>
          {migrating ? 'Migrating…' : 'Migrate Claims from Mock Legacy'}
        </Btn>
      )}
    </div>
  );
}

export function MigratedClaimsTable({ rows, onView }) {
  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",marginBottom:24}}>
      <div style={{padding:"14px 22px",borderBottom:`1px solid ${C.border}`,fontFamily:C.mono,fontSize:12,fontWeight:600,color:C.text}}>
        MIGRATED CLAIMS — {rows.length}
      </div>
      {rows.length === 0
        ? <div style={{padding:"32px 22px",fontSize:12,color:C.muted}}>No migrated claims yet. Click "Migrate Claims from Mock Legacy" above to bring legacy claims into ClaimLayer.</div>
        : (
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
              {["External ID","System","Sync Status","Last Synced","Claimant","DOI","Body Part","Actions"].map(h =>
                <th key={h} style={{padding:"9px 13px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
              )}
            </tr></thead>
            <tbody>{rows.map((c, i) => {
              const ee = c.employee || {};
              return (
                <tr key={c.id} style={{borderBottom: i < rows.length - 1 ? `1px solid ${C.border}` : 'none'}}>
                  <td style={{padding:"11px 13px",fontFamily:C.mono,fontSize:12,color:C.amber}}>{c.external_claim_id}</td>
                  <td style={{padding:"11px 13px",fontFamily:C.mono,fontSize:11,color:C.dim}}>{c.source_system}</td>
                  <td style={{padding:"11px 13px"}}><SyncBadge source_system={c.source_system} sync_status={c.sync_status}/></td>
                  <td style={{padding:"11px 13px",fontFamily:C.mono,fontSize:10,color:C.muted}}>{c.last_synced_at ? c.last_synced_at.slice(0,19).replace('T',' ') : '—'}</td>
                  <td style={{padding:"11px 13px",fontSize:12,color:C.text}}>{ee.firstName} {ee.lastName}</td>
                  <td style={{padding:"11px 13px",fontFamily:C.mono,fontSize:11,color:C.dim}}>{c.date_of_injury}</td>
                  <td style={{padding:"11px 13px",fontSize:12,color:C.dim}}>{c.body_part}</td>
                  <td style={{padding:"11px 13px"}}>
                    <Btn small variant="ghost" onClick={() => onView(c)}>View legacy record</Btn>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
    </div>
  );
}

export function LegacyRecordModal({ data, onClose }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.85)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:24,width:820,maxHeight:"85vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div>
            <div style={{fontSize:11,fontFamily:C.mono,color:C.amber,letterSpacing:"0.1em",textTransform:"uppercase"}}>Legacy Record · {data.system}</div>
            <div style={{fontFamily:C.mono,fontSize:18,fontWeight:700,color:C.text,marginTop:4}}>{data.external_id}</div>
          </div>
          <button onClick={onClose} style={{background:C.card,border:`1px solid ${C.border}`,color:C.dim,cursor:"pointer",width:30,height:30,borderRadius:6,fontSize:14}}>✕</button>
        </div>

        <LegacySection title="Legacy claim row" payload={data.legacy_claim}/>
        <LegacySection title={`Diaries pushed back (${(data.diaries||[]).length})`}    payload={data.diaries}/>
        <LegacySection title={`Documents pushed back (${(data.documents||[]).length})`} payload={data.documents}/>
        <LegacySection title={`Field updates pushed back (${(data.updates||[]).length})`} payload={data.updates}/>
      </div>
    </div>
  );
}

export function LegacySection({ title, payload }) {
  const empty = !payload || (Array.isArray(payload) && payload.length === 0);
  return (
    <div style={{marginBottom:14}}>
      <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:6}}>{title}</div>
      <pre style={{
        margin:0,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,
        padding:"12px 14px",fontSize:11,fontFamily:C.mono,
        color: empty ? C.muted : C.dim,
        whiteSpace:"pre-wrap",wordBreak:"break-word",lineHeight:1.55,maxHeight:200,overflowY:"auto",
      }}>{empty ? '(nothing pushed yet)' : JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// AGENTS CONSOLE — feed of every Claude / gating decision
// ═══════════════════════════════════════════════════════════
