'use strict';

/**
 * pdfWriter.js — tiny page-cursor writer over pdf-lib, shared by the
 * synthetic document generators (generateTestDocuments.js and
 * generateDemoFilePdfs.js). Dependency: pdf-lib only — keep this module
 * free of service/config imports so the generators run offline.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;

const INK   = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.40, 0.40, 0.45);
const RULE  = rgb(0.72, 0.72, 0.76);

function fmtDate(iso) {
  const d = new Date(`${iso}`.includes('T') ? iso : `${iso}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

function money(n) {
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

class Writer {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.page = null;
    this.y = 0;
    this._newPage();
  }
  _newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }
  _ensure(height) {
    if (this.y - height < MARGIN) this._newPage();
  }
  _wrap(text, font, size, width) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(probe, size) > width && line) {
        lines.push(line);
        line = w;
      } else {
        line = probe;
      }
    }
    if (line) lines.push(line);
    return lines;
  }
  rule(gap = 10) {
    this._ensure(gap);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.6, color: RULE,
    });
    this.y -= gap;
  }
  letterhead(name, sub, contact) {
    this.text(name, { font: 'bold', size: 15 });
    if (sub) this.text(sub, { size: 9, color: MUTED });
    if (contact) this.text(contact, { size: 8.5, color: MUTED });
    this.y -= 4;
    this.rule(16);
  }
  title(text) {
    this._ensure(26);
    this.text(text.toUpperCase(), { font: 'bold', size: 12.5 });
    this.y -= 6;
  }
  text(text, { font = 'regular', size = 10, color = INK, indent = 0 } = {}) {
    const f = this.fonts[font];
    const width = PAGE_W - 2 * MARGIN - indent;
    for (const line of this._wrap(text, f, size, width)) {
      this._ensure(size + 4);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font: f, color });
      this.y -= size + 4;
    }
  }
  para(text, opts = {}) {
    this.text(text, opts);
    this.y -= 6;
  }
  fields(pairs) {
    const labelW = 150;
    for (const [label, value] of pairs) {
      this._ensure(14);
      this.page.drawText(`${label}:`, { x: MARGIN, y: this.y - 10, size: 9, font: this.fonts.bold, color: MUTED });
      const f = this.fonts.regular;
      const lines = this._wrap(value, f, 10, PAGE_W - 2 * MARGIN - labelW);
      for (let i = 0; i < lines.length; i++) {
        this._ensure(14);
        this.page.drawText(lines[i], { x: MARGIN + labelW, y: this.y - 10, size: 10, font: f, color: INK });
        this.y -= 14;
      }
    }
    this.y -= 6;
  }
  mono(lines, size = 8.5) {
    for (const line of lines) {
      this._ensure(size + 3.5);
      this.page.drawText(line, { x: MARGIN, y: this.y - size, size, font: this.fonts.mono, color: INK });
      this.y -= size + 3.5;
    }
    this.y -= 6;
  }
  checkbox(checked, label) {
    this._ensure(14);
    this.page.drawRectangle({
      x: MARGIN, y: this.y - 10, width: 8, height: 8,
      borderWidth: 0.8, borderColor: INK,
    });
    if (checked) {
      this.page.drawText('X', { x: MARGIN + 1.4, y: this.y - 9, size: 8, font: this.fonts.bold, color: INK });
    }
    this.page.drawText(label, { x: MARGIN + 14, y: this.y - 9.5, size: 9.5, font: this.fonts.regular, color: INK });
    this.y -= 15;
  }
  signature(name, role, date) {
    this.y -= 14;
    this._ensure(40);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y }, end: { x: MARGIN + 200, y: this.y },
      thickness: 0.8, color: INK,
    });
    this.y -= 12;
    this.text(`${name}${role ? ` — ${role}` : ''}`, { size: 9.5 });
    if (date) this.text(`Date: ${date}`, { size: 9.5, color: MUTED });
  }
  footer(note) {
    for (let i = 0; i < this.pdf.getPageCount(); i++) {
      const p = this.pdf.getPage(i);
      p.drawText(`${note}  —  page ${i + 1} of ${this.pdf.getPageCount()}`, {
        x: MARGIN, y: MARGIN - 22, size: 7.5, font: this.fonts.regular, color: MUTED,
      });
    }
  }
}

async function buildPdf(build, footerNote) {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold:    await pdf.embedFont(StandardFonts.HelveticaBold),
    mono:    await pdf.embedFont(StandardFonts.Courier),
  };
  const w = new Writer(pdf, fonts);
  build(w);
  w.footer(footerNote || 'SYNTHETIC DOCUMENT — ClaimLayer demo data, not a real claim');
  return pdf.save();
}

module.exports = { Writer, buildPdf, fmtDate, money, INK, MUTED, RULE };
