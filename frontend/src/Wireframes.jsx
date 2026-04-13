import { useState } from "react";

const F = `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:#f8f7f4;color:#1a1a1a}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.fade{animation:fadeIn 0.3s ease}
.pulse{animation:pulse 1.8s ease-in-out infinite}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#f0ede8}::-webkit-scrollbar-thumb{background:#c8bfb0;border-radius:2px}`;

const C = {
  bg: "#f8f7f4", surface: "#ffffff", surfaceAlt: "#f2efe9",
  border: "#e8e2d9", borderDark: "#d4ccc0",
  amber: "#e8850a", amberLight: "#fef3e2", amberDark: "#c4700a",
  blue: "#2563eb", blueLight: "#eff6ff",
  green: "#16a34a", greenLight: "#f0fdf4",
  red: "#dc2626", redLight: "#fef2f2",
  purple: "#7c3aed", purpleLight: "#f5f3ff",
  teal: "#0d9488", tealLight: "#f0fdfa",
  slate: "#64748b", slateLight: "#f8fafc",
  text: "#1a1a1a", textMid: "#4a4a4a", textMuted: "#8a8a8a",
  mono: "'JetBrains Mono', monospace",
  sans: "'Space Grotesk', sans-serif",
};

// ── STORIES ──────────────────────────────────────────────────────────────
const STORIES = {
  employer: {
    persona: "Sarah Chen",
    role: "HR Manager, BrightCare Home Health",
    avatar: "SC",
    color: C.blue,
    bg: C.blueLight,
    tagline: "300 caregivers. One injury on a Tuesday morning. Zero paperwork.",
    steps: [
      {
        id: "E1", label: "Injury Reported",
        screen: "employer-froi",
        narrative: "Maria, one of Sarah's best caregivers, hurt her back lifting a patient at 7:45 AM. Sarah opens her phone, logs into the BrightCare employer portal, and sees a one-tap option: Report New Injury. She doesn't need to know what a FROI is. She doesn't fill out 12 fields. She types the employee name, picks the injury type from a short list, and hits send.",
        systemResponse: "System pulls Maria's full ADP record instantly — name, DOB, address, phone, job title, hourly rate, average weekly wage, and calculated TD rate. Sarah didn't enter any of it.",
        time: "4 minutes"
      },
      {
        id: "E2", label: "Employee Notified",
        screen: "employer-link",
        narrative: "The system sends Maria a magic link by SMS and email. The message is in plain language: 'Your employer has started a workers' comp claim for you. Click here to complete your part — takes about 5 minutes.' The link expires in 72 hours and is pre-populated with everything from ADP.",
        systemResponse: "Sarah sees a real-time status update in her portal: 'Employee link sent — awaiting Maria's completion.'",
        time: "Automatic"
      },
      {
        id: "E3", label: "Appointment Booked",
        screen: "employer-status",
        narrative: "Thirty minutes later, Sarah's portal shows the claim is in motion: Maria completed her intake on her phone, described the injury by voice, uploaded a photo of the equipment involved, and booked a same-day appointment at Concentra Mid-Wilshire — 1.8 miles from her home zip code. Sarah didn't make a single phone call.",
        systemResponse: "Authorization code MPN-2026-4421 generated and sent to Concentra. DWC-1 sent to Maria's phone for e-signature.",
        time: "30 minutes total"
      },
      {
        id: "E4", label: "Claim Dashboard",
        screen: "employer-dashboard",
        narrative: "Over the following weeks, Sarah's employer dashboard shows her exactly where every open claim stands. She doesn't need to call an adjuster. She sees: claim status, next appointment date, current work status, TD benefit amount, and whether the worker has returned to work. Her experience mod is visible at the top. She can see it improving.",
        systemResponse: "All data sourced live from FileHandler. No manual reporting. No waiting for loss runs.",
        time: "Ongoing"
      }
    ]
  },
  employee: {
    persona: "Maria Santos",
    role: "Home Health Aide II, BrightCare",
    avatar: "MS",
    color: C.teal,
    bg: C.tealLight,
    tagline: "Hurt at work. Help arrived before she knew what to ask for.",
    steps: [
      {
        id: "W1", label: "Magic Link Received",
        screen: "employee-link",
        narrative: "Maria gets a text at 8:20 AM: 'BrightCare has started a workers' comp claim for your work injury today. Your rights are protected — you cannot be retaliated against for this claim. Click here to complete your information.' She's nervous. She's never been hurt at work before. The link opens in her browser — her name, address, and employer are already filled in.",
        systemResponse: "ADP data pre-populated. Maria only needs to describe what happened.",
        time: "1 tap"
      },
      {
        id: "W2", label: "Voice Intake",
        screen: "employee-voice",
        narrative: "The form has a big red microphone button: 'Tell us what happened in your own words.' Maria taps it and speaks for 90 seconds — she describes lifting Mr. Rodriguez, the pop she felt in her lower back, the immediate pain radiating down her left leg. The system transcribes it in real time. She reads it back, makes one small correction, and confirms.",
        systemResponse: "Voice transcript becomes the official mechanism of injury. Claude will use it for compensability analysis and DWC-1 pre-fill.",
        time: "2 minutes"
      },
      {
        id: "W3", label: "Photo Upload",
        screen: "employee-media",
        narrative: "The next screen asks: 'Do you have any photos or videos? Equipment involved, the location where it happened, or your injury.' Maria takes three photos — the mechanical lift that wasn't used, the patient's bathroom where transfers happen, and her lower back (covered). She uploads them from her camera roll.",
        systemResponse: "Media attached to claim file, pushed to FileHandler as supporting documentation.",
        time: "1 minute"
      },
      {
        id: "W4", label: "Doctor Selection",
        screen: "employee-provider",
        narrative: "The system shows Maria three doctors near her home zip code — all on the approved network, all accepting workers' comp. Each card shows the name, address, distance, rating, and available appointment slots. Concentra Mid-Wilshire has a slot today at 11:30 AM — 1.8 miles away. Maria taps it, picks the time, and gets an instant confirmation. She didn't Google anything. She didn't call anyone.",
        systemResponse: "Authorization code generated. Confirmation SMS sent. Facility notified via fax and portal. DWC-1 sent for e-signature.",
        time: "45 seconds"
      },
      {
        id: "W5", label: "Ongoing Status",
        screen: "employee-status",
        narrative: "Maria's portal becomes her claim home page. She sees: her claim number, her TD benefit amount ($500.50/week), her next appointment, and the current status. When her doctor submits a report, her portal updates. When a payment is sent, she gets a notification. When her appointment changes, she gets a text. She never has to wonder what's happening.",
        systemResponse: "All updates sourced from FileHandler and DxF feed. Maria's portal is always current.",
        time: "Real-time"
      }
    ]
  },
  admin: {
    persona: "Akash Kumar",
    role: "Owner & Supervising Adjuster, HomeCare TPA",
    avatar: "AK",
    color: C.amber,
    bg: C.amberLight,
    tagline: "120 active files. Every one of them moving without being touched.",
    steps: [
      {
        id: "A1", label: "Morning Review",
        screen: "admin-console",
        narrative: "Akash opens his console at 8 AM. He doesn't see a stack of new claims to process. He sees a ranked action queue — four items need his judgment today: one compensability decision on a disputed mechanism, one reserve increase recommendation on a surgical case, one URO determination he needs to communicate, one employer call flagged by the system as overdue. Everything else is moving automatically.",
        systemResponse: "AI has processed 14 new documents overnight, auto-approved 6 RFAs, generated 3 diaries, sent 2 Lob notices, and updated 9 reserve recommendations.",
        time: "8 AM review: 20 min"
      },
      {
        id: "A2", label: "AI Decision Review",
        screen: "admin-claim",
        narrative: "He clicks into Maria's claim. The AI reasoning document is already there — compensability 94%, recommended reserves $57,200, 4 action items, medical appointment confirmed, DWC-1 signed. He reads the AI narrative, agrees with the assessment, clicks Approve, adds a one-line note. Done. The system pushes the reserves to FileHandler, generates the acceptance notice, and queues it in Lob.",
        systemResponse: "Reserve set in FileHandler. DWC-7 notice queued. Employer notified. Diary updated.",
        time: "3 minutes"
      },
      {
        id: "A3", label: "RFA Queue",
        screen: "admin-rfa",
        narrative: "The RFA queue shows 8 requests this week. 5 are green — auto-approved by the system as MTUS-consistent, authorization letters already sent. 2 are yellow — within guidelines but Akash's review recommended before approval. 1 is red — surgical procedure outside MTUS parameters, packaged and sent to Enlyte UR with AI clinical summary attached. Akash clicks the two yellows, reads the AI rationale, approves both in under 4 minutes.",
        systemResponse: "5 auto-approvals logged. 2 adjuster approvals logged. 1 URO referral transmitted to Enlyte with clinical package.",
        time: "4 minutes"
      },
      {
        id: "A4", label: "Diary Dashboard",
        screen: "admin-diary",
        narrative: "The diary view shows 47 open diaries across 28 active files. 44 are green — on track, next action date in the future. 3 are amber — due today. One is a PR-2 follow-up on a file where the doctor is 4 days slow. The system already sent an automated fax yesterday. Akash sends a personal follow-up message through the portal. The other two are routine — he delegates them to his claims assistant through the system.",
        systemResponse: "All diaries generated automatically from claim events. No manual diary creation. Compliance rate: 98.7%.",
        time: "10 minutes"
      },
      {
        id: "A5", label: "Notice Center",
        screen: "admin-notices",
        narrative: "Three notices are queued for Lob today — one TD benefit notice, one DWC-7 for a new accepted claim, one delay notice on a claim still under investigation. All three were generated by the AI from claim data. Akash reviews each, confirms the recipient address from ADP, clicks Send. Lob will print, fold, stuff, and mail each one via USPS first class today.",
        systemResponse: "3 letters queued in Lob.com at $1.11 each. Tracking numbers returned and logged in FileHandler. Statutory deadline met.",
        time: "5 minutes"
      }
    ]
  }
};

// ── SCREEN WIREFRAMES ─────────────────────────────────────────────────────
function WireframeShell({ title, subtitle, children, topBar }) {
  return (
    <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,0.06)", width: "100%", maxWidth: 540 }}>
      {/* Browser chrome */}
      <div style={{ background: "#e8e2d9", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", gap: 5 }}>
          {["#ff6b6b","#ffd93d","#6bcb77"].map(c => <div key={c} style={{ width: 10, height: 10, borderRadius: "50%", background: c }} />)}
        </div>
        <div style={{ background: C.surface, borderRadius: 4, padding: "3px 12px", fontSize: 10, color: C.textMuted, fontFamily: C.mono, flex: 1, textAlign: "center" }}>homecare-tpa.com</div>
      </div>
      {/* Top nav bar */}
      {topBar !== false && (
        <div style={{ background: "#1a1a1a", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 24, height: 24, background: C.amber, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#000" }}>H</div>
            <span style={{ fontFamily: C.mono, fontSize: 11, color: "#fff", fontWeight: 600 }}>HomeCare TPA</span>
          </div>
          <div style={{ fontSize: 10, fontFamily: C.mono, color: "#888" }}>{subtitle}</div>
        </div>
      )}
      {/* Content */}
      <div style={{ padding: 18 }}>
        {title && <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, color: C.text }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

function WireBox({ h = 32, label, color, accent, children, style = {} }) {
  return (
    <div style={{ background: color || C.surfaceAlt, border: `1.5px dashed ${accent || C.borderDark}`, borderRadius: 7, minHeight: h, padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: accent || C.textMuted, fontFamily: C.mono, textAlign: "center", ...style }}>
      {children || label}
    </div>
  );
}

function WireBtn({ label, primary, small, full }) {
  return (
    <div style={{ background: primary ? C.amber : C.surface, border: `1.5px solid ${primary ? C.amber : C.borderDark}`, borderRadius: 7, padding: small ? "6px 14px" : "10px 18px", fontSize: small ? 11 : 12, fontWeight: 700, color: primary ? "#000" : C.textMuted, cursor: "pointer", textAlign: "center", fontFamily: C.sans, width: full ? "100%" : "auto", display: "inline-block" }}>{label}</div>
  );
}

function WireInput({ label, value, placeholder }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9, fontFamily: C.mono, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>{label}</div>
      <div style={{ background: C.surfaceAlt, border: `1.5px solid ${C.border}`, borderRadius: 6, padding: "8px 11px", fontSize: 12, color: value ? C.textMid : C.textMuted, fontStyle: value ? "normal" : "italic" }}>{value || placeholder || "..."}</div>
    </div>
  );
}

function WireTag({ label, color, bg }) {
  return <span style={{ background: bg || C.surfaceAlt, color: color || C.textMuted, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontFamily: C.mono, fontWeight: 600, border: `1px solid ${color ? color+"44" : C.border}` }}>{label}</span>;
}

// ── INDIVIDUAL SCREEN WIREFRAMES ──────────────────────────────────────────
const SCREENS = {
  "employer-froi": () => (
    <WireframeShell title="Report New Injury" subtitle="Employer Portal">
      <WireInput label="Employee Name" value="Maria Santos" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <WireInput label="Date of Injury" value="04/01/2026" />
        <WireInput label="Body Part" value="Lower Back" />
      </div>
      <WireInput label="Injury Type" value="Lifting Injury" />
      <div style={{ background: C.tealLight, border: `1.5px solid ${C.teal}44`, borderRadius: 7, padding: "8px 12px", marginBottom: 12, fontSize: 11, color: C.teal, display: "flex", alignItems: "center", gap: 8 }}>
        <span>✓</span> ADP data auto-populated — AWW $750.75 · TD Rate $500.50/wk
      </div>
      <WireInput label="What happened?" placeholder="Brief description of the injury..." />
      <WireBtn label="Submit & Send Employee Link →" primary full />
    </WireframeShell>
  ),
  "employer-link": () => (
    <WireframeShell title="Send Employee Claim Link" subtitle="Employer Portal">
      <div style={{ background: C.amberLight, border: `1.5px solid ${C.amber}44`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12, color: C.amberDark, lineHeight: 1.6 }}>
        Maria Santos will receive a secure link pre-populated with her ADP information. She only needs to describe what happened.
      </div>
      <WireInput label="Employee Email" value="m.santos@brightcare.com" />
      <WireInput label="Employee Phone" value="(213) 555-0142" />
      <WireBtn label="Generate & Send Magic Link" primary full />
      <div style={{ marginTop: 12, background: C.greenLight, border: `1.5px solid ${C.green}44`, borderRadius: 7, padding: 10 }}>
        <div style={{ fontSize: 10, fontFamily: C.mono, color: C.green, marginBottom: 4 }}>✓ LINK GENERATED</div>
        <div style={{ fontSize: 10, fontFamily: C.mono, color: C.textMuted, wordBreak: "break-all" }}>homecare-tpa.com/claim?t=eyJhbGci...</div>
        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>Expires in 72 hours · Single use · SMS + Email sent</div>
      </div>
    </WireframeShell>
  ),
  "employer-status": () => (
    <WireframeShell title="Claim Progress" subtitle="Employer Portal">
      {[
        { label: "FROI Submitted", status: "done", time: "8:02 AM" },
        { label: "Employee Link Sent", status: "done", time: "8:02 AM" },
        { label: "Employee Intake Complete", status: "done", time: "8:31 AM" },
        { label: "Medical Appointment Booked", status: "done", time: "8:33 AM" },
        { label: "AI Analysis Running", status: "active", time: "In progress" },
        { label: "Adjuster Review", status: "pending", time: "—" },
      ].map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <div style={{ width: 22, height: 22, borderRadius: "50%", background: s.status === "done" ? C.green : s.status === "active" ? C.amber : C.surfaceAlt, border: `2px solid ${s.status === "done" ? C.green : s.status === "active" ? C.amber : C.borderDark}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: s.status === "done" ? "#fff" : s.status === "active" ? "#000" : C.textMuted }}>{s.status === "done" ? "✓" : s.status === "active" ? "⟳" : "○"}</div>
          <div style={{ flex: 1, fontSize: 12, color: s.status === "pending" ? C.textMuted : C.text, fontWeight: s.status === "done" ? 500 : 400 }}>{s.label}</div>
          <div style={{ fontSize: 10, fontFamily: C.mono, color: C.textMuted }}>{s.time}</div>
        </div>
      ))}
    </WireframeShell>
  ),
  "employer-dashboard": () => (
    <WireframeShell title="Active Claims" subtitle="Employer Portal — BrightCare Home Health">
      <div style={{ background: C.amberLight, borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ fontSize: 10, fontFamily: C.mono, color: C.textMuted, marginBottom: 2 }}>EXPERIENCE MOD</div><div style={{ fontSize: 22, fontWeight: 700, fontFamily: C.mono, color: C.amber }}>0.87</div></div>
        <div><div style={{ fontSize: 10, fontFamily: C.mono, color: C.textMuted, marginBottom: 2 }}>OPEN CLAIMS</div><div style={{ fontSize: 22, fontWeight: 700, fontFamily: C.mono }}>6</div></div>
        <div><div style={{ fontSize: 10, fontFamily: C.mono, color: C.textMuted, marginBottom: 2 }}>OFF WORK</div><div style={{ fontSize: 22, fontWeight: 700, fontFamily: C.mono, color: C.red }}>2</div></div>
      </div>
      {[
        { name: "Maria Santos", part: "Lower Back", status: "Active", off: true, next: "Apr 15" },
        { name: "James Okonkwo", part: "Right Hand", status: "Active", off: false, next: "Apr 18" },
        { name: "Lupe Hernandez", part: "Left Knee", status: "Post-Surgery", off: true, next: "Apr 22" },
      ].map((c, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: i < 2 ? `1px solid ${C.border}` : "none" }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: C.surfaceAlt, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: C.textMuted }}>{c.name.split(" ").map(n => n[0]).join("")}</div>
          <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{c.name}</div><div style={{ fontSize: 11, color: C.textMuted }}>{c.part}</div></div>
          <div style={{ textAlign: "right" }}><WireTag label={c.off ? "Off Work" : "Working"} color={c.off ? C.red : C.green} /><div style={{ fontSize: 10, color: C.textMuted, marginTop: 3 }}>Next: {c.next}</div></div>
        </div>
      ))}
    </WireframeShell>
  ),
  "employee-link": () => (
    <WireframeShell title="" subtitle="" topBar={false}>
      <div style={{ textAlign: "center", padding: "12px 0 18px" }}>
        <div style={{ width: 48, height: 48, background: C.amberLight, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", fontSize: 24 }}>🛡️</div>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Your Work Injury Claim</div>
        <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.65, marginBottom: 16 }}>BrightCare Home Health has started a workers' compensation claim for your injury. Your rights are fully protected — you cannot be penalized for this claim.</div>
      </div>
      <div style={{ background: C.greenLight, border: `1.5px solid ${C.green}44`, borderRadius: 8, padding: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontFamily: C.mono, color: C.green, marginBottom: 4 }}>✓ YOUR INFORMATION IS PRE-FILLED</div>
        <div style={{ fontSize: 11, color: C.textMid }}>Maria Santos · (213) 555-0142 · 1842 W 7th St, LA 90057</div>
      </div>
      <WireBtn label="Complete My Claim — Takes 5 Minutes →" primary full />
      <div style={{ fontSize: 10, color: C.textMuted, textAlign: "center", marginTop: 10 }}>This link expires in 72 hours and can only be used once</div>
    </WireframeShell>
  ),
  "employee-voice": () => (
    <WireframeShell title="Describe Your Injury" subtitle="Step 2 of 4">
      <div style={{ fontSize: 12, color: C.textMid, marginBottom: 14, lineHeight: 1.65 }}>Tell us what happened in your own words. You can speak or type.</div>
      <div style={{ background: "#fff0f0", border: "2px solid #dc2626", borderRadius: 10, padding: 16, marginBottom: 14, textAlign: "center" }}>
        <div style={{ fontSize: 28, marginBottom: 6 }}>🎙</div>
        <div style={{ fontFamily: C.mono, fontSize: 11, color: C.red, fontWeight: 600, marginBottom: 4 }}>● RECORDING — 0:47</div>
        <div style={{ display: "flex", gap: 3, justifyContent: "center" }}>
          {[8,14,10,18,12,16,10,14,8,12,16,10,18,12,8].map((h, i) => (
            <div key={i} className="pulse" style={{ width: 3, height: h, background: C.red, borderRadius: 2, animationDelay: `${i * 0.07}s` }} />
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>Listening... speak clearly</div>
      </div>
      <div style={{ background: C.surfaceAlt, border: `1.5px solid ${C.border}`, borderRadius: 7, padding: 10, marginBottom: 14, fontSize: 12, color: C.textMid, lineHeight: 1.7, fontStyle: "italic" }}>
        "I was doing the morning transfer for Mr. Rodriguez — moving him from the bed to the wheelchair. He's 185 pounds and the mechanical lift wasn't available. I felt a sharp pop in my lower back and immediately had pain shooting down my left leg..."
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <WireBtn label="■ Stop & Save" primary />
        <WireBtn label="Type Instead" />
      </div>
    </WireframeShell>
  ),
  "employee-media": () => (
    <WireframeShell title="Photos & Videos" subtitle="Step 2 of 4 — Optional">
      <div style={{ fontSize: 12, color: C.textMid, marginBottom: 14, lineHeight: 1.65 }}>Photos of the location, equipment, or your injury help support your claim. This is optional.</div>
      <div style={{ border: "2px dashed #d4ccc0", borderRadius: 9, padding: 20, textAlign: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 24, marginBottom: 6 }}>📎</div>
        <div style={{ fontSize: 12, color: C.textMuted }}>Tap to take a photo or upload from your camera roll</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
        {["🏗️ Equipment","📍 Location","🩹 Injury"].map((label, i) => (
          <div key={i} style={{ aspectRatio: "1", background: C.surfaceAlt, border: `1.5px solid ${C.border}`, borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
            <div style={{ fontSize: 20 }}>{label.split(" ")[0]}</div>
            <div style={{ fontSize: 9, color: C.textMuted, fontFamily: C.mono }}>{label.split(" ")[1]}</div>
          </div>
        ))}
      </div>
      <WireBtn label="Continue →" primary full />
    </WireframeShell>
  ),
  "employee-provider": () => (
    <WireframeShell title="Choose Your Doctor" subtitle="Step 3 of 4 — Near 90057">
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>3 approved providers near your home. All accept workers' comp.</div>
      {[
        { name: "Concentra Urgent Care", branch: "Mid-Wilshire", dist: "1.8 mi", rating: "★ 4.2", today: true, selected: true },
        { name: "Kaiser Occ Health", branch: "West LA", dist: "3.1 mi", rating: "★ 4.5", today: false, selected: false },
        { name: "UCLA Occ Health", branch: "Westwood", dist: "4.7 mi", rating: "★ 4.7", today: false, selected: false },
      ].map((p, i) => (
        <div key={i} style={{ border: `2px solid ${p.selected ? C.amber : C.border}`, borderRadius: 9, padding: 12, marginBottom: 10, background: p.selected ? C.amberLight : C.surface }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: p.selected ? 10 : 0 }}>
            <div><div style={{ fontSize: 12, fontWeight: 700 }}>{p.name}</div><div style={{ fontSize: 11, color: C.textMuted }}>{p.branch} · {p.dist} · {p.rating}</div></div>
            {p.today && <WireTag label="Today" color={C.green} />}
          </div>
          {p.selected && (
            <div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {["Today","Tomorrow","Thu Apr 14"].map((d, j) => (
                  <div key={j} style={{ background: j === 0 ? C.amber : C.surface, border: `1px solid ${j === 0 ? C.amber : C.border}`, borderRadius: 5, padding: "4px 10px", fontSize: 11, fontWeight: j === 0 ? 700 : 400, color: j === 0 ? "#000" : C.textMuted, cursor: "pointer" }}>{d}</div>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {["9:00 AM","9:30 AM","10:00 AM","11:30 AM","1:00 PM","2:30 PM"].map((t, j) => (
                  <div key={j} style={{ background: j === 3 ? C.blue : C.surface, border: `1px solid ${j === 3 ? C.blue : C.border}`, borderRadius: 5, padding: "4px 10px", fontSize: 11, color: j === 3 ? "#fff" : C.textMuted, cursor: "pointer" }}>{t}</div>
                ))}
              </div>
              <div style={{ marginTop: 10 }}><WireBtn label="Book 11:30 AM Today →" primary full /></div>
            </div>
          )}
        </div>
      ))}
    </WireframeShell>
  ),
  "employee-status": () => (
    <WireframeShell title="My Claim" subtitle="Maria Santos">
      <div style={{ background: C.greenLight, border: `1.5px solid ${C.green}44`, borderRadius: 8, padding: 12, marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
        <div><div style={{ fontSize: 10, fontFamily: C.mono, color: C.green, marginBottom: 2 }}>CLAIM ACCEPTED</div><div style={{ fontSize: 11, color: C.textMid }}>HHW-2026-041</div></div>
        <div style={{ textAlign: "right" }}><div style={{ fontSize: 10, fontFamily: C.mono, color: C.textMuted, marginBottom: 2 }}>TD BENEFIT</div><div style={{ fontSize: 16, fontFamily: C.mono, fontWeight: 700, color: C.green }}>$500.50/wk</div></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        {[
          { label: "NEXT APPOINTMENT", value: "Apr 15 · Concentra", accent: C.blue },
          { label: "WORK STATUS", value: "Off Work — until Apr 22", accent: C.red },
          { label: "LAST PAYMENT", value: "Apr 8 — $500.50", accent: C.green },
          { label: "ADJUSTER", value: "Akash Kumar · (800) 555-0190", accent: C.textMid },
        ].map((item, i) => (
          <div key={i} style={{ background: C.surfaceAlt, borderRadius: 7, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, fontFamily: C.mono, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{item.label}</div>
            <div style={{ fontSize: 11, color: item.accent, fontWeight: 500, lineHeight: 1.4 }}>{item.value}</div>
          </div>
        ))}
      </div>
      <WireBtn label="Contact My Adjuster" full />
    </WireframeShell>
  ),
  "admin-console": () => (
    <WireframeShell title="Good morning, Akash" subtitle="Admin Console">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 16 }}>
        {[["120","Active Files","#1a1a1a"],["4","Need You Today",C.amber],["98.7%","Diary Compliance",C.green],["$2.1M","Managed Reserves",C.blue]].map(([v,l,c],i) => (
          <div key={i} style={{ background: C.surfaceAlt, borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 18, fontFamily: C.mono, fontWeight: 700, color: c, lineHeight: 1 }}>{v}</div>
            <div style={{ fontSize: 9, color: C.textMuted, marginTop: 4 }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, fontFamily: C.mono, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>Action Queue — Your Judgment Required</div>
      {[
        { type: "Compensability Decision", claim: "HHW-2026-047", priority: "high", label: "Disputed mechanism — unusual fact pattern" },
        { type: "Reserve Increase", claim: "HHW-2026-035", priority: "high", label: "Surgical confirmation — increase to $82k recommended" },
        { type: "URO Determination", claim: "HHW-2026-038", priority: "medium", label: "Enlyte approved PT — communicate to provider" },
        { type: "Employer Call", claim: "BrightCare", priority: "low", label: "30-day check-in overdue — flagged by system" },
      ].map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: i < 3 ? `1px solid ${C.border}` : "none" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: item.priority === "high" ? C.red : item.priority === "medium" ? C.amber : C.textMuted, flexShrink: 0 }} />
          <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{item.type}</div><div style={{ fontSize: 11, color: C.textMuted }}>{item.claim} · {item.label}</div></div>
          <WireBtn small label="Review" />
        </div>
      ))}
    </WireframeShell>
  ),
  "admin-claim": () => (
    <WireframeShell title="HHW-2026-041 — Maria Santos" subtitle="Admin Review">
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <WireTag label="Likely Compensable" color={C.green} /><WireTag label="94% Confidence" color={C.blue} /><WireTag label="High Priority" color={C.amber} />
      </div>
      <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontFamily: C.mono, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>AI Suggested Reserves</div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          {[["Medical","$35,000"],["Indemnity","$22,000"],["Expense","$3,200"],["Total","$60,200"]].map(([l,v],i)=>(
            <div key={i} style={{ textAlign: i === 3 ? "right" : "left" }}><div style={{ fontSize: 10, color: C.textMuted }}>{l}</div><div style={{ fontSize: 14, fontFamily: C.mono, fontWeight: i===3?700:500, color: i===3?C.blue:C.text }}>{v}</div></div>
          ))}
        </div>
      </div>
      <WireBox h={60} label="AI Analysis Narrative — 3 paragraph summary of compensability rationale, red flags, and recommended actions" color="#fffbf0" accent={C.amber} />
      <div style={{ marginTop: 12 }}>
        <WireInput label="Supervisor Note (optional)" placeholder="Add a note before approving..." />
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <WireBtn label="✓ Approve AI Recommendation" primary />
          <WireBtn label="✎ Modify" />
          <WireBtn label="✕ Deny" />
        </div>
      </div>
    </WireframeShell>
  ),
  "admin-rfa": () => (
    <WireframeShell title="RFA Queue — This Week" subtitle="Utilization Review">
      {[
        { treatment: "Physical Therapy — 8 visits", claim: "HHW-2026-041", status: "auto", label: "MTUS-consistent · L4-L5 strain", statusColor: C.green },
        { treatment: "MRI — Lumbar Spine", claim: "HHW-2026-041", status: "auto", label: "MTUS-consistent · Radiculopathy symptoms", statusColor: C.green },
        { treatment: "Orthopedic Consult", claim: "HHW-2026-035", status: "review", label: "Guideline-consistent — adjuster confirm", statusColor: C.amber },
        { treatment: "Arthroscopic Meniscus Repair", claim: "HHW-2026-035", status: "uro", label: "Surgical — forwarded to Enlyte UR", statusColor: C.blue },
      ].map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: i < 3 ? `1px solid ${C.border}` : "none" }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: r.statusColor, flexShrink: 0 }} />
          <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{r.treatment}</div><div style={{ fontSize: 11, color: C.textMuted }}>{r.claim} · {r.label}</div></div>
          <WireTag label={r.status === "auto" ? "Auto-Approved" : r.status === "uro" ? "Sent to URO" : "Review"} color={r.statusColor} />
        </div>
      ))}
      <div style={{ background: C.surfaceAlt, borderRadius: 7, padding: 10, marginTop: 12, display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: C.textMuted }}>This week: 5 auto-approved · 1 adjuster approved · 1 to URO</span>
        <span style={{ fontSize: 11, fontFamily: C.mono, color: C.green }}>URO cost: $65</span>
      </div>
    </WireframeShell>
  ),
  "admin-diary": () => (
    <WireframeShell title="Diary Dashboard" subtitle="47 open across 28 files">
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["44","On Track",C.green],["3","Due Today",C.amber],["0","Overdue",C.textMuted]].map(([v,l,c],i)=>(
          <div key={i} style={{ flex:1, background: C.surfaceAlt, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontFamily: C.mono, fontWeight: 700, color: c }}>{v}</div>
            <div style={{ fontSize: 10, color: C.textMuted }}>{l}</div>
          </div>
        ))}
      </div>
      {[
        { type: "PR-2 Follow-up", claim: "HHW-2026-041", due: "Today", owner: "System", flag: "amber", note: "Automated fax sent — awaiting response" },
        { type: "Work Status Expiry", claim: "HHW-2026-038", due: "Today", owner: "Assistant", flag: "amber", note: "Verify RTW or extend TD" },
        { type: "TD Payment Due", claim: "HHW-2026-035", due: "Today", owner: "System", flag: "amber", note: "Next payment cycle — auto-generating" },
        { type: "Next Appointment", claim: "HHW-2026-041", due: "Apr 15", owner: "System", flag: "green", note: "Concentra — confirmed" },
      ].map((d, i) => (
        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 0", borderBottom: i < 3 ? `1px solid ${C.border}` : "none" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: d.flag === "amber" ? C.amber : C.green, flexShrink: 0, marginTop: 4 }} />
          <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{d.type}</div><div style={{ fontSize: 11, color: C.textMuted }}>{d.claim} · {d.note}</div></div>
          <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 11, fontFamily: C.mono, fontWeight: 600, color: d.flag === "amber" ? C.amber : C.textMuted }}>{d.due}</div><div style={{ fontSize: 10, color: C.textMuted }}>{d.owner}</div></div>
        </div>
      ))}
    </WireframeShell>
  ),
  "admin-notices": () => (
    <WireframeShell title="Notice Center" subtitle="Print & Mail via Lob.com">
      {[
        { type: "DWC-7 — Notice of Representation", claim: "HHW-2026-041 · Maria Santos", status: "queued", cost: "$1.11" },
        { type: "TD Benefit Notice", claim: "HHW-2026-041 · Maria Santos", status: "queued", cost: "$1.11" },
        { type: "Delay Notice — 14 Days", claim: "HHW-2026-047 · Rosa Gutierrez", status: "queued", cost: "$1.11" },
      ].map((n, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: i < 2 ? `1px solid ${C.border}` : "none" }}>
          <div style={{ fontSize: 18 }}>📮</div>
          <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{n.type}</div><div style={{ fontSize: 11, color: C.textMuted }}>{n.claim}</div></div>
          <div style={{ textAlign: "right" }}><WireTag label={n.status} color={C.teal} /><div style={{ fontSize: 10, fontFamily: C.mono, color: C.green, marginTop: 3 }}>{n.cost}</div></div>
        </div>
      ))}
      <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
        <WireBtn label="Send All via Lob.com" primary />
        <WireBtn label="Preview PDF" />
      </div>
      <div style={{ background: C.tealLight, border: `1.5px solid ${C.teal}44`, borderRadius: 7, padding: 10, marginTop: 12, fontSize: 11, color: C.teal }}>
        ✓ Lob handles print, fold, envelope & USPS first-class delivery. Tracking logged to FileHandler automatically.
      </div>
    </WireframeShell>
  ),
};

// ── MAIN APP ──────────────────────────────────────────────────────────────
export default function App() {
  const [activePortal, setActivePortal] = useState("employer");
  const [activeStep, setActiveStep] = useState(0);

  const story = STORIES[activePortal];
  const step = story.steps[activeStep];
  const Screen = SCREENS[step.screen];

  return (
    <div style={{ fontFamily: C.sans, background: C.bg, minHeight: "100vh" }}>
      <style>{F}</style>

      {/* Header */}
      <div style={{ background: "#1a1a1a", padding: "18px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, background: C.amber, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: C.mono, fontWeight: 700, fontSize: 16, color: "#000" }}>H</div>
          <div><div style={{ fontFamily: C.mono, fontWeight: 600, fontSize: 14, color: "#fff" }}>HomeCare TPA</div><div style={{ fontSize: 10, color: "#888" }}>Product Wireframes & User Stories</div></div>
        </div>
        <div style={{ fontSize: 11, fontFamily: C.mono, color: "#888" }}>Confidential — For Technical Review</div>
      </div>

      {/* Portal Selector */}
      <div style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, padding: "0 32px", display: "flex", gap: 0 }}>
        {Object.entries(STORIES).map(([key, s]) => (
          <button key={key} onClick={() => { setActivePortal(key); setActiveStep(0); }} style={{ background: "none", border: "none", cursor: "pointer", padding: "16px 24px", fontFamily: C.sans, fontSize: 13, fontWeight: 700, color: activePortal === key ? C.text : C.textMuted, borderBottom: `3px solid ${activePortal === key ? C.amber : "transparent"}`, transition: "all 0.15s", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: activePortal === key ? s.color : C.surfaceAlt, color: activePortal === key ? "#fff" : C.textMuted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, transition: "all 0.15s" }}>{s.avatar}</div>
            {s.persona}
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 32px" }}>

        {/* Story Header */}
        <div style={{ background: story.bg, border: `1.5px solid ${story.color}33`, borderRadius: 14, padding: "20px 28px", marginBottom: 28, display: "flex", alignItems: "flex-start", gap: 20 }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: story.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{story.avatar}</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 2 }}>{story.persona}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>{story.role}</div>
            <div style={{ fontSize: 14, color: story.color, fontWeight: 600, fontStyle: "italic" }}>"{story.tagline}"</div>
          </div>
        </div>

        {/* Step Navigation */}
        <div style={{ display: "flex", gap: 8, marginBottom: 28, overflowX: "auto", paddingBottom: 4 }}>
          {story.steps.map((s, i) => (
            <button key={s.id} onClick={() => setActiveStep(i)} style={{ background: activeStep === i ? "#1a1a1a" : C.surface, border: `1.5px solid ${activeStep === i ? "#1a1a1a" : C.border}`, borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontFamily: C.sans, fontSize: 12, fontWeight: 600, color: activeStep === i ? "#fff" : C.textMuted, whiteSpace: "nowrap", transition: "all 0.15s", display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 20, height: 20, borderRadius: "50%", background: activeStep === i ? story.color : C.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: activeStep === i ? "#fff" : C.textMuted, fontFamily: C.mono, fontWeight: 700 }}>{i + 1}</span>
              {s.label}
            </button>
          ))}
        </div>

        {/* Active Step */}
        <div className="fade" key={step.id} style={{ display: "grid", gridTemplateColumns: "1fr 480px", gap: 28, alignItems: "start" }}>

          {/* Left — Story + System Response */}
          <div>
            <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: 24, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: story.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#fff" }}>{story.avatar}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{step.label}</div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{story.persona} · {step.time}</div>
                </div>
              </div>
              <p style={{ fontSize: 13, color: C.textMid, lineHeight: 1.8 }}>{step.narrative}</p>
            </div>
            <div style={{ background: "#1a1a1a", borderRadius: 10, padding: 20 }}>
              <div style={{ fontSize: 10, fontFamily: C.mono, color: C.amber, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>⚡ System Response (Automated)</div>
              <p style={{ fontSize: 12, color: "#ccc", lineHeight: 1.75, fontFamily: C.mono }}>{step.systemResponse}</p>
            </div>
            {/* Navigation */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
              <button onClick={() => setActiveStep(Math.max(0, activeStep - 1))} disabled={activeStep === 0} style={{ background: "none", border: `1.5px solid ${C.border}`, borderRadius: 7, padding: "8px 18px", cursor: activeStep === 0 ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600, color: activeStep === 0 ? C.textMuted : C.text, fontFamily: C.sans, opacity: activeStep === 0 ? 0.4 : 1 }}>← Previous</button>
              <div style={{ fontSize: 11, fontFamily: C.mono, color: C.textMuted, alignSelf: "center" }}>{activeStep + 1} / {story.steps.length}</div>
              <button onClick={() => setActiveStep(Math.min(story.steps.length - 1, activeStep + 1))} disabled={activeStep === story.steps.length - 1} style={{ background: activeStep < story.steps.length - 1 ? "#1a1a1a" : "none", border: `1.5px solid ${activeStep < story.steps.length - 1 ? "#1a1a1a" : C.border}`, borderRadius: 7, padding: "8px 18px", cursor: activeStep === story.steps.length - 1 ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600, color: activeStep < story.steps.length - 1 ? "#fff" : C.textMuted, fontFamily: C.sans, opacity: activeStep === story.steps.length - 1 ? 0.4 : 1 }}>Next →</button>
            </div>
          </div>

          {/* Right — Wireframe */}
          <div style={{ position: "sticky", top: 24 }}>
            <div style={{ fontSize: 10, fontFamily: C.mono, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>Screen Wireframe — {step.id}</div>
            {Screen ? <Screen /> : <WireBox h={400} label={`[${step.screen}]`} />}
          </div>
        </div>
      </div>
    </div>
  );
}
