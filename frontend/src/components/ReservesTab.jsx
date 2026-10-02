import { useQuery, useQueryClient } from '@tanstack/react-query';
import { approveReserveWorksheet, fetchReserveWorksheet, fetchReserveLedger, fetchPaymentLedger } from '../services/claims.js';
import { C } from '../theme.js';
import { fmt$ } from '../utils.js';
import { Btn, Lbl, SectionHead, Spinner } from '../ui/primitives.jsx';

// ═══════════════════════════════════════════════════════════
// RESERVES TAB (CL-RSV1 + Phase 3 True Ledgers)
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

  const { data: ledgerData } = useQuery({
    queryKey: ['reserve-ledger', claimId],
    queryFn: () => fetchReserveLedger(claimId),
  });

  const { data: paymentData } = useQuery({
    queryKey: ['payment-ledger', claimId],
    queryFn: () => fetchPaymentLedger(claimId),
  });

  if (isLoading) return <Spinner/>;
  if (!ws) return <div style={{ fontSize: 12.5, color: C.muted }}>Worksheet unavailable.</div>;

  const proposal = ws.proposal || {};
  const approved = ws.approved_reserves;
  const ledgerTotals = ledgerData?.balances || { outstanding_reserves: ws.grand_total || 0, paid_to_date: 0, total_incurred: ws.grand_total || 0 };
  const transactions = ledgerData?.transactions || [];
  const payments = paymentData?.payments || [];

  const applyRollup = async () => {
    try {
      await approveReserveWorksheet(claimId, {
        medical: proposal.medical, indemnity: proposal.indemnity, expense: proposal.expense,
      });
      qc.invalidateQueries({ queryKey: ['reserve-worksheet', claimId] });
      qc.invalidateQueries({ queryKey: ['reserve-ledger', claimId] });
      qc.invalidateQueries({ queryKey: ['claim', claimId] });
      notify('Worksheet rollup approved — reserves updated through the approval workflow');
    } catch (e) {
      qc.invalidateQueries({ queryKey: ['reserve-worksheet', claimId] });
      notify(/WORKSHEET_CHANGED/.test(e.message)
        ? 'The worksheet changed since you loaded it — totals refreshed, review and approve again'
        : `Approval failed: ${e.message}`, 'error');
    }
  };

  return (
    <div>
      {/* ── Financial Ledger Balances (Phase 3) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 18 }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Outstanding Reserves</div>
          <div style={{ fontFamily: C.mono, fontSize: 18, fontWeight: 700, color: C.cyan, marginTop: 4 }}>
            {fmt$(ledgerTotals.outstanding_reserves)}
          </div>
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Paid to Date</div>
          <div style={{ fontFamily: C.mono, fontSize: 18, fontWeight: 700, color: C.green, marginTop: 4 }}>
            {fmt$(ledgerTotals.paid_to_date)}
          </div>
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Incurred</div>
          <div style={{ fontFamily: C.mono, fontSize: 18, fontWeight: 700, color: C.amber, marginTop: 4 }}>
            {fmt$(ledgerTotals.total_incurred)}
          </div>
        </div>
      </div>

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
        <Lbl>Worksheet Total</Lbl>
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

      {/* ── Transaction Ledger History ── */}
      {transactions.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <SectionHead title="Reserve Transaction Ledger (Immutable)"/>
          <div style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, textAlign: 'left' }}>
              <thead>
                <tr style={{ background: C.card, borderBottom: `1px solid ${C.border}` }}>
                  <th style={{ padding: '6px 10px', color: C.muted }}>Date</th>
                  <th style={{ padding: '6px 10px', color: C.muted }}>Type</th>
                  <th style={{ padding: '6px 10px', color: C.muted }}>Category</th>
                  <th style={{ padding: '6px 10px', color: C.muted, textAlign: 'right' }}>Delta</th>
                  <th style={{ padding: '6px 10px', color: C.muted, textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(t => (
                  <tr key={t.id} style={{ borderBottom: `1px solid ${C.border}33` }}>
                    <td style={{ padding: '6px 10px', color: C.dim }}>{new Date(t.created_at).toLocaleDateString()}</td>
                    <td style={{ padding: '6px 10px', color: C.text }}>{t.transaction_type.replace('_', ' ')}</td>
                    <td style={{ padding: '6px 10px', color: CAT_META[t.category]?.color || C.text }}>{t.category}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: C.mono, color: t.amount_delta >= 0 ? C.green : C.amber }}>
                      {t.amount_delta >= 0 ? `+${fmt$(t.amount_delta)}` : fmt$(t.amount_delta)}
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: C.mono, color: C.text }}>
                      {fmt$(t.resulting_balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Payment Ledger ── */}
      {payments.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <SectionHead title="Disbursed Payments"/>
          <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, textAlign: 'left' }}>
              <thead>
                <tr style={{ background: C.card, borderBottom: `1px solid ${C.border}` }}>
                  <th style={{ padding: '6px 10px', color: C.muted }}>Date</th>
                  <th style={{ padding: '6px 10px', color: C.muted }}>Type</th>
                  <th style={{ padding: '6px 10px', color: C.muted }}>Method</th>
                  <th style={{ padding: '6px 10px', color: C.muted }}>Status</th>
                  <th style={{ padding: '6px 10px', color: C.muted, textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id} style={{ borderBottom: `1px solid ${C.border}33` }}>
                    <td style={{ padding: '6px 10px', color: C.dim }}>{new Date(p.created_at).toLocaleDateString()}</td>
                    <td style={{ padding: '6px 10px', color: C.text }}>{p.payment_type.replace('_', ' ')}</td>
                    <td style={{ padding: '6px 10px', color: C.dim }}>{p.method}</td>
                    <td style={{ padding: '6px 10px', color: p.status === 'cleared' ? C.green : C.cyan }}>{p.status}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: C.mono, fontWeight: 600, color: C.text }}>
                      {fmt$(p.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
