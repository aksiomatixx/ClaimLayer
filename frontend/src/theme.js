// ═══════════════════════════════════════════════════════════
// THEME & GLOBAL STYLE CONSTANTS (extracted verbatim from App.jsx)
// ═══════════════════════════════════════════════════════════
export const FONTS = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap');`;
export const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#040e1c}::-webkit-scrollbar-thumb{background:#182b42;border-radius:3px}
input,select,textarea{background:#0a1622!important;border:1px solid #182b42!important;color:#d5e6f2!important;border-radius:7px!important;padding:10px 13px!important;font-family:'IBM Plex Sans',sans-serif!important;font-size:13px!important;width:100%;outline:none;transition:border-color .2s}
input:focus,select:focus,textarea:focus{border-color:#f59e0b!important;box-shadow:0 0 0 3px rgba(245,158,11,.07)!important}
input::placeholder,textarea::placeholder{color:#384f65!important}
select option{background:#0a1622;color:#d5e6f2}
input[type=radio],input[type=checkbox]{width:auto!important;padding:0!important;accent-color:#f59e0b}
.rh:hover{background:#0d1c2e!important;cursor:pointer}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideR{from{opacity:0;transform:translateX(44px)}to{opacity:1;transform:translateX(0)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
@keyframes ripple{0%{transform:scale(1);opacity:.6}100%{transform:scale(2.5);opacity:0}}
.spin{animation:spin 1s linear infinite}
.pulse{animation:pulse 1.4s ease-in-out infinite}
.blink{animation:blink .9s ease-in-out infinite}
`;
export const C={
  bg:"#040e1c",surface:"#0a1622",card:"#0e1c2e",card2:"#111e30",
  border:"#182b42",borderMid:"#1d3350",
  amber:"#f59e0b",amberD:"#d97706",amberF:"#1a1200",
  blue:"#4a8df0",blueF:"#06122a",
  green:"#0eb87a",greenF:"#001510",
  red:"#f04040",redF:"#1a0303",
  purple:"#a78bfa",purpleF:"#0e0920",
  cyan:"#22d3ee",cyanF:"#011820",
  teal:"#14b8a6",tealF:"#011814",
  rose:"#fb7185",roseF:"#1a0510",
  text:"#d5e6f2",dim:"#6e8daa",muted:"#384f65",
  mono:"'IBM Plex Mono',monospace",sans:"'IBM Plex Sans',sans-serif",
};

// Color maps keyed off C — status / priority / compensability / TD benefit type.
export const STATUS_CFG={pending:{label:"Awaiting AI",color:C.amber,bg:"#1a1100",bd:"#f59e0b33"},ai_complete:{label:"AI Ready",color:C.blue,bg:"#06122a",bd:"#4a8df033"},approved:{label:"Approved",color:C.green,bg:"#001510",bd:"#0eb87a33"},denied:{label:"Denied",color:C.red,bg:"#1a0303",bd:"#f0404033"},modified:{label:"Mod. Approved",color:C.purple,bg:"#0e0920",bd:"#a78bfa33"}};
export const PRI_COLOR={Critical:C.red,High:C.amber,Medium:C.blue,Low:C.dim};
export const COMP_COLOR={"Likely Compensable":C.green,"Questionable":C.amber,"Likely Non-Compensable":C.red};
export const TD_TYPE_COLOR={TTD:C.blue,TPD:C.teal,salary_continuation:C.purple};
export const TD_TYPE_BG   ={TTD:C.blueF,TPD:C.tealF,salary_continuation:C.purpleF};
