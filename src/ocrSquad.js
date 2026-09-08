// ─── SCREENSHOT → SQUAD ────────────────────────────────────────────────────────
// Pure parsing logic for reading an FPL "Pick Team" / "Transfers" screenshot.
// No DOM, no tesseract import: the caller supplies OCR output. That keeps this
// file testable in Node against real screenshots, so what ships is what was tested.
//
// The trick that makes this reliable: every card on the FPL pitch carries an
// opponent label like "SUN (A)". Combined with the fixture list we already ship in
// players.json that label *uniquely identifies the player's own club* — the side
// playing away at Sunderland this gameweek is Arsenal and nobody else. So instead
// of fuzzy-matching a smudged name against 650 players, we match it against the
// ~25 in one club. That is what turns "Caldafiori" into Calafiori and, more
// importantly, tells Palmer (Chelsea) apart from Palmer (Ipswich).

// ── text helpers ──────────────────────────────────────────────────────────────
export const stripAccents = (s) =>
  String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');

export const normName = (s) =>
  stripAccents(s)
    .replace(/ß/g, 'ss').replace(/Ø/gi, 'o').replace(/Æ/gi, 'ae').replace(/Ð/gi, 'd')
    .replace(/[ØøÐð]/g, 'o')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Levenshtein, capped — we only ever compare short names.
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 0..1. Rewards a clean prefix match, which is what a truncated OCR name looks like.
export function similarity(a, b) {
  a = normName(a); b = normName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const lev = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  // surname-only OCR against a two-part name, or vice versa
  const partsA = a.split(' '), partsB = b.split(' ');
  let best = lev;
  for (const pa of partsA) for (const pb of partsB) {
    if (pa.length < 3 || pb.length < 3) continue;
    const l = 1 - editDistance(pa, pb) / Math.max(pa.length, pb.length);
    if (l > best) best = l * 0.97;   // slight discount: a part match is weaker evidence
  }
  if (a.startsWith(b) || b.startsWith(a)) best = Math.max(best, 0.88);
  return best;
}

// ── OCR output → flat word list ───────────────────────────────────────────────
// tesseract.js v5+ nests words under blocks > paragraphs > lines > words.
export function extractWords(blocks) {
  const out = [];
  const push = (n) => {
    if (!n || !n.bbox || !String(n.text || '').trim()) return;
    const b = n.bbox;
    out.push({
      t: String(n.text).trim(), conf: n.confidence || 0,
      x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2,
      x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1,
    });
  };
  // Walk the block tree down to the WORD level explicitly. A word node carries a
  // `symbols` array, so a generic "leaf" test skips exactly the nodes we want.
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (Array.isArray(n.words)) { n.words.forEach(push); return; }
    if (Array.isArray(n.symbols)) { push(n); return; }
    ['blocks', 'paragraphs', 'lines'].forEach((k) => n[k] && walk(n[k]));
    if (!n.blocks && !n.paragraphs && !n.lines && !n.words && !n.symbols) push(n);
  };
  walk(blocks);
  // de-duplicate: the tree can surface the same word at several depths
  const seen = new Set(), uniq = [];
  for (const w of out) {
    const k = `${w.t}|${Math.round(w.x)}|${Math.round(w.y)}`;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(w);
  }
  return uniq;
}

// ── find the cards ────────────────────────────────────────────────────────────
const VENUE_RE = /^[([{]?\s*([HA])\s*[)\]}]?$/i;
const MERGED_RE = /^([A-Za-z]{3})\s*[([{]\s*([HA])\s*[)\]}]?$/i;
const PRICE_RE = /^[£€$]?\s*(\d{1,2})[.,](\d)\s*m?$/i;

/** Locate one anchor per player card: an opponent code plus home/away. */
export function findAnchors(words) {
  const anchors = [];
  for (const w of words) {
    const m = w.t.match(MERGED_RE);
    if (m) { anchors.push({ code: m[1].toUpperCase(), home: m[2].toUpperCase() === 'H', x: w.x, y: w.y, conf: w.conf }); continue; }
    if (!VENUE_RE.test(w.t)) continue;
    const home = w.t.replace(/[^HAha]/g, '').toUpperCase() === 'H';
    // nearest 3-letter token on the same baseline, to the left
    const code = words
      .filter((z) => /^[A-Za-z]{3}$/.test(z.t) && Math.abs(z.y - w.y) < 28 && z.x < w.x && w.x - z.x < 220)
      .sort((a, b) => b.x - a.x)[0];
    if (code) anchors.push({ code: code.t.toUpperCase(), home, x: (code.x + w.x) / 2, y: w.y, conf: Math.min(w.conf, code.conf) });
  }
  // collapse duplicates from overlapping OCR passes
  const out = [];
  for (const a of anchors) {
    if (out.some((b) => Math.abs(a.x - b.x) < 40 && Math.abs(a.y - b.y) < 20)) continue;
    out.push(a);
  }
  return out.sort((p, q) => p.y - q.y || p.x - q.x);
}

/** Attach the name (and price, if visible) sitting above each anchor. */
export function buildCards(words, anchors) {
  // Association radius: half the horizontal gap between neighbouring cards in the
  // same row, so a wide pitch and a narrow one both work.
  const rows = [];
  for (const a of anchors) {
    let r = rows.find((z) => Math.abs(z.y - a.y) < 30);
    if (!r) { r = { y: a.y, items: [] }; rows.push(r); }
    r.items.push(a);
  }
  let gap = Infinity;
  for (const r of rows) {
    const xs = r.items.map((i) => i.x).sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i++) gap = Math.min(gap, xs[i] - xs[i - 1]);
  }
  const radius = Number.isFinite(gap) ? Math.max(45, gap * 0.45) : 110;

  return anchors.map((a) => {
    const near = (lo, hi) => words.filter((w) => w.y < a.y - lo && w.y > a.y - hi && Math.abs(w.x - a.x) < radius);
    // Name band: immediately above the opponent line. Kept generous — a long name
    // wraps and sits higher, and on one real screenshot "Isak" landed at dy=79,
    // which a tighter band silently dropped.
    const nameWords = near(10, 100)
      .filter((w) => /[A-Za-zÀ-ÿØø]{2}/.test(w.t) && !PRICE_RE.test(w.t) && !/^[([{]?[HA][)\]}]?$/i.test(w.t))
      .sort((p, q) => p.y - q.y || p.x - q.x);
    // price band: above the shirt graphic
    const priceWord = near(78, 340).map((w) => w.t.match(PRICE_RE)).filter(Boolean)[0];
    return {
      code: a.code, home: a.home, x: a.x, y: a.y,
      rawName: nameWords.map((w) => w.t).join(' ').replace(/\s+/g, ' ').trim(),
      price: priceWord ? parseFloat(`${priceWord[1]}.${priceWord[2]}`) : null,
      conf: a.conf,
    };
  });
}

// ── club identification and name matching ─────────────────────────────────────
/** club full name -> short code, taken from the pool so nothing is hardcoded. */
export function teamCodeMap(pool) {
  const m = {};
  for (const p of pool) if (p.team && p.nat) m[p.team] = p.nat;
  return m;
}

/**
 * For fixture index `mi`, map "opponent code + venue" -> the club playing it.
 * Two clubs can never share an (opponent, venue) pair in the same gameweek.
 */
export function fixtureIndex(pool, mi) {
  const code = teamCodeMap(pool);
  const idx = {};
  for (const p of pool) {
    const f = (p.fixtures || [])[mi];
    if (!f || !p.nat) continue;
    const oc = code[f.opponent];
    if (!oc) continue;
    idx[`${oc}|${f.home ? 'H' : 'A'}`] = p.nat;
  }
  return idx;
}

/** Pick the fixture index whose opponent map explains the most cards. */
export function bestFixtureIndex(cards, pool) {
  const horizon = Math.max(1, ...pool.map((p) => (p.fixtures || []).length));
  let best = { mi: 0, hits: -1 };
  for (let mi = 0; mi < horizon; mi++) {
    const idx = fixtureIndex(pool, mi);
    const hits = cards.filter((c) => idx[`${c.code}|${c.home ? 'H' : 'A'}`]).length;
    if (hits > best.hits) best = { mi, hits };
  }
  return best;
}

const MIN_SIM = 0.55;      // below this we do not guess
const MIN_MARGIN = 0.06;   // and we ask if the top two are this close

/**
 * @returns {{squad:number[], rows:Array, fixtureIndex:number, counts:object}}
 * Every row carries its own status so the UI can ask about the doubtful ones
 * rather than silently loading a wrong player.
 */
export function matchSquad(cards, pool, forcedMi = null) {
  // Drop or repair anchors whose club code is not real. OCR happily reads a stray
  // "PAS (A)" out of background noise and that becomes a 16th player.
  const validCodes = new Set(pool.map((p) => p.nat).filter(Boolean));
  const cleaned = [];
  for (const c of cards) {
    if (validCodes.has(c.code)) { cleaned.push(c); continue; }
    const near = [...validCodes].filter((v) => editDistance(v.toLowerCase(), c.code.toLowerCase()) <= 1);
    if (near.length === 1) cleaned.push({ ...c, code: near[0], codeRepaired: true });
    // otherwise: not a club, not a card — discard silently
  }
  cards = cleaned;

  const pick = forcedMi != null ? { mi: forcedMi, hits: 0 } : bestFixtureIndex(cards, pool);
  const idx = fixtureIndex(pool, pick.mi);
  const byClub = {};
  for (const p of pool) (byClub[p.nat] = byClub[p.nat] || []).push(p);

  const rows = [];
  for (const c of cards) {
    const club = idx[`${c.code}|${c.home ? 'H' : 'A'}`] || null;
    const inClub = club ? (byClub[club] || []) : [];
    const rank = (list) => list.map((p) => ({ p, s: similarity(c.rawName, p.name) })).sort((a, b) => b.s - a.s);
    let scored = rank(inClub.length ? inClub : pool);
    let clubMismatch = false;
    // A player can be at a club the projection file has not caught up with (a
    // transfer). If nothing in the fixture-implied club fits, search everyone and
    // flag it rather than dropping the card.
    if (inClub.length && (!scored[0] || scored[0].s < MIN_SIM) && c.rawName) {
      const all = rank(pool);
      if (all[0] && all[0].s >= 0.72) { scored = all; clubMismatch = true; }
    }
    const top = scored[0], second = scored[1];
    let status = 'ok';
    if (!c.rawName) status = 'noname';
    else if (!top || top.s < MIN_SIM) status = 'nomatch';
    else if (clubMismatch) status = 'clubmismatch';
    else if (second && top.s - second.s < MIN_MARGIN) status = 'ambiguous';
    // a visible price that disagrees is a strong signal something is wrong
    if (status === 'ok' && c.price != null && top && Math.abs(top.p.price - c.price) > 0.35) status = 'pricemismatch';
    rows.push({
      ...c, club, status,
      match: top && top.s >= MIN_SIM ? top.p : null,
      score: top ? +top.s.toFixed(3) : 0,
      alternatives: scored.slice(0, 4).filter((z) => z.s > 0.3).map((z) => ({ id: z.p.id, name: z.p.name, nat: z.p.nat, price: z.p.price, pos: z.p.pos, s: +z.s.toFixed(3) })),
    });
  }

  // one player can only appear once — keep the strongest claim
  const claimed = new Map();
  for (const r of rows) {
    if (!r.match) continue;
    const prev = claimed.get(r.match.id);
    if (prev && prev.score >= r.score) { r.status = 'duplicate'; r.match = null; continue; }
    if (prev) { prev.status = 'duplicate'; prev.match = null; }
    claimed.set(r.match.id, r);
  }

  // An FPL squad is 15. If OCR invented an extra card, keep the strongest 15.
  const resolved = rows.filter((r) => r.match);
  if (resolved.length > 15) {
    const keep = new Set(resolved.slice().sort((a, b) => b.score - a.score).slice(0, 15));
    rows.forEach((r) => { if (r.match && !keep.has(r)) { r.status = 'surplus'; r.match = null; } });
  }

  const squad = rows.filter((r) => r.match).map((r) => r.match.id);
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  rows.forEach((r) => { if (r.match) counts[r.match.pos]++; });
  return { squad, rows, fixtureIndex: pick.mi, counts };
}

/** Human-readable check of FPL squad rules. */
export function validateSquad(rows) {
  const picked = rows.filter((r) => r.match).map((r) => r.match);
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = {};
  let cost = 0;
  picked.forEach((p) => { counts[p.pos]++; clubs[p.nat] = (clubs[p.nat] || 0) + 1; cost += p.price; });
  const problems = [];
  if (picked.length !== 15) problems.push(`${picked.length} of 15 players resolved`);
  const want = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  for (const k of ['GK', 'DEF', 'MID', 'FWD']) {
    if (counts[k] !== want[k]) problems.push(`${counts[k]} ${k} (expected ${want[k]})`);
  }
  const over = Object.entries(clubs).filter(([, n]) => n > 3);
  over.forEach(([c, n]) => problems.push(`${n} players from ${c}`));
  return { counts, clubs, cost: +cost.toFixed(1), problems, ok: problems.length === 0 };
}
