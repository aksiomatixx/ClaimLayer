import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDocumentTriage, resolveDocumentTriage, fetchWcisQualityMetrics } from '../services/claims.js';
import { C } from '../theme.js';
import { Btn, SectionHead } from '../ui/primitives.jsx';

const CATEGORIES = ['medical','bill','legal','qme','state_form','rfa','pharmacy',
  'correspondence','surveillance','wage','work_status','settlement','other'];

// ── Document triage queue ─────────────────────────────────────────────────────
// The ingestion pipeline's guardrail surface: documents the agent refused
// to file (low confidence / no claim match / forced category) wait here
// for a human call. Filing through triage runs the same deterministic
// action translation as a confident classification.
export function TriageQueue({ claims, notify }) {
  const qc = useQueryClient();
  const { data: docs = [] } = useQuery({
    queryKey: ['doc-triage'],
    queryFn: fetchDocumentTriage,
    refetchInterval: 30_000,
  });
  const [resolving, setResolving] = useState(null); // docId
  const [form, setForm] = useState({ claim_id: '', category: '', reason: '' });

  if (docs.length === 0) return null;

  const act = async (docId, action) => {
    try {
      const payload = action === 'file'
        ? { action, claim_id: form.claim_id, category: form.category || undefined }
        : { action, reason: form.reason }; // rejections are documented, never dropped
      const r = await resolveDocumentTriage(docId, payload);
      qc.invalidateQueries({ queryKey: ['doc-triage'] });
      qc.invalidateQueries({ queryKey: ['claims'] });
      setResolving(null); setForm({ claim_id: '', category: '', reason: '' });
      notify(action === 'file'
        ? `Filed → ${r.diary?.diary_type || 'documents'}`
        : 'Document rejected');
    } catch (e) { notify(`Triage failed: ${e.message}`, 'error'); }
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.red}44`, borderRadius: 10, padding: '16px 20px', marginBottom: 22 }}>
      <SectionHead title={`Document triage — ${docs.length} awaiting human review`} color={C.red} />
      {docs.map(doc => (
        <div key={doc.id} style={{ borderBottom: `1px solid ${C.border}`, padding: '10px 0' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{doc.title}</div>
              <div style={{ fontSize: 10.5, fontFamily: C.mono, color: C.muted, margin: '2px 0 6px' }}>
                {String(doc.received_at || '').split('T')[0]} · {doc.source} · confidence {doc.classification_confidence ?? '—'} · {doc.triage_reason}
              </div>
              {doc.ai_summary && <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.55 }}>{doc.ai_summary}</div>}
            </div>
            {resolving !== doc.id && (
              <Btn small onClick={() => { setResolving(doc.id); setForm({ claim_id: doc.claim_id || '', category: doc.category || '', reason: '' }); }}>Resolve…</Btn>
            )}
          </div>
          {resolving === doc.id && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <select value={form.claim_id} onChange={e => setForm(f => ({ ...f, claim_id: e.target.value }))}
                style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12 }}>
                <option value="">Assign claim…</option>
                {(claims || []).map(c => (
                  <option key={c.id} value={c.id}>{c.claimNumber || c.id} — {c.employee?.firstName} {c.employee?.lastName}</option>
                ))}
              </select>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12 }}>
                <option value="">Category…</option>
                {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat.replace(/_/g, ' ')}</option>)}
              </select>
              <Btn small disabled={!form.claim_id} onClick={() => act(doc.id, 'file')}>File + queue action</Btn>
              <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="Rejection reason (required to reject)"
                style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, minWidth: 220 }} />
              <Btn small variant="ghost" disabled={!form.reason.trim()} onClick={() => act(doc.id, 'reject')}>Reject</Btn>
              <Btn small variant="ghost" onClick={() => setResolving(null)}>Cancel</Btn>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── WCIS quality strip ────────────────────────────────────────────────────────
export function WcisQualityStrip() {
  const { data: q } = useQuery({
    queryKey: ['wcis-quality'],
    queryFn: fetchWcisQualityMetrics,
    refetchInterval: 60_000,
  });
  if (!q) return null;
  const cell = (label, value, color) => (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 9.5, fontFamily: C.mono, color: C.muted, letterSpacing: '.07em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 17, fontFamily: C.mono, fontWeight: 600, color: color || C.text }}>{value}</div>
    </div>
  );
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 20px', marginBottom: 22, display: 'flex', gap: 18, alignItems: 'center' }}>
      <div style={{ fontSize: 10, fontFamily: C.mono, fontWeight: 700, color: C.muted, letterSpacing: '.08em' }}>WCIS<br/>QUALITY</div>
      {cell('Transmitted', q.transmitted_total)}
      {cell('Rejection %', `${q.rejection_rate_pct}%`, q.rejection_rate_pct > 5 ? C.red : C.green)}
      {cell('TE %', `${q.te_rate_pct}%`, q.te_rate_pct > 10 ? C.amber : C.green)}
      {cell('Ack overdue', q.ack_overdue_count, q.ack_overdue_count > 0 ? C.amber : C.green)}
      {cell('Late triggers', q.late_pending_triggers, q.late_pending_triggers > 0 ? C.red : C.green)}
      {cell('No FROI accepted', q.claims_without_accepted_froi, q.claims_without_accepted_froi > 0 ? C.amber : C.green)}
    </div>
  );
}
