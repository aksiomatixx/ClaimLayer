// ═══════════════════════════════════════════════════════════
// ARCHITECTURE — In-app technical playbook for the agentic system.
//
// Admin-only static page. Reads two live signals from the backend:
//   GET /api/v1/ai-decisions/stats?window=30   (per-agent stats)
//   GET /api/v1/prompts/:name                  (full prompt text on demand)
//
// Everything else is a hand-curated JSON spec at the top of this file
// so the page is interview-grade copy without being maintenance-heavy.
// ═══════════════════════════════════════════════════════════

import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAiDecisionStats, fetchAiDecisions, fetchPromptText } from './services/aiDecisions.js';
import sourcesJson from '../../docs/regulatory/sources.json';

const C = {
  bg:"#040e1c",surface:"#0a1622",card:"#0e1c2e",card2:"#111e30",
  border:"#182b42",borderMid:"#1d3350",
  amber:"#f59e0b",amberD:"#d97706",amberF:"#1a1200",
  blue:"#4a8df0",blueF:"#06122a",
  green:"#0eb87a",greenF:"#001510",
  red:"#f04040",redF:"#1a0303",
  purple:"#a78bfa",purpleF:"#0e0920",
  cyan:"#22d3ee",cyanF:"#011820",
  teal:"#14b8a6",tealF:"#011814",
  text:"#d5e6f2",dim:"#6e8daa",muted:"#384f65",
  mono:"'IBM Plex Mono',monospace",sans:"'IBM Plex Sans',sans-serif",
};

// ───────────────────────────────────────────────────────────
// SPEC — single source of truth for the page content.
// ───────────────────────────────────────────────────────────
const HEADLINE =
  "An AI-augmented California workers' compensation TPA. " +
  "Claude operates inside hard regulatory guardrails with mandatory " +
  "human-in-the-loop sign-off on every compensability, authorization, " +
  "and settlement decision.";

const LIFECYCLE = [
  { status: 'new_claim',              kind: 'auto', label: 'New Claim',      note: 'FROI received' },
  { status: 'intake_complete',        kind: 'ai',   label: 'Intake Complete', note: 'Voice extraction · ADP pull' },
  { status: 'under_investigation',    kind: 'ai',   label: 'Investigation',   note: 'Compensability AI analysis' },
  { status: 'accepted',               kind: 'human', label: 'Accepted',        note: 'Adjuster signs off on AI rec' },
  { status: 'active_medical',         kind: 'ai',   label: 'Active Medical',  note: 'RFA / MTUS evaluation' },
  { status: 'p_and_s',                kind: 'auto', label: 'P&S',             note: 'PR-2 / PR-4 received' },
  { status: 'pd_evaluation',          kind: 'auto', label: 'PD Evaluation',   note: 'PDRS lookup (deterministic)' },
  { status: 'settlement_discussions', kind: 'ai',   label: 'Settlement Disc.', note: 'C&R AI pricing · MSA gate' },
  { status: 'litigated',              kind: 'human', label: 'Litigated',       note: 'WCAB / attorney workflow' },
  { status: 'denied',                 kind: 'human', label: 'Denied',          note: 'Adjuster decision · DWC I&A' },
  { status: 'closed',                 kind: 'auto', label: 'Closed',          note: 'EAMS filed manually' },
];

const AGENTS = [
  {
    id: 'compensability', name: 'Compensability Analyst',
    prompt: 'compensability_analysis', model: 'claude-sonnet-4-6',
    invoked_when: 'Claim transitions to intake_complete (FROI + ADP pull complete)',
    inputs:  ['Body part', 'Injury type + description', 'Job title', 'AWW / TD rate', 'Employer-contests flag', 'Motor vehicle fields'],
    outputs: ['compensability', 'compensabilityScore (0-100)', 'priority', 'suggestedMedicalReserve', 'suggestedIndemnityReserve', 'suggestedExpenseReserve', 'redFlags[]', 'nextActions[]'],
    guardrails: ['Never sets claim status — recommends only', 'Adjuster signs off before status changes to accepted/denied', 'JSON parse failure throws — never silently auto-approves'],
    fallback: 'On JSON parse failure → claim_event ai_analysis_failed + manual review queue. On API timeout (45s) → caller catches and queues retry.',
  },
  {
    id: 'rfa_mtus', name: 'RFA / MTUS Evaluator',
    prompt: 'rfa_mtus_evaluation', model: 'claude-sonnet-4-6',
    invoked_when: 'New RFA received (rfaService.createRFA → fire-and-forget evaluation)',
    inputs:  ['Accepted diagnosis', 'Requested treatment', 'CPT codes', 'Days since DOI', 'Body part', 'CA jurisdiction context'],
    outputs: ['recommendedAction (auto_approve | physician_review)', 'mtusConsistency', 'rationale', 'urgency'],
    guardrails: ['AI may ONLY return auto_approve or physician_review — denials forced to physician_review', 'Surgical CPT 10000-69999 + Cat-III always route to URO regardless of AI rec', '_resolveDecision routes MTUS-inconsistent → URO even on physician_review'],
    fallback: 'On evaluation failure → defer status, manual triage diary. Never auto-approve on error.',
  },
  {
    id: 'cnr_pricing', name: 'C&R Pricing Engine',
    prompt: 'cnr_pricing', model: 'claude-sonnet-4-6',
    invoked_when: 'pdPricingService.priceCnr called after MSA screening passes',
    inputs:  ['Claim demographics + age', 'WPI + PD%', 'Stip value (deterministic from PDRS)', 'Apportionment %', 'Claim age'],
    outputs: ['cnrValueLow / Mid / High', 'rationale', 'riskFactors[]', 'futureMedicalEstimate', 'recommendation (always adjuster_review)'],
    guardrails: ['Recommendation hardcoded to adjuster_review — AI cannot price unilaterally', 'Premium >5× stip rejected outright (cnr_premium_cap_5x)', 'Premium >1.15× stip flagged for adjuster review (cnr_premium_cap_1.15x)'],
    fallback: 'On pricing failure → no settlement_offer row written; status stays in pd_evaluation.',
  },
  {
    id: 'msa_screening', name: 'MSA Screening Gate',
    prompt: 'msa_threshold_evaluation', model: 'deterministic',
    invoked_when: 'cnrService preflight before any C&R offer',
    inputs:  ['Worker age', 'SSDI receiving flag', 'Projected settlement value'],
    outputs: ['medicare_eligible', 'msa_required', 'msa_required_reason'],
    guardrails: ['No AI in this path — pure threshold logic prevents model hallucination on Medicare eligibility', 'C&R blocked when msa_required=true; only stip path remains'],
    fallback: 'Deterministic — fails closed (cannot proceed to C&R) when employee data missing.',
  },
  {
    id: 'voice_extract', name: 'Voice Intake Extractor',
    prompt: 'voice_extraction', model: 'claude-sonnet-4-6',
    invoked_when: 'Employee submits voice transcript via intake wizard',
    inputs:  ['Whisper transcript', 'Known DOI / employer / body part context'],
    outputs: ['body_part', 'mechanism', 'time_of_injury', 'witnesses', 'prior_claims', 'medical_treatment', 'confidence (0-100)'],
    guardrails: ['Confidence floor of 50 set if model omits the field', 'No structured fields ever overwrite adjuster-entered values'],
    fallback: 'On extraction failure → EXTRACTION_FAILED, intake wizard falls back to manual form entry.',
  },
];

const GUARDRAILS = [
  { rule: 'No auto-deny path anywhere in the system',                                 where: 'Architecturally absent — there is no code path from AI output to a denied status',  why: 'CA Labor Code §5402 + §4062 due-process protections require licensed human decision' },
  { rule: 'AI may only return auto_approve or physician_review on RFAs',              where: 'aiService.evaluateRFA + rfaService._resolveDecision',                              why: 'MTUS authority (LC §4610, DWC FAQ) requires licensed physician for adverse determinations' },
  { rule: 'Surgical CPT 10000-69999 + Cat-III codes always route to URO',             where: 'rfaService._isSurgical (overrides AI rec)',                                        why: 'Surgical authorization requires physician review regardless of guideline consistency' },
  { rule: 'C&R AI offers capped at 1.15× stipulated value',                            where: 'pdPricingService — guardrail emitted on every cnr_pricing decision',              why: 'Prevents AI-driven over-settlement; flags for adjuster scrutiny' },
  { rule: 'C&R AI offers above 5.0× stip value rejected',                              where: 'pdPricingService — cnr_premium_cap_5x guardrail',                                  why: 'Catches model errors before the offer ever reaches the worker' },
  { rule: 'MSA screening gates all C&R settlements',                                   where: 'cnrService.preflight + msaScreeningService.screenMSA',                             why: 'CMS WCMSA Reference Guide compliance — Medicare/SSDI/65+ triggers' },
  { rule: 'Migrations never auto-applied',                                             where: 'Development workflow — every *.sql file staged in supabase/migrations/ for review', why: 'Regulatory data integrity; schema changes touching PDRS / fee schedules need sign-off' },
  { rule: 'Regulatory data never synthesized by AI',                                   where: 'Code review + service-level constants (e.g., pdrs_lookup seed)',                    why: 'PDRS values, statutory rates, fee schedules sourced from authoritative DWC publications only' },
  { rule: 'DWC I&A block hardcoded in unrepresented worker notices',                   where: 'pdfService._drawIABlock (called from every notice generator)',                     why: '8 CCR §10212 — every unrepresented worker notice must contain this block verbatim' },
  { rule: 'EAMS filing always manual',                                                 where: 'cnrService.recordEAMSFiled + stipService — filed_at set by adjuster, never auto', why: 'No EAMS API exists; manual filing is a procedural rule, not a tooling gap' },
  { rule: 'A1 / FileHandler sync failures queued, never block operations',             where: 'claimService — FH sync wrapped in try/catch with claim_events retry log',          why: 'CMS = financial system of record; operational state must continue when CMS is degraded' },
  { rule: 'Audit trail on every Claude call + every gate decision',                    where: 'aiDecisionsService.logDecision (best-effort, never throws)',                       why: '7-year CA WC audit retention; observability for DWC PAR audits' },
];

// Integration architecture — system-of-engagement / system-of-record split.
const INTEGRATION_ADAPTERS = [
  { adapter: 'A1 Tracker / FileHandler',  direction: 'Write-back',     status: 'Reference impl (live)' },
  { adapter: 'Mock Legacy',               direction: 'Bidirectional',  status: 'Demo round trip (live)' },
  { adapter: 'Origami Risk',              direction: 'Bidirectional',  status: 'Planned' },
  { adapter: 'Guidewire ClaimCenter',     direction: 'Bidirectional',  status: 'Planned' },
  { adapter: 'Sapiens',                   direction: 'Bidirectional',  status: 'Planned' },
];

const HUMAN_CHECKPOINTS = [
  { step: 'Compensability decision (accepted / denied)',  who: 'Adjuster',           triggers: 'AI compensability output → claimService.updateStatus' },
  { step: 'Reserve approval',                              who: 'Adjuster',           triggers: 'AI suggested reserves → claimService.approveReserves' },
  { step: 'RFA approval / route to URO',                   who: 'Adjuster',           triggers: 'rfaService.adjusterApproveRFA / adjusterRouteToURO' },
  { step: 'MMI / P&S confirmation',                        who: 'Treating physician → adjuster review', triggers: 'mmiService — solicit PR-4, record response' },
  { step: 'PD advance amount + start date',                who: 'Adjuster',           triggers: 'pdService.initiatePDAdvances (LC §4650(b) 14 cal day clock)' },
  { step: 'C&R offer review (AI range → human price)',     who: 'Adjuster',           triggers: 'cnrService.offerCnr after pdPricingService.priceCnr' },
  { step: 'C&R offer accept (worker signature + adjuster signature)', who: 'Worker + adjuster', triggers: 'cnrService.recordWorkerAcceptance / recordAdjusterSignature' },
  { step: 'EAMS filing',                                   who: 'Adjuster',           triggers: 'cnrService.recordEAMSFiled — manual procedural step' },
  { step: 'Stipulation EAMS filing → claim closure',       who: 'Adjuster',           triggers: 'pdService.recordEAMSFiled (premature-closure-fix in M14.5)' },
];

// ───────────────────────────────────────────────────────────
// PRIMITIVES (mirror of App.jsx style — kept local so this file can
// be imported without pulling in everything in App.jsx).
// ───────────────────────────────────────────────────────────
function SectionHead({title, sub}) {
  return (
    <div style={{paddingBottom:8,marginBottom:14,borderBottom:`1px solid ${C.border}`}}>
      <div style={{fontSize:11,fontFamily:C.mono,color:C.amber,letterSpacing:"0.1em",textTransform:"uppercase",fontWeight:700}}>{title}</div>
      {sub && <div style={{fontSize:11,color:C.muted,marginTop:3}}>{sub}</div>}
    </div>
  );
}
function Section({title, sub, defaultOpen = true, children, printAlwaysOpen = true}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={printAlwaysOpen ? 'arch-section' : ''} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"22px 26px",marginBottom:18}}>
      <div onClick={()=>setOpen(!open)} style={{cursor:"pointer",userSelect:"none"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
          <SectionHead title={title} sub={sub}/>
          <span style={{fontSize:14,color:C.muted,marginBottom:14}} className="arch-toggle">{open ? '▾' : '▸'}</span>
        </div>
      </div>
      {open && <div className="arch-body">{children}</div>}
    </section>
  );
}
function Pill({label, color}) {
  return <span style={{display:"inline-block",background:`${color}22`,color,border:`1px solid ${color}55`,padding:"2px 10px",borderRadius:14,fontSize:10,fontFamily:C.mono,fontWeight:600,letterSpacing:"0.04em"}}>{label}</span>;
}

// ───────────────────────────────────────────────────────────
// LIFECYCLE — horizontal SVG flow with kind-coded boxes.
// ───────────────────────────────────────────────────────────
const KIND_COLOR = { ai: C.green, human: C.amber, auto: C.blue };
const KIND_LABEL = { ai: 'AI-assisted', human: 'Human-required', auto: 'Mechanical (no AI)' };

function LifecycleDiagram() {
  const W = 1180, H = 230, BOX_W = 110, BOX_H = 56, GAP = (W - LIFECYCLE.length * BOX_W) / (LIFECYCLE.length + 1);
  return (
    <div style={{overflowX:"auto"}}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",minWidth:900,height:"auto",display:"block"}}>
        {LIFECYCLE.map((step, i) => {
          const x = GAP + i * (BOX_W + GAP);
          const y = (H - BOX_H) / 2;
          const color = KIND_COLOR[step.kind] || C.dim;
          return (
            <g key={step.status}>
              {i > 0 && (
                <line x1={x - GAP + 2} y1={y + BOX_H/2} x2={x - 2} y2={y + BOX_H/2} stroke={C.borderMid} strokeWidth="1.5" markerEnd="url(#arrow)"/>
              )}
              <rect x={x} y={y} width={BOX_W} height={BOX_H} fill={`${color}22`} stroke={color} strokeWidth="1.5" rx="6" ry="6"/>
              <text x={x + BOX_W/2} y={y + 22} fill={color} fontSize="11" fontFamily="IBM Plex Mono" fontWeight="700" textAnchor="middle">{step.label}</text>
              <text x={x + BOX_W/2} y={y + 39} fill={C.dim} fontSize="9" fontFamily="IBM Plex Sans" textAnchor="middle">{step.status}</text>
              <text x={x + BOX_W/2} y={y - 8}        fill={C.muted} fontSize="9" fontFamily="IBM Plex Mono" textAnchor="middle" opacity={i % 2 === 0 ? 1 : 0}>{step.note}</text>
              <text x={x + BOX_W/2} y={y + BOX_H + 14} fill={C.muted} fontSize="9" fontFamily="IBM Plex Mono" textAnchor="middle" opacity={i % 2 === 1 ? 1 : 0}>{step.note}</text>
            </g>
          );
        })}
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L6,3 L0,6 z" fill={C.borderMid}/>
          </marker>
        </defs>
      </svg>
      <div style={{display:"flex",gap:14,marginTop:14,fontSize:10,fontFamily:C.mono,color:C.muted,flexWrap:"wrap"}}>
        {Object.entries(KIND_LABEL).map(([k, label]) => (
          <span key={k} style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{display:"inline-block",width:10,height:10,background:KIND_COLOR[k],borderRadius:2}}/>{label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// AGENT CARD — pulls live stats per type.
// ───────────────────────────────────────────────────────────
function AgentCard({agent, statsByType, onShowPrompt}) {
  const s = statsByType[agent.id] || null;
  const color = agent.id === 'msa_screening' ? C.teal : KIND_COLOR.ai;
  return (
    <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"18px 20px",breakInside:"avoid"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div>
          <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:4}}>{agent.name}</div>
          <div style={{fontFamily:C.mono,fontSize:10,color:C.muted}}>{agent.prompt}.txt · {agent.model}</div>
        </div>
        <Pill label={`${s?.count ?? 0} · 30d`} color={color}/>
      </div>
      <div style={{fontSize:11,color:C.dim,marginBottom:10,lineHeight:1.55}}><b style={{color:C.muted}}>Invoked when:</b> {agent.invoked_when}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:10}}>
        <div>
          <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:5}}>Inputs</div>
          {agent.inputs.map(i => <div key={i} style={{fontSize:11,color:C.dim,marginBottom:3,fontFamily:C.mono}}>· {i}</div>)}
        </div>
        <div>
          <div style={{fontSize:10,fontFamily:C.mono,color:C.muted,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:5}}>Outputs</div>
          {agent.outputs.map(o => <div key={o} style={{fontSize:11,color:C.dim,marginBottom:3,fontFamily:C.mono}}>· {o}</div>)}
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:10,fontFamily:C.mono,color:C.red,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:5}}>Guardrails</div>
        {agent.guardrails.map(g => <div key={g} style={{fontSize:11,color:"#fb7185",marginBottom:3,fontFamily:C.mono}}>⚡ {g}</div>)}
      </div>
      <div style={{fontSize:11,color:C.dim,marginBottom:10,fontStyle:"italic"}}><b style={{color:C.muted,fontStyle:"normal"}}>Fallback:</b> {agent.fallback}</div>
      <div style={{display:"flex",gap:14,paddingTop:10,borderTop:`1px solid ${C.border}`,fontSize:11,fontFamily:C.mono}}>
        <span style={{color:C.muted}}>30d: <span style={{color:C.text}}>{s?.count ?? 0}</span></span>
        <span style={{color:C.muted}}>auto: <span style={{color:C.green}}>{s?.autoPct ?? '—'}%</span></span>
        <span style={{color:C.muted}}>overridden: <span style={{color:C.amber}}>{s?.overridePct ?? '—'}%</span></span>
        <button onClick={()=>onShowPrompt(agent.prompt)} style={{marginLeft:"auto",background:"transparent",border:`1px solid ${C.border}`,color:C.dim,padding:"3px 10px",borderRadius:4,fontSize:10,fontFamily:C.mono,cursor:"pointer"}}>View prompt →</button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// GENERIC TABLES (guardrails / checkpoints / sources)
// ───────────────────────────────────────────────────────────
function PlainTable({columns, rows, getCell}) {
  return (
    <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead><tr style={{borderBottom:`1px solid ${C.border}`,background:"#08172a"}}>
          {columns.map(c => <th key={c.key} style={{padding:"10px 14px",textAlign:"left",fontSize:10,fontFamily:C.mono,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap"}}>{c.label}</th>)}
        </tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} style={{borderBottom:i<rows.length-1?`1px solid ${C.border}`:"none"}}>
            {columns.map(c => (
              <td key={c.key} style={{padding:"11px 14px",fontSize:12,color:C.dim,verticalAlign:"top",lineHeight:1.55,fontFamily:c.mono?C.mono:C.sans}}>
                {getCell ? getCell(r, c) : (r[c.key] ?? '—')}
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// PROMPT MODAL — re-implement locally so this file doesn't depend
// on App.jsx components that aren't exported.
// ───────────────────────────────────────────────────────────
function PromptModal({data, onClose}) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(2,8,18,.85)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:24,width:760,maxHeight:"82vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:13,fontFamily:C.mono,fontWeight:700,color:C.amber}}>{data.name}.txt</div>
          <button onClick={onClose} style={{background:C.card,border:`1px solid ${C.border}`,color:C.dim,cursor:"pointer",width:28,height:28,borderRadius:6,fontSize:14}}>✕</button>
        </div>
        <pre style={{margin:0,fontSize:11,fontFamily:C.mono,color:C.dim,whiteSpace:"pre-wrap",wordBreak:"break-word",lineHeight:1.55}}>{data.text}</pre>
      </div>
    </div>
  );
}

// Inline print stylesheet — turns the page into a clean PDF artifact.
const PRINT_CSS = `
@media print {
  body { background: #fff !important; color: #000 !important; }
  .arch-toggle, .arch-printhide { display: none !important; }
  .arch-section { background: #fff !important; border: 1px solid #999 !important; box-shadow: none !important; break-inside: avoid; }
  .arch-section * { color: #000 !important; }
  .arch-section svg text { fill: #000 !important; }
  .arch-section svg rect { fill: #fff !important; stroke: #555 !important; }
}
`;

// ───────────────────────────────────────────────────────────
// MAIN COMPONENT
// ───────────────────────────────────────────────────────────
function Architecture() {
  // Per-agent stats by type — derived from /ai-decisions/stats and a
  // single page over the feed for override + guardrail percentages.
  const {data: stats} = useQuery({queryKey:['arch-stats'], queryFn:()=>fetchAiDecisionStats(30), refetchInterval: 60_000});
  const {data: feed}  = useQuery({queryKey:['arch-feed'],  queryFn:()=>fetchAiDecisions({ limit: 200 }), refetchInterval: 60_000});

  const statsByType = useMemo(() => {
    const out = {};
    for (const a of AGENTS) {
      const count = stats?.by_type?.[a.id === 'voice_extract' ? 'voice_extract' : a.id] ?? 0;
      const rows  = (feed?.rows || []).filter(r => r.decision_type === a.id);
      const overridden  = rows.filter(r => !!r.human_decision).length;
      const overridePct = rows.length === 0 ? 0 : Math.round((overridden / rows.length) * 100);
      out[a.id] = { count, overridePct, autoPct: rows.length === 0 ? 0 : 100 - overridePct };
    }
    return out;
  }, [stats, feed]);

  const [promptModal, setPromptModal] = useState(null);
  const showPrompt = async (name) => {
    try { setPromptModal(await fetchPromptText(name)); }
    catch (e) { setPromptModal({ name, text: `Failed to load prompt: ${e.message}` }); }
  };

  useEffect(() => {
    document.title = 'Architecture · ClaimLayer';
    return () => { document.title = 'ClaimLayer'; };
  }, []);

  return (
    <div style={{paddingTop:32,paddingBottom:80,animation:"fadeUp .3s ease",color:C.text,fontFamily:C.sans}}>
      <style>{PRINT_CSS}</style>

      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:26,gap:24}}>
        <div>
          <div style={{fontSize:11,fontFamily:C.mono,color:C.amber,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>Technical Playbook</div>
          <h1 style={{fontSize:26,fontWeight:700,marginBottom:14}}>System Architecture</h1>
          <p style={{fontSize:14,color:C.dim,maxWidth:880,lineHeight:1.65}}>{HEADLINE}</p>
        </div>
        <button onClick={()=>window.print()} className="arch-printhide"
          style={{background:C.amber,color:"#000",border:"none",padding:"10px 22px",borderRadius:7,fontSize:13,fontWeight:700,fontFamily:C.sans,cursor:"pointer",whiteSpace:"nowrap"}}>📄 Download as PDF</button>
      </div>

      {/* B. Lifecycle */}
      <Section title="Claim Lifecycle + Agent Touchpoints" sub="11 statuses · color-coded by automation kind">
        <LifecycleDiagram/>
      </Section>

      {/* C. Agent registry */}
      <Section title={`Agent Registry (${AGENTS.length})`} sub="Every model + deterministic gate, with live 30-day stats">
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
          {AGENTS.map(a => <AgentCard key={a.id} agent={a} statsByType={statsByType} onShowPrompt={showPrompt}/>)}
        </div>
      </Section>

      {/* D. Guardrail catalog */}
      <Section title={`Guardrail Catalog (${GUARDRAILS.length})`} sub="Architectural rules — each enforced in code, each tied to a regulatory or product requirement">
        <PlainTable
          columns={[
            { key: 'rule',  label: 'Rule' },
            { key: 'where', label: 'Where enforced', mono: true },
            { key: 'why',   label: 'Why' },
          ]}
          rows={GUARDRAILS}
        />
      </Section>

      {/* E. Human-in-the-loop checkpoints */}
      <Section title={`Human-in-the-Loop Checkpoints (${HUMAN_CHECKPOINTS.length})`} sub="Every adjuster sign-off in the system, in lifecycle order">
        <PlainTable
          columns={[
            { key: 'step',     label: 'Checkpoint' },
            { key: 'who',      label: 'Who signs off', mono: true },
            { key: 'triggers', label: 'Triggered by', mono: true },
          ]}
          rows={HUMAN_CHECKPOINTS}
        />
      </Section>

      {/* F-prime. Integration architecture */}
      <Section title="Integration Architecture" sub="System-of-engagement on top of a retained system-of-record">
        <p style={{fontSize:13,color:C.dim,maxWidth:880,lineHeight:1.7,marginBottom:14}}>
          ClaimLayer deploys on top of a customer's existing claims system-of-record
          (Origami Risk, Guidewire ClaimCenter, Sapiens, A1 Tracker / FileHandler) rather
          than replacing it. A pluggable <span style={{fontFamily:C.mono,color:C.text}}>LegacyClaimsAdapter</span> interface
          lets each customer system be wired in with the same contract — no rip-and-replace,
          no rewriting business logic. The customer's adjusters continue to use their
          system-of-record as the financial / regulatory ledger; ClaimLayer runs the
          AI-assisted workflow layer on top.
        </p>
        <p style={{fontSize:12,color:C.dim,maxWidth:880,lineHeight:1.65,marginBottom:18,fontFamily:C.mono}}>
          Interface methods:&nbsp;
          <span style={{color:C.amber}}>healthCheck()</span>,&nbsp;
          <span style={{color:C.amber}}>ingestClaims(filter)</span>,&nbsp;
          <span style={{color:C.amber}}>pushClaimUpdate(externalId, change)</span>,&nbsp;
          <span style={{color:C.amber}}>pushDiary(externalId, diary)</span>,&nbsp;
          <span style={{color:C.amber}}>pushDocument(externalId, doc)</span>,&nbsp;
          <span style={{color:C.amber}}>pushNotice(externalId, notice)</span>.
        </p>
        <PlainTable
          columns={[
            { key: 'adapter',   label: 'Adapter' },
            { key: 'direction', label: 'Direction', mono: true },
            { key: 'status',    label: 'Status',    mono: true },
          ]}
          rows={INTEGRATION_ADAPTERS}
        />
      </Section>

      {/* F. Regulatory data sources */}
      <Section title={`Regulatory Data Sources (${sourcesJson.sources.length})`} sub="Manually maintained at docs/regulatory/sources.json — never synthesized by AI">
        <PlainTable
          columns={[
            { key: 'source',        label: 'Source' },
            { key: 'version',       label: 'Version', mono: true },
            { key: 'last_verified', label: 'Last verified', mono: true },
            { key: 'used_in',       label: 'Used in', mono: true },
          ]}
          rows={sourcesJson.sources}
        />
      </Section>

      {promptModal && <PromptModal data={promptModal} onClose={()=>setPromptModal(null)}/>}
    </div>
  );
}

export default Architecture;
