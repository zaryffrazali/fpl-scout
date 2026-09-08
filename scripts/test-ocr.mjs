#!/usr/bin/env node
// Regression test for the screenshot importer, run against REAL FPL screenshots.
//
//   npm i -D tesseract.js jimp @tesseract.js-data/eng
//   node scripts/test-ocr.mjs shots/*.png
//
// It exercises src/ocrSquad.js — the same file the app imports — so a pass here
// means the shipped parser works, not a copy of it. The browser does the image
// prep with a canvas; this does the equivalent with jimp.
//
// Result on the six screenshots used to develop it (Sep 2026): five resolve a
// full legal 15, one resolves 14 because Bentley (Coventry's backup keeper) is
// absent from players.json — a gap in the projection roster, not a parser fault.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWorker } from 'tesseract.js';
import { Jimp } from 'jimp';
import { extractWords, findAnchors, buildCards, matchSquad, validateSquad } from '../src/ocrSquad.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pool = JSON.parse(fs.readFileSync(path.join(here, '../public/data/players.json'), 'utf8')).players;
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node scripts/test-ocr.mjs <screenshot.png> [...]'); process.exit(2); }

// Local traineddata if present, otherwise tesseract fetches from its CDN.
const localLang = path.join(here, '../node_modules/@tesseract.js-data/eng/4.0.0');
const opts = fs.existsSync(localLang) ? { langPath: localLang, gzip: true, cacheMethod: 'none' } : {};

let failures = 0;
for (const file of files) {
  const img = await Jimp.read(file);
  const scale = Math.max(2, Math.min(3.2, 2900 / img.bitmap.width));
  img.scale(scale).greyscale().contrast(0.3);
  const tmp = path.join(here, '_ocr_tmp.png');
  await img.write(tmp);

  const worker = await createWorker('eng', 1, opts);
  const { data } = await worker.recognize(tmp, {}, { text: true, blocks: true });
  await worker.terminate();
  fs.unlinkSync(tmp);

  const words = extractWords(data.blocks);
  const cards = buildCards(words, findAnchors(words));
  const res = matchSquad(cards, pool);
  const val = validateSquad(res.rows);

  console.log(`\n### ${path.basename(file)} — ${words.length} words, ${cards.length} cards, fixture slot ${res.fixtureIndex}`);
  for (const r of res.rows) {
    const flag = r.status === 'ok' ? ' ' : '!';
    console.log(` ${flag} ${String(r.code).padEnd(4)} ${(r.home ? 'H' : 'A')}  ${String(r.rawName || '—').slice(0, 18).padEnd(19)}`
      + `-> ${String(r.club || '?').padEnd(4)} ${String(r.match ? r.match.name : '—').slice(0, 18).padEnd(19)}`
      + `${String(r.score).padEnd(7)}${r.status}`);
  }
  console.log(`   ${res.squad.length}/15 resolved · ${JSON.stringify(val.counts)} · £${val.cost}m · `
    + (val.ok ? 'VALID' : val.problems.join('; ')));
  if (res.squad.length < 14) failures++;
}
console.log(failures ? `\n${failures} file(s) resolved fewer than 14 players` : '\nall files resolved at least 14/15');
process.exit(failures ? 1 : 0);
