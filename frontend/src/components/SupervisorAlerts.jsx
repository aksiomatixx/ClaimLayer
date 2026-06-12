import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { acknowledgeSupervisorAlert, fetchSupervisorAlert } from '../services/supervisor.js';
import { C } from '../theme.js';
import { Btn, Lbl } from '../ui/primitives.jsx';

// ═══════════════════════════════════════════════════════════
// SUPERVISOR DAILY ALERT (CL-SUP1) — banner + panel listing
// the business-morning digest: important diaries due today
// (CRITICAL / no-snooze) and every overdue diary, grouped by
// adjuster, each row linking to the claim drawer. Renders
// nothing for non-supervisors (the endpoint 403s) or when no
// digest exists.
// ═══════════════════════════════════════════════════════════

function Section({ title, color, groups, onSelect }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Lbl color={color}>{title}</Lbl>
      {(!groups || groups.length === 0) && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>None.</div>}
      {(groups || []).map(g => (
        <div key={g.adjuster} style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10.5, fontFamily: C.mono, fontWeight: 700, color: C.dim, letterSpacing: '.05em', marginBottom: 4 }}>{g.adjuster}</div>
          {g.items.map(i => (
            <button key={i.diary_id} data-testid={`sup-row-${i.diary_id}`}
              onClick={() => onSelect && onSelect(i.claim_id)}
              style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', textAlign: 'left',
                       background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7,
                       padding: '7px 12px', marginBottom: 5, cursor: 'pointer', color: C.text }}>
              <span style={{ fontFamily: C.mono, fontWeight: 700, fontSize: 11.5, color: C.amber }}>{i.claim_number}</span>
              <span style={{ fontSize: 12, color: C.text }}>{i.worker}</span>
              <span style={{ fontSize: 11.5, color: C.dim, flex: 1 }}>{i.diary_type.replace(/_/g, ' ')}</span>
              <span style={{ fontFamily: C.mono, fontSize: 11, color: i.days_overdue > 0 ? C.red : C.amber }}>
                {i.days_overdue > 0 ? `${i.days_overdue}d overdue` : `due ${i.due_date}`}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function SupervisorAlerts({ onSelect, notify = () => {}, placeholder = false }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: alert } = useQuery({
    queryKey: ['supervisor-alert'],
    queryFn: fetchSupervisorAlert,
    refetchInterval: 60_000,
  });

  if (!alert) {
    // Dedicated supervisor view: explain the empty state instead of
    // rendering nothing (embedded usages keep the silent null).
    return placeholder
      ? <div style={{ fontSize: 12.5, color: C.muted }}>No daily alert yet — the digest generates each business morning (06:30 Pacific), or an admin can trigger it from the ops endpoints.</div>
      : null;
  }
  const p = alert.payload || {};

  const ack = async () => {
    try {
      await acknowledgeSupervisorAlert(alert.id);
      qc.invalidateQueries({ queryKey: ['supervisor-alert'] });
      notify('Daily alert acknowledged (audited)');
    } catch (e) { notify(`Acknowledge failed: ${e.message}`, 'error'); }
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${alert.acknowledged_at ? C.border : `${C.red}55`}`, borderRadius: 10, padding: '14px 18px', marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: C.mono, fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: C.red }}>SUPERVISOR DAILY ALERT · {alert.alert_date}</span>
        <span data-testid="sup-counts" style={{ fontSize: 12.5, color: C.text, flex: 1 }}>
          <b style={{ color: C.amber }}>{alert.due_today_count}</b> important due today · <b style={{ color: C.red }}>{alert.overdue_count}</b> overdue
        </span>
        {!alert.acknowledged_at && <Btn small variant="ghost" onClick={ack}>Acknowledge</Btn>}
        {alert.acknowledged_at && <span style={{ fontSize: 10.5, fontFamily: C.mono, color: C.muted }}>acked by {alert.acknowledged_by}</span>}
        <Btn small variant="ghost" onClick={() => setOpen(v => !v)}>{open ? 'Hide' : 'View'}</Btn>
      </div>
      {open && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          <Section title="Due today — CRITICAL / no-snooze" color={C.amber} groups={p.due_today} onSelect={onSelect}/>
          <Section title="Overdue — all open diaries" color={C.red} groups={p.overdue} onSelect={onSelect}/>
        </div>
      )}
    </div>
  );
}
