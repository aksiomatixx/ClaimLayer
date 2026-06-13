#!/usr/bin/env node
'use strict';

/**
 * capture-site-media.js — regenerate the marketing site's media from
 * the live static demo: the gallery screenshots and the captioned
 * product-tour video.
 *
 *   node scripts/capture-site-media.js stills   # website/assets/*.jpg
 *   node scripts/capture-site-media.js tour     # website/assets/tour.mp4 + poster.jpg
 *   node scripts/capture-site-media.js all
 *
 * Prereqs (devDependencies): playwright-core, @sparticuz/chromium
 * (Chromium shipped via npm — no CDN download), ffmpeg-static.
 * Serve the built site first:  python3 -m http.server 8080 -d ../website
 * (or set SITE_URL). Rebuild the demo (npm run build:demo) before
 * capturing so the media reflects the current seed.
 *
 * Implementation notes:
 *  - Stills go through raw CDP Page.captureScreenshot: Playwright's
 *    screenshot stability-wait can stall on the drawer overlay.
 *  - The tour is silent-with-captions by design (no narration track);
 *    captions are injected DOM styled to match the site.
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SITE   = process.env.SITE_URL || 'http://localhost:8080';
const ASSETS = path.resolve(__dirname, '../../website/assets');
const FFMPEG = require('ffmpeg-static');

const VW = 1600, VH = 900;

// Hard watchdog: a wedged renderer must never hang CI or a terminal.
const WATCHDOG = setTimeout(() => {
  console.error('✗ capture-site-media: watchdog expired (10 min) — aborting');
  process.exit(2);
}, 10 * 60 * 1000);

async function launch(extra = {}) {
  const chromium = require('@sparticuz/chromium').default;
  const { chromium: pw } = require('playwright-core');
  // Strip @sparticuz's ANGLE/SwiftShader GL flags and force plain
  // software compositing: the ANGLE raster path wedges stochastically
  // in this class of sandbox (frames stop; screenshots and recordings
  // hang). Verified against repeated drawer open/close cycles.
  const args = chromium.args
    .filter(a => !a.startsWith('--use-gl') && !a.startsWith('--use-angle'))
    .concat(['--disable-gpu', '--disable-gpu-compositing']);
  const browser = await pw.launch({
    executablePath: await chromium.executablePath(),
    args,
    headless: true,
  });
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, ...extra });
  // The drawer overlay's full-viewport backdrop blur re-rasterizes
  // every composite under SwiftShader — frames take so long that
  // screenshots and recordings wedge. Kill it for capture; the
  // rgba(.75) darkening still reads the same on camera.
  await ctx.addInitScript(() => {
    const s = document.createElement('style');
    s.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
    (document.head || document.documentElement).appendChild(s);
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  return { browser, ctx, page };
}

// Every interaction is best-effort with a short timeout: a missed
// selector should cost six seconds and a logged warning, not a hang.
async function act(label, fn) {
  try { await fn(); return true; }
  catch (e) { console.warn(`  ⚠ ${label}: ${String(e.message).split('\n')[0]}`); return false; }
}
const T = { timeout: 6000 };

async function settle(page, ms) { await page.waitForTimeout(ms); }

async function openDemo(page) {
  await page.goto(`${SITE}/demo/`, { waitUntil: 'networkidle' });
  await settle(page, 2600);
}

// ── Stills ───────────────────────────────────────────────────────────────────

async function captureStills() {
  console.log('capturing gallery stills…');
  const { browser, ctx, page } = await launch({ deviceScaleFactor: 2 });
  const cdp = await ctx.newCDPSession(page);
  const tmp = fs.mkdtempSync('/tmp/cl-stills-');

  // CDP capture with a hard per-shot deadline and one retry — a slow
  // composite must cost a skipped image, never a wedged run.
  const shot = async (name) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { data } = await Promise.race([
          cdp.send('Page.captureScreenshot', { format: 'png' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('shot deadline (25s)')), 25_000)),
        ]);
        const png = path.join(tmp, `${name}.png`);
        fs.writeFileSync(png, Buffer.from(data, 'base64'));
        // 2x PNG → 1600-wide JPG, in line with the existing gallery weights.
        execFileSync(FFMPEG, ['-y', '-i', png, '-vf', 'scale=1600:-2', '-q:v', '4',
          path.join(ASSETS, `${name}.jpg`)], { stdio: 'ignore' });
        console.log(`  ✓ ${name}.jpg`);
        return;
      } catch (e) {
        console.warn(`  ⚠ ${name} attempt ${attempt}: ${e.message}`);
        await settle(page, 1500);
      }
    }
    console.warn(`  ✗ ${name}.jpg SKIPPED`);
  };

  await openDemo(page);
  await shot('dashboard');

  await act('open All Claims', () => page.getByText('All Claims (14)').first().click(T));
  await settle(page, 900);
  await act('open D11 drawer', () => page.getByText('HHW-2026-D11', { exact: true }).first().click(T));
  await settle(page, 2400);
  await act('expand dry-run', () => page.locator('button:has-text("Complete action")').first().click(T));
  await settle(page, 1800);
  await shot('drawer');

  await act('benefits tab', () => page.locator('text=/^Benefits/').first().click(T));
  await settle(page, 1600);
  await shot('benefits');
  await act('close drawer', () => page.locator('button:has-text("✕")').first().click(T));
  await settle(page, 900);

  await act('RFAs view', () => page.locator('button:text-is("RFAs")').first().click(T));
  await settle(page, 2200);
  await shot('rfas');

  await act('Agents view', () => page.locator('button:text-is("Agents")').first().click(T));
  await settle(page, 2400);
  await shot('agents');

  await act('Integrations view', () => page.locator('button:text-is("Integrations")').first().click(T));
  await settle(page, 2400);
  await shot('integrations');

  await act('Architecture view', () => page.locator('button:text-is("Architecture")').first().click(T));
  await settle(page, 2600);
  await shot('architecture');

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Narration ────────────────────────────────────────────────────────────────
// Offline neural TTS: sherpa-onnx-node (npm) + a Piper voice pulled
// from the sherpa-onnx GitHub releases on first use (~64 MB, cached in
// frontend/.cache). If the voice can't be set up, the tour records
// silent-with-captions and says so.

// Override with TTS_VOICE (any vits-piper voice from the sherpa-onnx
// "tts-models" release, e.g. en_US-lessac-medium, en_US-amy-medium).
const VOICE     = process.env.TTS_VOICE || 'en_US-hfc_female-medium';
const VOICE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-${VOICE}.tar.bz2`;
const VOICE_DIR = path.resolve(__dirname, `../.cache/vits-piper-${VOICE}`);

const NARRATION = {
  intro:     "ClaimLayer runs AI agents on top of a workers' compensation claims system — with a licensed human at every consequential decision. Here's a quick tour of the live demo.",
  console:   'Every claim is triaged by AI into a ranked action queue — statutory deadlines computed, reserves suggested, priorities explained.',
  triage:    'Inbound documents classify themselves. A fax with no claim number is never silently filed — it waits for a human.',
  book:      'The demo book spans the whole lifecycle — intake, disability payments, MMI, litigation, and settlement.',
  drawer:    'A claim opens as a decision brief — what to decide, why, and the source documents, already summarized by the agent.',
  mmi:       'This claim is mid MMI. Treatment has plateaued, the PR-4 request is out, and permanent disability is estimated on the worksheet, pending the rating.',
  dryrun:    'Nothing commits blind. The adjuster sees exactly what completing will do — and the written rationale goes to the audit trail.',
  rfa:       "Treatment requests are checked against the state's treatment schedule. The agent can only approve, or route to physician review. Denial isn't in its vocabulary.",
  agents:    'Every model call is on the record — inputs, outputs, latency, confidence, and the guardrails it tripped.',
  guardrail: 'This settlement price came in thirty percent above the stipulated value. The premium cap flagged it for a human, instead of letting it through.',
  arch:      'The system documents itself. And the full source — tests, prompts, and the eval gate — is on GitHub.',
  outro:     'Bounded. Auditable. Reversible. Run it yourself at claimlayer dot org.',
};

function ensureVoice() {
  if (fs.existsSync(path.join(VOICE_DIR, 'tokens.txt'))) return true;
  try {
    console.log('  downloading narrator voice (one-time, ~64 MB)…');
    fs.mkdirSync(path.dirname(VOICE_DIR), { recursive: true });
    const tarball = `${VOICE_DIR}.tar.bz2`;
    execFileSync('curl', ['-sfL', '-o', tarball, VOICE_URL], { stdio: 'ignore' });
    execFileSync('tar', ['xjf', tarball, '-C', path.dirname(VOICE_DIR)], { stdio: 'ignore' });
    fs.rmSync(tarball, { force: true });
    return fs.existsSync(path.join(VOICE_DIR, 'tokens.txt'));
  } catch (e) {
    console.warn(`  ⚠ voice setup failed (${e.message}) — recording without narration`);
    return false;
  }
}

// Synthesize every line up front; returns { id: { wav, dur } } or null.
function synthesizeNarration(outDir) {
  if (!ensureVoice()) return null;
  let sherpa;
  try { sherpa = require('sherpa-onnx-node'); }
  catch { console.warn('  ⚠ sherpa-onnx-node not installed — recording without narration'); return null; }
  const tts = new sherpa.OfflineTts({
    model: {
      vits: {
        model:   path.join(VOICE_DIR, `${VOICE}.onnx`),
        tokens:  path.join(VOICE_DIR, 'tokens.txt'),
        dataDir: path.join(VOICE_DIR, 'espeak-ng-data'),
      },
      numThreads: 2,
    },
    maxNumSentences: 3,
  });
  const lines = {};
  for (const [id, text] of Object.entries(NARRATION)) {
    const audio = tts.generate({ text, sid: 0, speed: 0.95 });
    const wav = path.join(outDir, `${id}.wav`);
    sherpa.writeWave(wav, { samples: audio.samples, sampleRate: audio.sampleRate });
    lines[id] = { wav, dur: audio.samples.length / audio.sampleRate };
  }
  console.log(`  ✓ ${Object.keys(lines).length} narration lines synthesized`);
  return lines;
}

// ── Tour ─────────────────────────────────────────────────────────────────────

// Caption + cursor chrome, styled to the site (dark card, amber kicker).
const TOUR_CHROME = `
  (() => {
    const css = document.createElement('style');
    css.textContent = \`
      #cl-cursor{position:fixed;z-index:999999;width:22px;height:22px;border:2.5px solid #e8a33d;
        border-radius:50%;pointer-events:none;transform:translate(-50%,-50%);
        box-shadow:0 0 14px #e8a33d88;transition:width .12s,height .12s;left:-50px;top:-50px}
      #cl-cursor.click{width:34px;height:34px}
      #cl-caption{position:fixed;z-index:999998;left:50%;bottom:34px;transform:translateX(-50%);
        max-width:880px;background:rgba(7,16,29,.94);border:1px solid #24364f;border-radius:12px;
        padding:14px 22px;opacity:0;transition:opacity .45s;pointer-events:none;
        font-family:Inter,system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5)}
      #cl-caption .k{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.09em;
        color:#e8a33d;text-transform:uppercase;font-weight:700;margin-bottom:4px}
      #cl-caption .t{font-size:15.5px;color:#e8eef7;line-height:1.55}
      #cl-card{position:fixed;z-index:999997;inset:0;background:#050d19;display:flex;flex-direction:column;
        align-items:center;justify-content:center;opacity:0;transition:opacity .5s;pointer-events:none;
        font-family:Inter,system-ui,sans-serif}
      #cl-card .logo{width:52px;height:52px;border-radius:12px;display:flex;align-items:center;justify-content:center;
        background:linear-gradient(135deg,#e8a33d,#c07f1d);color:#000;font-family:'JetBrains Mono',monospace;
        font-weight:700;font-size:18px;margin-bottom:22px}
      #cl-card h1{font-size:40px;color:#e8eef7;font-weight:800;margin:0 0 10px;text-align:center}
      #cl-card h1 em{color:#e8a33d;font-style:normal}
      #cl-card p{font-size:16px;color:#8aa0bd;margin:4px 0;text-align:center}
      #cl-card .m{font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#e8a33d;margin-top:18px}
    \`;
    // Init scripts run at document start — body does not exist yet, so
    // all DOM setup is deferred behind an idempotent ensure().
    let cur, cap, card;
    function ensure() {
      if (cur || !document.body) return;
      (document.head || document.documentElement).appendChild(css);
      cur = document.createElement('div'); cur.id = 'cl-cursor'; document.body.appendChild(cur);
      addEventListener('mousemove', e => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
      addEventListener('mousedown', () => { cur.classList.add('click'); setTimeout(() => cur.classList.remove('click'), 240); }, true);
      cap = document.createElement('div'); cap.id = 'cl-caption';
      cap.innerHTML = '<div class="k"></div><div class="t"></div>'; document.body.appendChild(cap);
      card = document.createElement('div'); card.id = 'cl-card'; document.body.appendChild(card);
    }
    addEventListener('DOMContentLoaded', ensure);
    window.__cap = (kicker, text) => { ensure(); cap.querySelector('.k').textContent = kicker;
      cap.querySelector('.t').textContent = text; cap.style.opacity = '1'; };
    window.__capHide = () => { ensure(); cap.style.opacity = '0'; };
    window.__card = (html) => { ensure(); card.innerHTML = html; card.style.opacity = '1'; };
    window.__cardHide = () => { ensure(); card.style.opacity = '0'; };
  })();
`;

async function recordTour() {
  console.log('recording tour…');
  const dir = fs.mkdtempSync('/tmp/cl-tour-');
  // Synthesis happens BEFORE the browser launches — it is CPU-heavy and
  // must not steal cycles from the recording.
  const narration = synthesizeNarration(dir);
  const { browser, ctx, page } = await launch({
    recordVideo: { dir, size: { width: VW, height: VH } },
  });
  await ctx.addInitScript(TOUR_CHROME);

  // The recorder's clock starts with the page; narration offsets are
  // measured against it so each line can be placed on the timeline.
  const t0 = Date.now();
  const marks = [];
  const say = (id) => { if (narration && narration[id]) marks.push({ id, atMs: Date.now() - t0 }); };
  // Hold a beat at least minMs, and always long enough for its line.
  const hold = (id, minMs) =>
    settle(page, Math.max(minMs, narration && narration[id] ? narration[id].dur * 1000 + 700 : 0));

  const cap = (k, t) => page.evaluate(([k2, t2]) => window.__cap(k2, t2), [k, t]).catch(() => {});
  const capHide = () => page.evaluate(() => window.__capHide()).catch(() => {});
  const glide = async (x, y, steps = 22) => { await page.mouse.move(x, y, { steps }); };
  const wheel = async (dy, chunks = 8) => {
    for (let i = 0; i < chunks; i++) { await page.mouse.wheel(0, dy / chunks); await settle(page, 150); }
  };

  // The title card goes up the moment the DOM exists, covering the
  // app's loading flash; the demo finishes settling behind it.
  await page.goto(`${SITE}/demo/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__card(`
    <div class="logo">CL</div>
    <h1>AI agents for workers&#39; comp claims.<br/><em>A licensed human at every decision.</em></h1>
    <p>A quick tour of the live demo — synthetic data, real application.</p>
    <p class="m">claimlayer.org</p>`)).catch(() => {});
  say('intro');
  await hold('intro', 5200);
  await page.evaluate(() => window.__cardHide());
  await settle(page, 800);

  // Beat 1 — console + triage guardrail
  await cap('The adjuster console', 'Every claim AI-triaged into a ranked action queue — statutory deadlines computed, reserves suggested, priorities explained.');
  say('console');
  await glide(800, 430); await hold('console', 3800);
  await wheel(500); await settle(page, 1800); await wheel(-500);
  await cap('Inbound guardrail', 'A fax with no claim number is never silently filed — it waits in the human triage queue.');
  say('triage');
  await glide(700, 240); await hold('triage', 4600);
  await capHide(); await settle(page, 500);

  // Beat 2 — the book
  await act('all claims', () => page.getByText('All Claims (14)').first().click(T));
  await cap('The demo book', '14 synthetic claims spanning the whole lifecycle — intake, TD payments, MMI solicitation, PD rating, litigation, settlement, future medical.');
  say('book');
  await settle(page, 2200); await wheel(700); await hold('book', 2200); await wheel(-700);
  await capHide(); await settle(page, 500);

  // Beat 3 — drawer: decision brief + prepared actions
  await act('open D11', () => page.getByText('HHW-2026-D11', { exact: true }).first().click(T));
  await settle(page, 2200);
  await cap('The decision surface', 'The claim file opens as a decision brief: what to decide, why, and the source documents — already classified and summarized by the agent — one click away.');
  say('drawer');
  await glide(1050, 420); await hold('drawer', 6200);
  await cap('MMI in flight', 'This claim is mid-MMI: treatment plateaued, the PR-4 solicitation is out, the 30-day response clock is a diary — and PD is estimated on the worksheet pending the rating.');
  say('mmi');
  await hold('mmi', 6600);

  // Beat 4 — dry-run
  const opened = await act('dry-run', () => page.locator('button:has-text("Complete action")').first().click(T));
  if (opened) {
    await settle(page, 1600);
    await cap('Nothing commits blind', 'Before approving, the adjuster sees exactly what completing will do — and the decision rationale is required: it goes to the audit trail.');
    say('dryrun');
    await hold('dryrun', 6600);
    await act('cancel dry-run', () => page.locator('button:has-text("Cancel")').first().click(T));
  }
  await capHide();
  await act('close drawer', () => page.locator('button:has-text("✕")').first().click(T));
  await settle(page, 800);

  // Beat 5 — RFA guardrail
  await act('rfas', () => page.locator('button:text-is("RFAs")').first().click(T));
  await settle(page, 2200);
  await cap('No auto-deny, by construction', 'Treatment requests are evaluated against MTUS. The agent can only auto-approve or route to physician review — denial does not exist in its output schema.');
  say('rfa');
  await hold('rfa', 6600);
  await capHide();

  // Beat 6 — audit trail
  await act('agents', () => page.locator('button:text-is("Agents")').first().click(T));
  await settle(page, 2400);
  await cap('Every model call on the record', 'The agents console: every Claude call with its inputs, outputs, tokens, latency, confidence — and the guardrails it tripped.');
  say('agents');
  await hold('agents', 5600);
  await cap('Guardrails that held', 'This settlement pricing ran 30% above the stipulated value — the premium cap flagged it for the human instead of letting it through.');
  say('guardrail');
  await act('open cnr detail', () => page.getByText('cnr_pricing', { exact: true }).first().click(T));
  await hold('guardrail', 6200);
  await capHide();

  // Beat 7 — self-documenting
  await act('architecture', () => page.locator('button:text-is("Architecture")').first().click(T));
  await settle(page, 2600);
  await cap('The system documents itself', 'Agents, guardrails, and lifecycle — the architecture is a page in the product, and the full source is on GitHub.');
  say('arch');
  await wheel(700); await hold('arch', 3600);
  await capHide(); await settle(page, 400);

  // End card
  await page.evaluate(() => window.__card(`
    <div class="logo">CL</div>
    <h1>Bounded. Auditable. <em>Reversible.</em></h1>
    <p>Run it yourself — no install, no keys.</p>
    <p class="m">claimlayer.org/demo &nbsp;·&nbsp; github.com/aksiomatixx/ClaimLayer</p>`));
  say('outro');
  await hold('outro', 4600);

  await ctx.close();
  await browser.close();

  const webm = fs.readdirSync(dir).find(f => f.endsWith('.webm'));
  if (!webm) throw new Error('no webm produced');
  const src = path.join(dir, webm);
  const mp4 = path.join(ASSETS, 'tour.mp4');
  console.log('  encoding mp4…');
  const silent = path.join(dir, 'silent.mp4');
  execFileSync(FFMPEG, ['-y', '-i', src,
    '-c:v', 'libx264', '-crf', '23', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an', silent], { stdio: 'ignore' });

  if (narration && marks.length) {
    // Place each narration line on the timeline at the moment its beat
    // started, then mix them into one AAC track over the video.
    console.log(`  mixing ${marks.length} narration lines…`);
    const inputs = [];
    const delayed = [];
    marks.forEach((m, i) => {
      inputs.push('-i', narration[m.id].wav);
      const ms = Math.max(0, Math.round(m.atMs));
      delayed.push(`[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`);
    });
    const filter = `${delayed.join(';')};${marks.map((_, i) => `[a${i}]`).join('')}` +
      `amix=inputs=${marks.length}:normalize=0:dropout_transition=0,aresample=44100[mix]`;
    execFileSync(FFMPEG, ['-y', '-i', silent, ...inputs,
      '-filter_complex', filter, '-map', '0:v', '-map', '[mix]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', mp4], { stdio: 'ignore' });
  } else {
    fs.copyFileSync(silent, mp4);
  }

  // Poster: the title card, fully faded in.
  execFileSync(FFMPEG, ['-y', '-ss', '3', '-i', mp4, '-frames:v', '1', '-q:v', '4',
    path.join(ASSETS, 'poster.jpg')], { stdio: 'ignore' });
  const mb = (fs.statSync(mp4).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ tour.mp4 (${mb} MB, ${narration && marks.length ? 'narrated' : 'silent'}) + poster.jpg`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const mode = process.argv[2] || 'all';
  if (mode === 'stills' || mode === 'all') await captureStills();
  if (mode === 'tour' || mode === 'all') await recordTour();
  clearTimeout(WATCHDOG);
  console.log('✓ capture complete');
  process.exit(0);
})().catch((err) => {
  console.error('✗ capture-site-media failed:', err.message);
  process.exit(1);
});
