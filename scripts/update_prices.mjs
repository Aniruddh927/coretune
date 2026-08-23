'use strict';

/* ==========================================================================
   GreyWatt price updater
   --------------------------------------------------------------------------
   Finds the newest PDF in ../prices, extracts text, and updates the `price`
   field of each product in ../data/products.json that matches a search key.

   Matching: for each product, each string in `searchKeys` is looked up
   (case-insensitive) in the extracted text. The price is taken from the line
   containing the key (or the following line), preferring:
     1. a currency-denominated number  ($219, ₹12,999, €90 …)
     2. a decimal number               (219.00)
     3. the last standalone integer    (219)

   Run locally:
     npm install                (once, inside scripts/)
     node update_prices.mjs                 # apply
     node update_prices.mjs --dry-run       # preview only

   The GitHub Action runs this daily and on any push to prices/.
   ========================================================================== */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRICES_DIR = path.join(ROOT, 'prices');
const PRODUCTS_PATH = path.join(ROOT, 'data', 'products.json');
const LAST_PATH = path.join(PRICES_DIR, '.last_processed');

const DRY_RUN = process.argv.includes('--dry-run');

const CURRENCY = /(?:₹|rs\.?|inr|\$|usd|€|eur|£|gbp|৳|bdt)\s*(\d{1,3}(?:,\d{3})*)(?:\.(\d{1,2}))?/i;
const DECIMAL = /(?:^|\s)(\d{1,3}(?:,\d{3})*\.\d{1,2})(?=\s|$|[,;)\]}])/;
const INTEGER = /(?:^|\s)(\d{1,3}(?:,\d{3})*)(?=\s|$|[,;)\]}])/g;

async function newestPdf() {
  let entries = [];
  try {
    entries = await readdir(PRICES_DIR);
  } catch {
    return null;
  }
  const pdfs = entries.filter((n) => n.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 0) return null;

  let best = null;
  let bestMtime = -1;
  for (const name of pdfs) {
    const full = path.join(PRICES_DIR, name);
    try {
      const st = await stat(full);
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = { name, full }; }
    } catch { /* ignore */ }
  }
  return best;
}

async function extractText(full) {
  const buf = await readFile(full);
  const doc = await getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      text += ('str' in item ? item.str : '') + (item.hasEOL ? '\n' : ' ');
    }
    text += '\n';
  }
  await doc.destroy();
  return text;
}

function parseNum(int, frac) {
  const n = parseFloat(String(int).replace(/,/g, '') + (frac ? '.' + frac : ''));
  if (!Number.isFinite(n)) return null;
  // keep at most 2 decimals
  return Math.round(n * 100) / 100;
}

function extractPrice(line) {
  // 1) currency-denominated
  const c = line.match(CURRENCY);
  if (c) return parseNum(c[1], c[2]);
  // 2) decimal
  const d = line.match(DECIMAL);
  if (d) return parseNum(d[1]);
  // 3) last standalone integer
  let last = null;
  for (const m of line.matchAll(INTEGER)) last = parseNum(m[1]);
  return last;
}

function priceForProduct(lines, product) {
  const keys = (product.searchKeys || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  if (keys.length === 0) keys.push(String(product.name || '').toLowerCase());
  for (const key of keys) {
    if (!key) continue;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(key)) continue;
      // prefer the number after the key on this line, else fall back to whole line + next line
      const idx = lines[i].toLowerCase().indexOf(key);
      const after = lines[i].slice(idx);
      const price = extractPrice(after) || extractPrice(lines[i]) || (i + 1 < lines.length ? extractPrice(lines[i + 1]) : null);
      if (price != null && price > 0) return price;
    }
  }
  return null;
}

async function main() {
  const pdf = await newestPdf();
  if (!pdf) {
    console.log('No PDF found in prices/. Nothing to do.');
    return;
  }

  const buf = await readFile(pdf.full);
  const sha = createHash('sha256').update(buf).digest('hex');

  let last = null;
  try { last = JSON.parse(await readFile(LAST_PATH, 'utf8')); } catch { /* ignore */ }
  if (last && last.sha === sha) {
    console.log(`Prices already processed for ${pdf.name}. No change.`);
    return;
  }

  console.log(`Processing ${pdf.name} (sha ${sha.slice(0, 12)})…`);
  const text = await extractText(pdf.full);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const products = JSON.parse(await readFile(PRODUCTS_PATH, 'utf8'));
  if (!Array.isArray(products)) throw new Error('data/products.json must be an array');

  const report = { file: pdf.name, changed: [], unchanged: [], unmatched: [] };
  let changedCount = 0;

  for (const p of products) {
    const next = priceForProduct(lines, p);
    if (next == null) {
      report.unmatched.push(p.name);
      continue;
    }
    const old = Number(p.price);
    if (Math.abs(old - next) < 0.005) {
      report.unchanged.push({ name: p.name, price: next });
    } else {
      report.changed.push({ name: p.name, old, new: next });
      p.price = next;
      changedCount++;
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] no files written.');
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (changedCount > 0) {
    await writeFile(PRODUCTS_PATH, JSON.stringify(products, null, 2) + '\n', 'utf8');
  }
  await writeFile(LAST_PATH, JSON.stringify({ file: pdf.name, sha }, null, 2) + '\n', 'utf8');

  console.log(`\nUpdated ${changedCount} price(s), ${report.unchanged.length} unchanged, ${report.unmatched.length} unmatched.`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('Price update failed:', err);
  process.exit(1);
});
