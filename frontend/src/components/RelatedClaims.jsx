import { useQuery } from '@tanstack/react-query';
import { fetchClaimLinks } from '../services/claims.js';
import { C } from '../theme.js';
import { Lbl, SectionHead } from '../ui/primitives.jsx';

// ═══════════════════════════════════════════════════════════
// RELATED CLAIMS (CL-DEMO2) — symmetric claim links rendered
// as clickable rows that navigate to the linked claim's drawer.
// Renders nothing when the claim has no links.
// ═══════════════════════════════════════════════════════════

const RELATION_LABEL = {
  prior_claim_same_worker: 'Prior claim — same worker',
};

export default function RelatedClaims({ claimId, onOpenClaim }) {
  const { data: links = [] } = useQuery({
    queryKey: ['claim-links', claimId],
    queryFn: () => fetchClaimLinks(claimId),
  });

  if (links.length === 0) return null;

  return (
    <div style={{ marginTop: 16, marginBottom: 16 }}>
      <SectionHead title="Related Claims"/>
      {links.map(l => {
        const lc = l.linked_claim || {};
        return (
          <button key={l.link_id} data-testid={`related-claim-${lc.id}`}
            onClick={() => onOpenClaim && onOpenClaim(lc.id)}
            style={{ display: 'flex', alignItems: 'baseline', gap: 12, width: '100%', textAlign: 'left',
                     background: C.card, border: `1px solid ${C.border}`, borderRadius: 9,
                     padding: '10px 14px', marginBottom: 8, cursor: 'pointer', color: C.text }}>
            <span style={{ fontFamily: C.mono, fontWeight: 700, fontSize: 12.5, color: C.amber }}>{lc.claim_number || lc.id}</span>
            <span style={{ fontSize: 12, color: C.dim, flex: 1 }}>
              {RELATION_LABEL[l.relation_type] || l.relation_type}
              {lc.body_part ? ` · ${lc.body_part}` : ''}
              {lc.date_of_injury ? ` · DOI ${lc.date_of_injury}` : ''}
            </span>
            <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.muted, textTransform: 'uppercase', letterSpacing: '.05em' }}>{lc.status || ''}</span>
            <span style={{ fontSize: 12, color: C.cyan }}>Open →</span>
          </button>
        );
      })}
      {links.some(l => l.note) && (
        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
          {links.filter(l => l.note).map(l => <div key={l.link_id}><Lbl>Note</Lbl> {l.note}</div>)}
        </div>
      )}
    </div>
  );
}
