#!/usr/bin/env node
'use strict';

/**
 * build-readme-page.js — render the repo README.md into an on-brand
 * static page at website/readme.html so the README is readable on the
 * marketing site without leaving it.
 *
 *   node frontend/scripts/build-readme-page.js
 *
 * Re-run whenever README.md changes (it is a copy, not a live include).
 *
 * Transforms applied so the page works off-GitHub:
 *  - repo-relative links (docs/…, backend/…, .github/…, supabase/…,
 *    frontend/…) → GitHub blob URLs on main, so they resolve.
 *  - the README's centered logo path → the site's own asset.
 *  - heading ids slugged (GitHub-style) so in-page anchors resolve.
 * Visual design mirrors index.html (same tokens, fonts, nav, footer).
 */

const fs   = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT   = path.resolve(__dirname, '../..');
const README = path.join(ROOT, 'README.md');
const OUT    = path.join(ROOT, 'website', 'readme.html');
const REPO   = 'https://github.com/aksiomatixx/ClaimLayer/blob/main/';

const REPO_DIRS = ['docs', 'backend', 'frontend', 'supabase', '.github', 'scripts', 'website'];

// GitHub-compatible heading slug. Note: each whitespace char maps to
// one hyphen WITHOUT collapsing runs, so "Status & scope" → after the
// "&" is stripped its surrounding spaces become "status--scope" — which
// matches the in-body anchor links the README itself uses.
function slug(text) {
  return String(text).toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

function buildBody() {
  let md = fs.readFileSync(README, 'utf8');

  // The README opens with a raw centered <div> + logo whose paths are
  // repo-relative; point the logo at the site asset.
  md = md.replace(/docs\/assets\/claimlayer-mark\.png/g, 'assets/mark.png');

  const renderer = new marked.Renderer();

  // Rewrite repo-relative links → GitHub blob; keep in-page (#) and
  // absolute (http, demo/) links as-is.
  const baseLink = renderer.link.bind(renderer);
  renderer.link = (token) => {
    let href = token.href || '';
    const isRepoRel = REPO_DIRS.some(d => href === d || href.startsWith(d + '/'));
    if (isRepoRel) token = { ...token, href: REPO + href };
    return baseLink(token);
  };

  // Slug heading ids for anchor targets.
  const baseHeading = renderer.heading.bind(renderer);
  renderer.heading = (token) => {
    const html = baseHeading(token);
    const id = slug(token.text);
    return html.replace(/^<(h[1-6])>/, `<$1 id="${id}">`);
  };

  return marked.parse(md, { renderer, gfm: true });
}

const PAGE = (body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>README — ClaimLayer</title>
<meta name="description" content="ClaimLayer README — what it is, what Akash Dixit owns, the problem it demonstrates, and where to see proof. A reference implementation on synthetic data."/>
<meta name="robots" content="index,follow"/>
<link rel="icon" href="assets/mark.png"/>
<style>
:root{
  --bg:#07101a; --surface:#0b1826; --card:#0e1f30; --border:#16293d; --border-mid:#23374e;
  --amber:#e8a33d; --amber-d:#b97b1f;
  --text:#eef3f8; --dim:#aebccb; --muted:#5d7185;
  --green:#3ecf8e; --blue:#58a6ff; --red:#f47067;
  --sans:'Inter','Segoe UI',system-ui,-apple-system,sans-serif;
  --mono:'JetBrains Mono','SFMono-Regular',Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:var(--amber);text-decoration:none}
a:hover{text-decoration:underline}
img{max-width:100%;display:block}
nav{position:sticky;top:0;z-index:100;background:rgba(7,16,26,.85);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.nav-i{max-width:920px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:18px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;color:var(--text);font-size:17px}
.brand img{width:28px;height:28px;border-radius:7px}
.nav-i .spacer{flex:1}
.nav-i a.link{color:var(--dim);font-size:14px;font-weight:600}
.nav-i a.link:hover{color:var(--text);text-decoration:none}
.btn{display:inline-block;background:var(--amber);color:#06101c;font-weight:700;font-size:13px;padding:8px 16px;border-radius:8px}
.btn.ghost{background:transparent;color:var(--dim);border:1px solid var(--border-mid)}
main{max-width:920px;margin:0 auto;padding:48px 24px 96px}
.banner{font-family:var(--mono);font-size:12.5px;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:40px}
.banner a{font-weight:700}
.md > div[align="center"]{text-align:center;margin-bottom:8px}
.md h1{font-size:clamp(30px,4vw,42px);font-weight:800;letter-spacing:-.5px;line-height:1.12;margin:0 0 18px;text-align:center}
.md h2{font-size:clamp(22px,2.6vw,28px);font-weight:800;letter-spacing:-.3px;margin:52px 0 16px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.md h3{font-size:18px;font-weight:700;margin:32px 0 12px}
.md p{color:var(--dim);margin:0 0 16px}
.md strong{color:var(--text);font-weight:700}
.md ul,.md ol{color:var(--dim);margin:0 0 18px;padding-left:24px}
.md li{margin:0 0 9px}
.md li::marker{color:var(--muted)}
.md code{font-family:var(--mono);font-size:.86em;background:var(--card);border:1px solid var(--border);border-radius:5px;padding:1.5px 6px;color:var(--text)}
.md pre{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 18px;overflow-x:auto;margin:0 0 20px}
.md pre code{background:none;border:none;padding:0;font-size:12.5px;color:var(--dim);line-height:1.6}
.md a{font-weight:600}
.md blockquote{border-left:3px solid var(--amber);background:var(--amber-d)11;padding:8px 18px;margin:0 0 18px;color:var(--dim)}
.md hr{border:none;border-top:1px solid var(--border);margin:40px 0}
.md table{width:100%;border-collapse:collapse;margin:0 0 22px;font-size:14px;display:block;overflow-x:auto}
.md th,.md td{border:1px solid var(--border);padding:9px 13px;text-align:left;color:var(--dim);vertical-align:top}
.md th{background:var(--surface);color:var(--text);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.md img{margin:0 auto 18px}
footer{border-top:1px solid var(--border);padding:28px 24px;text-align:center;color:var(--muted);font-size:13px}
footer a{font-weight:600}
@media (max-width:640px){ .nav-i a.link{display:none} }
</style>
</head>
<body>
<nav><div class="nav-i">
  <a class="brand" href="index.html"><img src="assets/mark.png" alt=""/>ClaimLayer</a>
  <div class="spacer"></div>
  <a class="link" href="index.html">← Site</a>
  <a class="link" href="demo/" target="_blank" rel="noopener">Live Demo</a>
  <a class="btn ghost" href="https://github.com/aksiomatixx/ClaimLayer" target="_blank" rel="noopener">GitHub ↗</a>
</div></nav>
<main>
  <div class="banner">This is a rendered copy of the project <a href="https://github.com/aksiomatixx/ClaimLayer/blob/main/README.md" target="_blank" rel="noopener">README</a> on GitHub. Source links open the repository.</div>
  <article class="md">
${body}
  </article>
</main>
<footer>
  Built by <b>Akash Dixit</b> · <a href="mailto:akashdixit@gmail.com">Email</a> · <a href="https://www.linkedin.com/in/akash-dixit-6835a522a" target="_blank" rel="noopener">LinkedIn</a> · <a href="index.html">ClaimLayer site</a>
</footer>
</body>
</html>
`;

fs.writeFileSync(OUT, PAGE(buildBody()));
// eslint-disable-next-line no-console
console.log(`✓ wrote ${path.relative(ROOT, OUT)}`);
