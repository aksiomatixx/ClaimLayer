import { useQuery, useQueryClient } from '@tanstack/react-query';
import { approveReserves, fetchReserveWorksheet } from '../services/claims.js';
import { C } from '../theme.js';
import { fmt$ } from '../utils.js';
import { Btn, Lbl, SectionHead, Spinner } from '../ui/primitives.jsx';

// ═══════════════════════════════════════════════════════════
// RESERVES TAB (CL-RSV1) — the itemized reserve worksheet.
// Line items grouped by category with subtotals and a grand
// total. The worksheet only PROPOSES: applying its rollup goes
// through the same M3 adjuster approval the flat numbers always
// did (PATCH /claims/:id/reserves).
// ═══════════════════════════════════════════════════════════

const CAT_META = {
  medical:   { label: 'Medical',   color: C.green },
  indemnity: { label: 'Indemnity', color: C.cyan },
  expense:   { label: 'Expense',   color: C.amber },
};

function lineQty(item) {
  if (item.shape === 'flat') return 'flat';
  const qty = Number(item.quantity);
  const unit = fmt$(Number(item.unit_amount));
  return item.shape === 'weeks_rate' ? `${qty} wks × ${unit}` : `${qty} × ${unit}`;
}

export default function ReservesTab({ claimId, notify }) {
  const qc = useQueryClient();
  const { data: ws, isLoading } = useQuery({
    queryKey: ['reserve-worksheet', claimId],
    queryFn: () => fetchReserveWorksheet(claimId),
  });

  if (isLoading) return <Spinner/>;
  if (!ws) return <div style={{ fontSize: 12.5, color: C.muted }}>Worksheet unavailable.</div>;

  const proposal = ws.proposal || {};
  const approved = ws.approved_reserves;

  const applyRollup = async () => {
    try {
      await approveReserves(claimId, {
        medical: proposal.medical, indemnity: proposal.indemnity,
        expense: proposal.expense, reason: proposal.reason,
      });
      qc.invalidateQueries({ queryKey: ['reserve-worksheet', claimId] });
      qc.invalidateQueries({ queryKey: ['claim', claimId] });
      notify('Worksheet rollup approved — reserves updated through the approval workflow');
    } catch (e) { notify(`Approval failed: ${e.message}`, 'error'); }
  };

  return (
    <div>
      <SectionHead title="Itemized Reserve Worksheet"/>
      {Object.entries(CAT_META).map(([cat, meta]) => {
        const items = ws.items?.[cat] || [];
        return (
          <div key={cat} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', borderBottom: `1px solid ${C.border}`, paddingBottom: 5, marginBottom: 8 }}>
              <Lbl color={meta.color}>{meta.label}</Lbl>
              <span data-testid={`subtotal-${cat}`} style={{ fontFamily: C.mono, fontWeight: 700, fontSize: 13.5, color: meta.color }}>{fmt$(ws.subtotals?.[cat] || 0)}</span>
            </div>
            {items.length === 0 && <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>No line items.</div>}
            {items.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '5px 0', borderBottom: `1px dashed ${C.border}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.text }}>{item.label}</div>
                  {item.basis_note && <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>{item.basis_note}</div>}
                </div>
                <span style={{ fontFamily: C.mono, fontSize: 11.5, color: C.dim, whiteSpace: 'nowrap' }}>{lineQty(item)}</span>
                <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: C.text, minWidth: 86, textAlign: 'right' }}>{fmt$(Number(item.total))}</span>
              </div>
            ))}
          </div>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.card, border: `1px solid ${C.borderMid || C.border}`, borderRadius: 10, padding: '13px 16px', marginTop: 6 }}>
        <Lbl>Grand total</Lbl>
        <span data-testid="grand-total" style={{ fontFamily: C.mono, fontWeight: 700, fontSize: 17, color: C.cyan }}>{fmt$(ws.grand_total || 0)}</span>
      </div>

      <div style={{ marginTop: 14, background: C.card, border: `1px solid ${proposal.status === 'pending_approval' ? `${C.amber}55` : C.border}`, borderRadius: 10, padding: '13px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <Lbl color={proposal.status === 'pending_approval' ? C.amber : C.green}>
            {proposal.status === 'no_worksheet' ? 'No worksheet yet'
              : proposal.status === 'pending_approval' ? 'Proposed change — pending adjuster approval'
              : 'Approved — reserves match the worksheet'}
          </Lbl>
        </div>
        {approved && (
          <div style={{ fontSize: 11.5, color: C.dim, marginBottom: proposal.status === 'pending_approval' ? 10 : 0 }}>
            Last approved: {fmt$(approved.medical)} med · {fmt$(approved.indemnity)} ind · {fmt$(approved.expense)} exp
            {approved.approved_by ? ` — by ${approved.approved_by}` : ''}
          </div>
        )}
        {!approved && proposal.status === 'pending_approval' && (
          <div style={{ fontSize: 11.5, color: C.dim, marginBottom: 10 }}>No adjuster-approved reserves on file yet.</div>
        )}
        {proposal.status === 'pending_approval' && (
          <Btn small onClick={applyRollup}>Approve worksheet totals as reserves</Btn>
        )}
      </div>
    </div>
  );
}
