#!/usr/bin/env node
'use strict';

/**
 * finalize-demo.js — post-build step for `npm run build:demo`.
 *
 *   1. Publishes demo.html as the directory index (GitHub Pages serves
 *      website/demo/ at /demo/).
 *   2. Verifies the demo document PDFs made it into the output — they
 *      are build inputs from frontend/public-demo/files/, and a build
 *      that drops them ships a demo full of dead "Open original" links
 *      (Codex sweep G18 regression check).
 */

const fs   = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'website', 'demo');

const demoHtml = path.join(OUT, 'demo.html');
if (!fs.existsSync(demoHtml)) {
  console.error('✗ finalize-demo: website/demo/demo.html missing — did the build run?');
  process.exit(1);
}
fs.copyFileSync(demoHtml, path.join(OUT, 'index.html'));

const filesDir = path.join(OUT, 'files');
const pdfs = fs.existsSync(filesDir)
  ? fs.readdirSync(filesDir).filter(f => f.endsWith('.pdf'))
  : [];
if (pdfs.length === 0) {
  console.error('✗ finalize-demo: no document PDFs in website/demo/files/ — ' +
    'frontend/public-demo/files/ must hold the demo documents (vite publicDir copies them).');
  process.exit(1);
}

console.log(`✓ demo finalized: index.html published, ${pdfs.length} document PDFs present`);
