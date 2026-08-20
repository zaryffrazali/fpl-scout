import { useState, useMemo, useEffect } from "react";

// ─── PALETTE (module scope so all tab components share it) ─────────────────────
const BG = "#060d1a", CARD = "#0d1829", BORDER = "#1e2d42", TEXT = "#e2e8f0", DIM = "#64748b";
const SANS = "'Inter','DM Sans',system-ui,sans-serif";
const MONO = "'DM Mono','Fira Code','Courier New',monospace";  // badges / tier codes / pos tags only
const POS_COLOR = { FWD:"#f97316", MID:"#22c55e", DEF:"#3b82f6", GK:"#a855f7" };
// team → flag (players.json only carries `nat` for the 56 seed players, so derive from team)
const TEAM_FLAG = {
  "Algeria":"🇩🇿","Argentina":"🇦🇷","Australia":"🇦🇺","Austria":"🇦🇹","Belgium":"🇧🇪","Bosnia and Herzegovina":"🇧🇦",
  "Brazil":"🇧🇷","Canada":"🇨🇦","Cape Verde":"🇨🇻","Colombia":"🇨🇴","Croatia":"🇭🇷","Curacao":"🇨🇼","Czech Republic":"🇨🇿",
  "DR Congo":"🇨🇩","Ecuador":"🇪🇨","Egypt":"🇪🇬","England":"🏴󠁧󠁢󠁥󠁮󠁧󠁿","France":"🇫🇷","Germany":"🇩🇪","Ghana":"🇬🇭","Haiti":"🇭🇹",
  "Iran":"🇮🇷","Iraq":"🇮🇶","Ivory Coast":"🇨🇮","Japan":"🇯🇵","Jordan":"🇯🇴","Mexico":"🇲🇽","Morocco":"🇲🇦","Netherlands":"🇳🇱",
  "New Zealand":"🇳🇿","Norway":"🇳🇴","Panama":"🇵🇦","Paraguay":"🇵🇾","Portugal":"🇵🇹","Qatar":"🇶🇦","Saudi Arabia":"🇸🇦",
  "Scotland":"🏴󠁧󠁢󠁳󠁣󠁴󠁿","Senegal":"🇸🇳","South Africa":"🇿🇦","South Korea":"🇰🇷","Spain":"🇪🇸","Sweden":"🇸🇪","Switzerland":"🇨🇭",
  "Tunisia":"🇹🇳","Turkey":"🇹🇷","United States":"🇺🇸","Uruguay":"🇺🇾","Uzbekistan":"🇺🇿" };
const flagOf = (p) => TEAM_FLAG[p.team] || p.nat || "🏳️";
// FPL Fran's S-tier / best-by-position picks — paste his selections here (full names, any case/accents).
// Players matched here get a 👍 badge in the table. (Empty until the picks are provided.)
const FRAN_PICKS = [
  // e.g. "Kylian Mbappé", "Bukayo Saka", ...
];
const _franNorm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").trim();
const _FRAN_SET = new Set(FRAN_PICKS.map(_franNorm));
const isFranPick = (p) => _FRAN_SET.has(_franNorm(p.name));
const ROLE_MULT = {
  SAME:[1,1], DEF_to_ATT:[1.40,1.60], ATT_to_DEF:[0.60,0.70],
  MID_to_ATT:[1.25,1.20], MID_to_DEF:[0.75,0.80], WING_to_STRIKER:[1.30,0.80],
};
const cleanCluster = (c) => (c || "").replace(/_\d+$/, "").replace(/_/g, " ");

// ─── PREDICTION ENGINE (uses upgraded schema: minutes, per-MD odds, role, etc.) ─
function computePrediction(p, riskMode) {
  const fx = p.fixtures || [];
  const rm = ROLE_MULT[p.roleShift] || [1, 1];
  const fm = p.form_mult || 1;                  // international form (10_form_tracker)
  let xG = (p.xGp90 || 0) * rm[0] * fm;
  let xA = (p.xAp90 || 0) * rm[1] * fm;
  if (typeof p.intl_premium_xG === "number") xG *= 1 + p.intl_premium_xG * 0.3; // model adj

  // per-matchday fixture difficulty (MD1/MD2/MD3 weighted equally)
  let csP = 0, goalP = 0;
  fx.forEach((f) => { csP += f.oddsWin * 0.72 + f.oddsDraw * 0.28; goalP += f.oddsWin * 1.4 + f.oddsDraw * 0.5; });
  csP = fx.length ? csP / fx.length : (p.csP || 0.3);
  goalP = fx.length ? goalP / fx.length : 1.0;

  const sp = p.startProb ?? 0.85;
  const E_mins = sp * (p.minsIfStarted ?? 90);

  // SINGLE ENGINE: group-stage base = sum of the three per-matchday projections (mdScore).
  // This guarantees xPTS·GS === MD1 + MD2 + MD3 — no hidden adjustments baked into the headline.
  let base = 0;
  for (let mi = 0; mi < 3; mi++) base += mdScore(p, mi).pts;

  // surfaced SEPARATELY (flag/badge), not silently added to the displayed total
  const scoutBonusEV = p.own < 5 ? 1.8 : 0;
  const causalAdj = 0.5 * (p.causal_pts_adjustment || 0);

  // floor/ceiling from player PROFILE, not a flat ×0.88/×1.28 (forwards boom-or-bust; keepers steady)
  const posVar = p.pos === "FWD" ? 0.42 : p.pos === "MID" ? 0.34 : p.pos === "DEF" ? 0.26 : 0.22;
  const spLift = (p.penTaker ? 0.05 : 0) + (p.fkTaker ? 0.02 : 0);          // set-piece duty lifts the floor
  const floorF = Math.max(0.55, 1 - posVar + spLift), ceilF = 1 + posVar;

  const pts_mean = +base.toFixed(2);
  const pts_median = +(base * floorF).toFixed(2);
  const pts_p90 = +(base * ceilF).toFixed(2);
  const capMult = p.captainSlot === 3 ? 1.15 : p.captainSlot === 2 ? 1.08 : 1.0;
  const captainValue = pts_p90 * capMult;

  const displayPts = riskMode === "safe" ? pts_median : riskMode === "diff" ? pts_p90 : pts_mean;
  return { pts_median, pts_mean, pts_p90, displayPts, value: displayPts / p.price,
           scoutBonusEV, causalAdj, captainValue, E_MATCHES: 3, E_mins, csP, goalP, xGadj: xG, xAadj: xA };
}

// ─── PER-MATCHDAY xPts (shared by Fantasy XI, Players tab next-MD col, and Planner) ─
function mdScore(p, mi) {
  const f = (p.fixtures || [])[mi]; if (!f) return { pts: 0, opp: null, win: 0 };
  const rm = ROLE_MULT[p.roleShift] || [1, 1], fm = p.form_mult || 1;
  let xG = (p.xGp90 || 0) * rm[0] * fm, xA = (p.xAp90 || 0) * rm[1] * fm;
  if (typeof p.intl_premium_xG === "number") xG *= 1 + p.intl_premium_xG * 0.3;
  const csP = f.oddsWin * 0.72 + f.oddsDraw * 0.28, aMult = (f.oddsWin * 1.6 + f.oddsDraw * 0.5) / 1.1;
  // expected goals conceded after the 1st (−1 each) for GK/DEF — penalises leaky teams, not just rewards CS
  const gcPen = Math.max(0, f.oddsLoss * 2.0 + f.oddsDraw * 0.8 - 1);
  let r = p.pos === "GK" ? csP * 5 + ((p.savesP90 || 3.2) / 3) - gcPen
    : p.pos === "DEF" ? csP * 5 + xG * 7 * aMult + xA * 3 - gcPen
    : p.pos === "MID" ? xG * 6 * aMult + xA * 3 + csP + (xA * 2.5 / 2) + 0.4
    : xG * 5 * aMult + xA * 3 + (p.SoTp90 || 0) / 2;
  if (p.penTaker) r += 0.5; if (p.fkTaker) r += 0.4; if (p.cornerTaker) r += 0.3;
  r -= p.cardRisk === "high" ? 0.4 : p.cardRisk === "medium" ? 0.2 : 0;
  const mf = (p.startProb ?? 0.85) * (p.minsIfStarted ?? 90) / 90;
  return { pts: (p.startProb ?? 0.85) * 2 + r * mf, opp: f.opponent, win: f.oddsWin };
}
// model-implied anytime-scorer / anytime-assister probabilities for a player in matchday mi.
// Poisson: P(≥1) = 1 − e^(−λ), where λ is the player's expected goals (μ for assists) THIS match —
// xG/90 (role-, form-, premium-adjusted) × minutes share × the fixture's goal-context multiplier.
function mdScorerProb(p, mi) {
  const f = (p.fixtures || [])[mi]; if (!f) return { pGoal: 0, pAssist: 0, opp: null };
  const rm = ROLE_MULT[p.roleShift] || [1, 1], fm = p.form_mult || 1;
  let xG = (p.xGp90 || 0) * rm[0] * fm, xA = (p.xAp90 || 0) * rm[1] * fm;
  if (typeof p.intl_premium_xG === "number") xG *= 1 + p.intl_premium_xG * 0.3;
  const goalMult = (f.oddsWin * 1.6 + f.oddsDraw * 0.5) / 1.1;     // team scores more when favoured
  const mins = (p.startProb ?? 0.85) * (p.minsIfStarted ?? 90) / 90;
  let lam = xG * goalMult * mins, mu = xA * goalMult * mins;
  if (p.penTaker) lam += 0.06 * mins;                              // small penalty bump
  return { pGoal: 1 - Math.exp(-lam), pAssist: 1 - Math.exp(-mu), opp: f.opponent };
}
// clean-sheet probability for a team given one of its fixtures (win/draw weighted, model-consistent)
const csFromFixture = f => (f ? f.oddsWin * 0.72 + f.oddsDraw * 0.28 : 0);
// "Next matchday" index from today's date (MD1 Jun11-15, MD2 Jun16-21, MD3 Jun22-27).
function currentNextMd() {
  const t = new Date(), n = t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate();
  return n < 20260616 ? 0 : n < 20260622 ? 1 : 2;
}
const NEXT_MD = currentNextMd();
// Scout-bonus eligibility: +2 pts when a player is owned by <5% and returns >4 pts.
const scoutEligible = (p) => (p.own ?? 100) < 5;

// ─── SMALL UI BITS ─────────────────────────────────────────────────────────────
function OwnBar({ pct }) {
  const color = pct > 30 ? "#f97316" : pct > 10 ? "#eab308" : "#22c55e";
  const tip = `Owned by ${pct}% of managers. ` + (pct>30 ? "Template pick — high ownership limits mini-league upside." : pct>=10 ? "Moderate ownership — balanced template/differential." : "Low ownership — scouting-bonus eligible, differential value.");
  return (
    <div title={tip} style={{ display:"flex", alignItems:"center", gap:6, cursor:"help" }}>
      <div style={{ width:32, height:6, background:"#1e293b", borderRadius:3, overflow:"hidden", flex:"0 0 auto" }}>
        <div style={{ width:`${Math.min(pct,100)}%`, height:"100%", background:color }} />
      </div>
      <span style={{ fontSize:11, color }}>{pct}%</span>
    </div>
  );
}
const Badge = ({ children, bg, fg, bd, title }) => (
  <span title={title} style={{ background:bg, border:`1px solid ${bd}`, color:fg, fontSize:9, padding:"1px 5px",
    borderRadius:4, fontWeight:700, letterSpacing:0.5, whiteSpace:"nowrap", fontFamily:MONO, cursor: title?"help":"default" }}>{children}</span>
);
const POS_TIP = {
  FWD:"Forward — 5pts per goal, 1pt per 2 shots on target",
  MID:"Midfielder — 6pts per goal, 3pts assist, chances-created bonus",
  DEF:"Defender — 7pts per goal, 5pts clean sheet",
  GK:"Goalkeeper — 5pts clean sheet, 1pt per 3 saves, 9pts for a goal" };
const CLUSTER_TIP = {
  HIGH_PRESS_POSSESSION:"High press, possession-based — high-quality chances; attackers & creative mids thrive",
  COUNTER_DEFENSIVE:"Counter-attacking, defensive-first — defenders valuable for clean sheets; attackers boom-or-bust",
  DIRECT_PHYSICAL:"Direct, physical — target men & wide players benefit; set-piece threat",
  TECHNICAL_LOWBLOCK:"Low block, technical — fewer goals, high clean-sheet prob; GKs & CBs valuable",
  BALANCED_TRANSITIONAL:"Balanced, transitions both ways — creative mids & mobile forwards most valuable" };
const TIER_TIP = { S:"S-Tier — top 8% by gambling score. Build-around pick.", A:"A-Tier — top 25%. Strong core piece.", B:"B-Tier — top 50%. Solid contributor.", C:"C-Tier — situational/fixture-dependent.", D:"D-Tier — avoid / bench fodder." };

// ── filter predicates (Change A) ───────────────────────────────────────────────
const overperfTeam = p => p.giant_killer_flag || (p.team_overperf_predicted||0) > 0.3;  // ~quadrant Q2/Q3
const ROLE_PREDS = {
  pen:p=>p.penTaker, fk:p=>p.fkTaker, corner:p=>p.cornerTaker,
  roleUp:p=>/to_ATT|DEF_to_ATT/.test(p.roleShift||""),
  setCombo:p=>[p.penTaker,p.fkTaker,p.cornerTaker].filter(Boolean).length>=2,
  csFort:p=>(p.csP||0)>0.52, scout:p=>p.own<5,
  budgetEnabler:p=>p.price<=5.0 && p.pts_balanced>12,
  multiThreat:p=>(p.xGp90||0)>0.25 && (p.xAp90||0)>0.25,
  captainViable:p=>p.captainSlot===3 && p.startProb>0.90,
  cardSafe:p=>p.cardRisk==="low", koThreat:p=>p.advP>75, overperfTeam,
  inForm:p=>p.qualifyingForm==="EXCELLENT"||p.qualifyingForm==="GOOD",
  aerial:p=>p.aerial_threat===true,
};
const ROLE_DEFS = [["pen","🎯 PEN"],["fk","🦶 FK"],["corner","📐 CORNER"],["roleUp","⬆️ ROLE↑"],
  ["setCombo","🔫 SET-PIECE COMBO"],["csFort","🧤 CS FORT"],["scout","👁 SCOUT"],["budgetEnabler","📊 BUDGET ENABLER"],
  ["multiThreat","💥 MULTI THREAT"],["captainViable","⚡ CAPTAIN VIABLE"],["cardSafe","🃏 CARD SAFE"],
  ["koThreat","🏆 KO THREAT"],["overperfTeam","⭐ OVERPERF TEAM"],["inForm","⭐ IN FORM"],
  ["aerial","🛩 AERIAL THREAT"]];
const SMART_PREDS = {
  // attacking starters who contribute a lot; the auto-set MD + "easy fixture" filter adds the
  // high-win-probability-vs-weak-opponent half (switch MD via the Matchday dropdown).
  captainPicks:p=>p.startProb>=0.85 && (p.pts_balanced||0)>10 && (p.pos==="MID"||p.pos==="FWD"),
  scoutTargets:p=>p.own<5 && p.pts_balanced>10 && p.startProb>0.85,
  budgetBuilders:p=>p.price<=5.5 && (p.pts_balanced||0)>8 && (p.startProb||0)>0.70,
  // role/usage mispricing: attacking role-shift OR model-underrated, low-owned, and a plausible starter
  roleArb:p=>(/ATT/.test(p.roleShift||"") || p.mispricing_flag==="UNDERRATED") && p.own<20 && (p.startProb||0)>=0.65 && (p.pts_balanced||0)>8,
  defHolds:p=>(p.pos==="DEF"||p.pos==="GK") && (p.csP||0)>0.50 && p.advP>65 && p.cardRisk==="low",
  diffStack:p=>p.own<15 && overperfTeam(p) && (p.pts_diff||0)>20,
};
const SMART_DEFS = [["captainPicks","🎯 Captain Picks (pick MD)"],["scoutTargets","🔍 Scouting Bonus"],
  ["budgetBuilders","💰 Budget Builders"],["roleArb","⬆️ Role Arbitrage"],["defHolds","🏰 Defensive Holds"],["diffStack","📈 Differential Stack"]];
const CLUSTERS = ["HIGH_PRESS_POSSESSION","COUNTER_DEFENSIVE","DIRECT_PHYSICAL","TECHNICAL_LOWBLOCK","BALANCED_TRANSITIONAL"];
const FILTER_DEFAULT = { roles:{}, smart:null, md:null, fixStr:"all", teamPlay:"All", oppPlay:"All", xMins:60, advMin:0, ptsMin:0 };
function passesFilters(p, F, cl) {
  for (const k in F.roles) if (F.roles[k] && !ROLE_PREDS[k](p)) return false;
  if (F.smart && SMART_PREDS[F.smart] && !SMART_PREDS[F.smart](p)) return false;
  const fx = F.md!=null ? (p.fixtures||[])[F.md] : null;
  if (F.md!=null && F.fixStr!=="all") {
    const w = fx?.oddsWin ?? 0;
    if (F.fixStr==="easy" && !(w>0.65)) return false;
    if (F.fixStr==="medium" && !(w>=0.40 && w<=0.65)) return false;
    if (F.fixStr==="hard" && !(w<0.40)) return false;
  }
  if (F.teamPlay!=="All" && (p.team_cluster||"").replace(/_\d+$/,"")!==F.teamPlay) return false;
  if (F.md!=null && F.oppPlay!=="All" && (!fx || cl[fx.opponent]!==F.oppPlay)) return false;
  // when a smart filter is active, don't let the DEFAULT minutes/survival sliders silently empty the
  // cohort (that made the badge count and the table disagree) — only apply them if the user raised them
  const applyXMins = !F.smart || F.xMins !== 60;
  const applyAdv = !F.smart || F.advMin !== 0;
  if (applyXMins && (p.startProb||0)*(p.minsIfStarted||0) < F.xMins) return false;
  if (applyAdv && (p.advP||0) < F.advMin) return false;
  if ((p.pts_balanced||0) < F.ptsMin) return false;
  return true;
}
const activeFilterCount = F => Object.values(F.roles).filter(Boolean).length + (F.smart?1:0) + (F.md!=null?1:0)
  + (F.fixStr!=="all"?1:0) + (F.teamPlay!=="All"?1:0) + (F.oppPlay!=="All"?1:0)
  + (F.xMins!==60?1:0) + (F.advMin!==0?1:0) + (F.ptsMin!==0?1:0);
const ScoutBadge = () => <Badge bg="#16a34a22" bd="#22c55e88" fg="#4ade80" title="Scouting Bonus eligible — under 5% owned. +2 bonus pts when scoring >4 pts in a match. Mini-league swing pick.">🎯 SCOUT</Badge>;
const PenBadge   = () => <Badge bg="#7c3aed22" bd="#a855f788" fg="#c084fc" title="Confirmed penalty taker — adds +0.5 pts EV per game from penalties.">PEN</Badge>;
function RoleArrow({ shift, note }) {
  if (!shift || shift === "SAME") return <span style={{ color:DIM }} title="Same as club role">—</span>;
  const up = /ATT|STRIKER/.test(shift);
  return <span title={note || shift} style={{ color: up ? "#f97316" : "#3b82f6", fontWeight:700, cursor:"help" }}>{up ? "↑" : "↓"}</span>;
}
function MispriceTag({ flag, score }) {
  if (!flag || flag === "FAIR" || flag === "INSUFFICIENT_DATA")
    return <span style={{ fontSize:11, color:DIM }}>{score!=null ? `${score>0?"+":""}${score.toFixed(1)}σ` : "—"}</span>;
  const c = flag === "UNDERRATED" ? "#4ade80" : "#ff6b6b";
  return <span style={{ fontSize:11, color:c, fontWeight:600 }}>{score>0?"+":""}{score?.toFixed(1)}σ</span>;
}
function MDDots({ fixtures }) {
  return (
    <div style={{ display:"flex", gap:4, justifyContent:"flex-end" }}>
      {(fixtures||[]).map((f,i) => {
        const c = f.oddsWin > 0.65 ? "#22c55e" : f.oddsWin >= 0.40 ? "#eab308" : "#ef4444";
        return <div key={i} title={`MD${f.md} vs ${f.opponent} — ${Math.round(f.oddsWin*100)}% win`}
          style={{ width:9, height:9, borderRadius:"50%", background:c }} />;
      })}
    </div>
  );
}

function Sparkline({ matches, w=72, h=22 }) {
  if (!matches || !matches.length) return <span style={{ color:DIM, fontSize:10 }}>no intl data</span>;
  const vals = matches.map(m => m.gi);
  const max = Math.max(...vals, 0.5), min = Math.min(...vals, 0), span = (max-min)||1;
  const xy = i => [vals.length>1 ? (i/(vals.length-1))*w : w/2, h - ((vals[i]-min)/span)*h];
  const pts = vals.map((_,i)=>xy(i).map(n=>n.toFixed(1)).join(",")).join(" ");
  const last = vals[vals.length-1], col = last>0.6?"#4ade80":last>0.3?"#eab308":"#ef4444";
  return (
    <svg width={w} height={h} style={{ display:"block" }}>
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.5" />
      {vals.map((_,i)=>{ const [x,y]=xy(i); return <circle key={i} cx={x} cy={y} r="1.7" fill={col} />; })}
    </svg>
  );
}

// ─── FILTER PANEL (Change A) ────────────────────────────────────────────────────
function FilterPanel({ F, setF, show, setShow, pool }) {
  const n = activeFilterCount(F);
  const toggleRole = k => setF(s=>({...s, roles:{...s.roles, [k]:!s.roles[k]}}));
  const setSmart = k => setF(s=>({...s, smart:s.smart===k?null:k, md:k==="captainPicks"?0:s.md, fixStr:k==="captainPicks"?"easy":s.fixStr}));
  const set = (k,v) => setF(s=>({...s, [k]:v}));
  const pills = [];
  Object.keys(F.roles).forEach(k=>{ if(F.roles[k]) pills.push([(ROLE_DEFS.find(d=>d[0]===k)||[,k])[1], ()=>toggleRole(k)]); });
  if(F.smart) pills.push([(SMART_DEFS.find(d=>d[0]===F.smart)||[,F.smart])[1], ()=>set("smart",null)]);
  if(F.md!=null) pills.push([`MD${F.md+1}`, ()=>set("md",null)]);
  if(F.fixStr!=="all") pills.push([`Fix: ${F.fixStr}`, ()=>set("fixStr","all")]);
  if(F.teamPlay!=="All") pills.push([`Team: ${F.teamPlay.replace(/_/g," ")}`, ()=>set("teamPlay","All")]);
  if(F.oppPlay!=="All") pills.push([`Opp: ${F.oppPlay.replace(/_/g," ")}`, ()=>set("oppPlay","All")]);
  if(F.xMins!==60) pills.push([`xMins ≥ ${F.xMins}'`, ()=>set("xMins",60)]);
  if(F.advMin!==0) pills.push([`adv ≥ ${F.advMin}%`, ()=>set("advMin",0)]);
  if(F.ptsMin!==0) pills.push([`xPts ≥ ${F.ptsMin}`, ()=>set("ptsMin",0)]);
  const btn = (a,ex={}) => ({ padding:"5px 9px", borderRadius:6, fontFamily:"inherit", fontSize:11, cursor:"pointer",
    border:`1px solid ${a?"#f97316":BORDER}`, background:a?"#f9731618":"transparent", color:a?"#f97316":DIM, ...ex });
  const sel = { background:BG, border:`1px solid ${BORDER}`, borderRadius:6, padding:"5px 8px", color:TEXT, fontFamily:"inherit", fontSize:11 };
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
        <button onClick={()=>setShow(v=>!v)} style={btn(n>0,{fontSize:12,padding:"6px 12px"})}>⚙ FILTERS{n>0?` (${n} active)`:""}</button>
        {pills.map(([l,clr],i)=>(
          <span key={i} style={{ display:"inline-flex", alignItems:"center", gap:5, background:"#f9731614", border:"1px solid #f9731644", color:"#f97316", borderRadius:12, padding:"3px 8px", fontSize:11 }}>
            {l}<span onClick={clr} style={{ cursor:"pointer", fontWeight:700 }}>×</span></span>))}
        {n>0 && <button onClick={()=>setF(FILTER_DEFAULT)} style={btn(false,{marginLeft:"auto", color:"#ff6b6b", border:"1px solid #ff6b6b55"})}>CLEAR ALL</button>}
      </div>
      {show && (
        <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"12px 14px", marginTop:8 }}>
          <div style={{ fontSize:9, letterSpacing:2, color:DIM, marginBottom:6 }}>SMART FILTERS</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
            {SMART_DEFS.map(([k,l])=>(<button key={k} className="smart-filter" onClick={()=>setSmart(k)} style={btn(F.smart===k)}>{l} ({pool.filter(SMART_PREDS[k]).length})</button>))}
          </div>
          <div style={{ fontSize:9, letterSpacing:2, color:DIM, marginBottom:6 }}>PLAYER ROLE</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
            {ROLE_DEFS.map(([k,l])=>(<button key={k} className="smart-filter" onClick={()=>toggleRole(k)} style={btn(!!F.roles[k])}>{l}</button>))}
          </div>
          <div style={{ fontSize:9, letterSpacing:2, color:DIM, marginBottom:6 }}>FIXTURES</div>
          <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:12, alignItems:"center" }}>
            <label style={{fontSize:11,color:DIM}}>Matchday <select value={F.md==null?"":F.md} onChange={e=>set("md",e.target.value===""?null:+e.target.value)} style={sel}><option value="">—</option><option value="0">MD1</option><option value="1">MD2</option><option value="2">MD3</option></select></label>
            {F.md!=null && <label style={{fontSize:11,color:DIM}}>Strength <select value={F.fixStr} onChange={e=>set("fixStr",e.target.value)} style={sel}><option value="all">All</option><option value="easy">Easy &gt;65%</option><option value="medium">Medium 40-65%</option><option value="hard">Hard &lt;40%</option></select></label>}
            <label style={{fontSize:11,color:DIM}}>Team style <select value={F.teamPlay} onChange={e=>set("teamPlay",e.target.value)} style={sel}><option>All</option>{CLUSTERS.map(c=><option key={c} value={c}>{c.replace(/_/g," ")}</option>)}</select></label>
            {F.md!=null && <label style={{fontSize:11,color:DIM}}>Opp style <select value={F.oppPlay} onChange={e=>set("oppPlay",e.target.value)} style={sel}><option>All</option>{CLUSTERS.map(c=><option key={c} value={c}>{c.replace(/_/g," ")}</option>)}</select></label>}
          </div>
          <div style={{ fontSize:9, letterSpacing:2, color:DIM, marginBottom:6 }}>THRESHOLDS</div>
          <div style={{ display:"flex", gap:20, flexWrap:"wrap" }}>
            <label style={{fontSize:11,color:DIM}}>Min minutes: {F.xMins}'<br/><input type="range" min={45} max={90} value={F.xMins} onChange={e=>set("xMins",+e.target.value)} style={{accentColor:"#f97316"}}/></label>
            <label style={{fontSize:11,color:DIM}}>Min xPts: {F.ptsMin}<br/><input type="range" min={0} max={40} value={F.ptsMin} onChange={e=>set("ptsMin",+e.target.value)} style={{accentColor:"#f97316"}}/></label>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── WATCHLIST (shared between Players tab and Planner) ───────────────────────────
function WatchlistBox({ players, watch, toggleWatch, onPick, pickLabel, md }) {
  const ws = (watch || []).map(id => (players || []).find(p => p.id === id)).filter(Boolean);
  return (
    <div style={{ background:CARD, border:`1px solid #fbbf2455`, borderRadius:10, padding:"10px 12px", marginBottom:10 }}>
      <div style={{ fontSize:12, fontWeight:800, color:"#fbbf24", marginBottom:6 }}>⭐ Watchlist ({ws.length})</div>
      {ws.length === 0 ? <div style={{ fontSize:11, color:DIM }}>Highlight players (★) in the Players tab to pin them here.</div>
        : <div style={{ maxHeight:220, overflowY:"auto" }}>{ws.map(p => (
            <div key={p.id} style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 0", borderTop:`1px solid ${BORDER}33` }}>
              <span style={{ flex:"1 1 auto", minWidth:0, fontSize:12, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{flagOf(p)} {p.name} <span style={{ color:DIM, fontSize:10 }}>{p.pos} ${p.price}m{md!=null?` · ${mdScore(p,md).pts.toFixed(1)}xP`:""}</span></span>
              {onPick && <button onClick={()=>onPick(p)} style={{ fontSize:10, padding:"2px 7px", borderRadius:4, border:`1px solid ${BORDER}`, background:"transparent", color:"#4ade80", cursor:"pointer", whiteSpace:"nowrap" }}>{pickLabel||"view"}</button>}
              <button onClick={()=>toggleWatch(p.id)} title="Remove from watchlist" style={{ fontSize:12, padding:"2px 5px", borderRadius:4, border:"none", background:"transparent", color:"#fbbf24", cursor:"pointer" }}>★</button>
            </div>))}</div>}
    </div>
  );
}

// ─── TAB: PLAYER TABLE ──────────────────────────────────────────────────────────
function PlayerTableTab({ players, selected, setSelected, riskMode, setRiskMode,
                          posFilter, setPosFilter, sortBy, setSortBy, search, setSearch,
                          ownMax, setOwnMax, priceMax, setPriceMax, mispricedOnly, setMispricedOnly,
                          F, setF, showFilters, setShowFilters, allPlayers, mobile, dataTimestamp, watch, toggleWatch }) {
  const refreshed = dataTimestamp
    ? new Date(dataTimestamp).toLocaleString("en-US", { timeZone:"Asia/Kuala_Lumpur", month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit", hour12:true })
    : null;
  const riskLabel = { safe:"🛡️ Safe", balanced:"⚖️ Balanced", diff:"🎯 Differential" };
  const riskDesc  = { safe:"Median pts — low-variance template picks",
                      balanced:"Mean expected pts — default projection",
                      diff:"90th-pct + scouting bonus — ceiling chasing" };
  return (
    <>
      {/* risk mode */}
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"12px 16px", marginBottom:12 }}>
        <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:8 }}>RISK PREFERENCE</div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
          {["safe","balanced","diff"].map(m => (
            <button key={m} className="risk-btn" onClick={()=>setRiskMode(m)} style={{ padding:"6px 13px", borderRadius:6,
              border:`1px solid ${riskMode===m?"#f97316":BORDER}`, background:riskMode===m?"#f9731618":"transparent",
              color:riskMode===m?"#f97316":DIM, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>{riskLabel[m]}</button>
          ))}
        </div>
        <div style={{ fontSize:13, color:"#94a3b8" }}>{riskDesc[riskMode]}</div>
      </div>

      {/* filters */}
      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12, alignItems:"center" }}>
        <input placeholder="Search player or team..." value={search} onChange={e=>setSearch(e.target.value)}
          style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:6, padding:"7px 11px",
            color:TEXT, fontFamily:"inherit", fontSize:12, flex:"1 1 160px", minWidth:0, outline:"none" }} />
        {["ALL","FWD","MID","DEF","GK"].map(pos => (
          <button key={pos} className="filter-btn" onClick={()=>setPosFilter(pos)} style={{ padding:"7px 12px", borderRadius:6,
            fontFamily:"inherit", fontSize:12, cursor:"pointer",
            border:`1px solid ${posFilter===pos?(POS_COLOR[pos]||"#f97316"):BORDER}`,
            background:posFilter===pos?`${(POS_COLOR[pos]||"#f97316")}18`:"transparent",
            color:posFilter===pos?(POS_COLOR[pos]||"#f97316"):DIM }}>{pos}</button>
        ))}
        <button onClick={()=>setMispricedOnly(v=>!v)} title="Role shift OR model-underrated, sub-20% owned"
          style={{ padding:"7px 12px", borderRadius:6, fontFamily:"inherit", fontSize:12, cursor:"pointer",
          border:`1px solid ${mispricedOnly?"#4ade80":BORDER}`, background:mispricedOnly?"#16a34a22":"transparent",
          color:mispricedOnly?"#4ade80":DIM }}>★ MISPRICED</button>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginLeft:"auto", flexWrap:"wrap" }}>
          <span style={{ fontSize:11, color:DIM, whiteSpace:"nowrap" }}>£ ≤ ${priceMax}m</span>
          <input type="range" min={3.5} max={11} step={0.5} value={priceMax} onChange={e=>setPriceMax(+e.target.value)}
            style={{ width:70, accentColor:"#f97316" }} />
          <span style={{ fontSize:11, color:DIM, whiteSpace:"nowrap" }}>Own ≤ {ownMax}%</span>
          <input type="range" min={1} max={100} value={ownMax} onChange={e=>setOwnMax(+e.target.value)}
            style={{ width:70, accentColor:"#f97316" }} />
        </div>
      </div>

      {/* filter panel */}
      <FilterPanel F={F} setF={setF} show={showFilters} setShow={setShowFilters} pool={allPlayers||[]} />

      <div style={{ display:"flex", gap:14, alignItems:"flex-start", flexDirection: mobile?"column":"row" }}>
      <div style={{ flex:"1 1 0", minWidth:0 }}>
      {mobile && <WatchlistBox players={allPlayers} watch={watch} toggleWatch={toggleWatch} onPick={(p)=>setSelected(p)} pickLabel="view" />}
      {/* sort hint + count (sorting now lives on the clickable column headers) */}
      <div style={{ display:"flex", alignItems:"center", borderBottom:`1px solid ${BORDER}`, padding:"6px 2px" }}>
        <span style={{ fontSize:11, color:DIM }}>Tip: click any column header (xPTS·GS, VAL, MD1–3, OWN, TIER…) to sort high → low</span>
        <span style={{ marginLeft:"auto", fontSize:10, color:DIM, paddingRight:4 }}>{players.length>200?`top 200 of ${players.length}`:`${players.length} players`}</span>
      </div>

      {/* last updated */}
      {refreshed && <div style={{ textAlign:"right", fontSize:11, color:"#64748b", margin:"6px 0" }}>Data refreshed: {refreshed} MYT · Auto-refreshes every 3h</div>}

      {/* table — empty-state meme, else mobile cards / desktop grid */}
      {players.length === 0 ? (
        <div style={{ textAlign:"center", padding:"44px 20px", color:DIM }}>
          <img src="/img/makkauijau.png" alt="" className="mki-shake" style={{ height:78, filter:"drop-shadow(0 3px 6px #000a)" }} />
          <div style={{ fontSize:14, fontWeight:800, color:"#4ade80", marginTop:10, fontStyle:"italic" }}>Mak kau ijau — takde sapa 😤</div>
          <div style={{ fontSize:12, marginTop:4 }}>{F.roles.aerial ? "Aerial-threat data isn't loaded yet — run r-analytics/aerial_pull.R to populate it (Big-5 league players only)." : <>No players match these filters.{posFilter!=="ALL" ? ` You're filtered to ${posFilter} — most role filters (set-pieces, scout, etc.) have few or no ${posFilter}s, so try ALL positions.` : " Loosen them or hit CLEAR ALL."}</>}</div>
        </div>
      ) : mobile ? (
        <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:4 }}>
          {players.slice(0,200).map((p) => { const posCol = POS_COLOR[p.pos]; const isOpen = selected?.id===p.id;
            return (
              <div key={p.id}>
              <div onClick={()=>setSelected(isOpen?null:p)}
                style={{ background:isOpen?"#f9731610":CARD, border:`1px solid ${isOpen?"#f97316aa":BORDER}`, borderRadius: isOpen?"8px 8px 0 0":8, padding:"8px 11px", cursor:"pointer" }}>
                <div style={{ display:"flex", flexWrap:"nowrap", alignItems:"center", gap:6, overflow:"hidden" }}>
                  <span onClick={e=>{e.stopPropagation(); toggleWatch&&toggleWatch(p.id);}} style={{ cursor:"pointer", color:(watch||[]).includes(p.id)?"#fbbf24":"#475569", fontSize:13, flex:"0 0 auto" }}>{(watch||[]).includes(p.id)?"★":"☆"}</span>
                  <span style={{ color:"#fff", fontWeight:700, fontSize:14, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", flex:"1 1 auto", minWidth:0 }}>{flagOf(p)} {p.name}</span>
                  <span title={POS_TIP[p.pos]} style={{ flex:"0 0 auto", fontSize:10, color:posCol, border:`1px solid ${posCol}44`, padding:"0 5px", borderRadius:3, fontFamily:MONO }}>{p.pos}</span>
                  <span style={{ flex:"0 0 auto", fontSize:12, fontWeight:800, fontFamily:MONO, color:p.tier==="S"?"#fbbf24":p.tier==="A"?"#cbd5e1":p.tier==="B"?"#d97706":DIM }}>{p.tier||"-"}</span>
                  <span style={{ flex:"0 0 auto", color: isOpen?"#f97316":DIM, fontSize:10 }}>{isOpen?"▲":"▼"}</span>
                </div>
                <div style={{ display:"flex", gap:8, fontSize:12, color:DIM, marginTop:3, whiteSpace:"nowrap", overflow:"hidden" }}>
                  <span style={{ color:"#94a3b8" }}>${p.price}m</span>
                  <span style={{ color:p.E_mins<60?"#eab308":"#94a3b8" }}>{Math.round(p.E_mins)}'</span>
                  <span style={{ color:p.displayPts>30?"#f97316":p.displayPts>20?"#22c55e":TEXT, fontWeight:700 }}>xPTS {p.displayPts.toFixed(1)}</span>
                  <span style={{ color:"#7b8cde" }} title="MD1·MD2·MD3 xPts">MD {mdScore(p,0).pts.toFixed(0)}·{mdScore(p,1).pts.toFixed(0)}·{mdScore(p,2).pts.toFixed(0)}</span>
                  <span>Own {p.own}%</span>
                </div>
              </div>
              {isOpen && <div style={{ border:"1px solid #f97316aa", borderTop:"none", borderRadius:"0 0 8px 8px", overflow:"hidden" }}>
                <PlayerDetail p={p} riskMode={riskMode} onClose={()=>setSelected(null)} watch={watch} toggleWatch={toggleWatch} />
              </div>}
              </div>);
          })}
        </div>
      ) : (
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:"0 0 10px 10px", overflow:"hidden" }}>
        <div style={{ display:"grid", gridTemplateColumns:"24px 1fr 46px 40px 34px 50px 44px 32px 32px 32px 50px 88px 28px 40px",
          gap:8, padding:"8px 12px", borderBottom:`1px solid ${BORDER}`, fontSize:9, letterSpacing:1, color:DIM, background:"#0a121f" }}>
          {(() => { const SH = (k, label, align="right", title) => (
            <div onClick={()=>setSortBy(k)} title={title || `Sort by ${label} (high → low)`}
              style={{ textAlign:align, cursor:"pointer", color:sortBy===k?"#f97316":DIM, fontWeight:sortBy===k?800:400 }}>
              {label}{sortBy===k?" ▼":""}</div>); return (<>
          <div>#</div><div>PLAYER</div>
          {SH("price","£")}
          {SH("xmins","xMIN")}
          {SH("role","ROLE","center","Role shift vs club role: attacking shifts (↑, e.g. DEF→ATT) rank first, defensive shifts (↓) last. Click to sort high → low.")}
          {SH("displayPts","xPTS·GS","right","Group-stage xPts (sum of MD1–3) — same 3 games for every player")}
          {SH("value","VAL","right","Value = group-stage xPts ÷ price ($m). Click to sort high → low.")}
          {SH("md0","MD1","right","Projected xPts in Matchday 1")}
          {SH("md1","MD2","right","Projected xPts in Matchday 2")}
          {SH("md2","MD3","right","Projected xPts in Matchday 3")}
          {SH("intl","INTL σ","right","International premium (σ): how much a player out- or under-performs their CLUB output when playing for their COUNTRY — the model's mispricing signal. Positive = underrated vs price, negative = overrated. Click to sort high → low.")}
          {SH("own","OWN")}
          {SH("tier","TIER","center")}
          <div style={{textAlign:"right"}}>FIX</div>
          </>); })()}
        </div>
        {players.slice(0,200).map((p,i) => {
          const posCol = POS_COLOR[p.pos];
          return (
            <div key={p.id} onClick={()=>setSelected(selected?.id===p.id?null:p)}
              style={{ display:"grid", gridTemplateColumns:"24px 1fr 46px 40px 34px 50px 44px 32px 32px 32px 50px 88px 28px 40px",
                gap:8, padding:"9px 12px", borderBottom:`1px solid ${BORDER}33`,
                background:selected?.id===p.id?"#f9731610": i<3?"#0f1c2d":"transparent",
                cursor:"pointer", alignItems:"center" }}>
              <div style={{ fontSize:10, color:i<3?"#f97316":DIM }}>{i+1}</div>
              <div style={{ minWidth:0 }}>
                <div style={{ display:"flex", gap:6, alignItems:"center", minWidth:0 }}>
                  <span onClick={e=>{e.stopPropagation(); toggleWatch&&toggleWatch(p.id);}} title="Highlight → adds to Squad Planner watchlist" style={{ cursor:"pointer", color:(watch||[]).includes(p.id)?"#fbbf24":"#475569", fontSize:15, flexShrink:0 }}>{(watch||[]).includes(p.id)?"★":"☆"}</span>
                  <span style={{ color:"#fff", fontWeight:700, fontSize:15, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", minWidth:0 }}>{flagOf(p)} {p.name}</span>
                </div>
                <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"wrap", marginTop:3 }}>
                  <span title={POS_TIP[p.pos]} style={{ fontSize:10, color:posCol, border:`1px solid ${posCol}44`, padding:"0 5px", borderRadius:3, fontFamily:MONO, cursor:"help" }}>{p.pos}</span>
                  {p.qualifyingForm==="EXCELLENT" && <Badge bg="#052e16" bd="#22c55e" fg="#86efac" title="Excellent qualifying form — 0.6+ goal contributions/game in recent competitive internationals.">QF ★★★</Badge>}
                  {p.qualifyingForm==="GOOD" && <Badge bg="#0a1f1c" bd="#22c55e88" fg="#4ade80" title="Good qualifying form — 0.3–0.6 goal contributions/game in recent competitive internationals.">QF ★★</Badge>}
                  {p.own<5 && <ScoutBadge/>}
                  {p.mispricing_flag==="UNDERRATED" && <Badge bg="#16a34a22" bd="#22c55e88" fg="#4ade80" title={`Model edge: outperforms club stats internationally by +${(p.intl_premium_score||0).toFixed(2)}σ. May be undervalued.`}>★ EDGE</Badge>}
                  {isFranPick(p) && <Badge bg="#1e3a8a44" bd="#3b82f6aa" fg="#93c5fd" title="FPL Fran's S-tier / best-by-position pick">👍 FRAN</Badge>}
                  {p.penTaker && <PenBadge/>}
                  {p.data_tier && p.data_tier!=="curated" && <Badge bg="#1e293b" bd="#334155" fg="#64748b" title="Prior-filled — stats from position/price priors (not hand-curated or FBref-matched). Lower confidence.">prior</Badge>}
                  {p.form_n>0 && <Badge bg="#0a1f1c" bd={p.form_mult>1.05?"#22c55e88":p.form_mult<0.95?"#ef444488":"#33415588"} fg={p.form_mult>1.05?"#4ade80":p.form_mult<0.95?"#ff6b6b":"#94a3b8"} title={`International form ×${p.form_mult} vs club baseline (last ${p.form_n} match${p.form_n>1?"es":""}), applied to xG/xA.`}>≈×{p.form_mult}</Badge>}
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:3 }}>
                  <span style={{ fontSize:10, color:DIM }}>{p.team}</span>
                  {p.team_cluster && <span title={CLUSTER_TIP[(p.team_cluster||"").replace(/_\d+$/,"")]} style={{ fontSize:9, color:"#7b8cde", cursor:"help" }}>{cleanCluster(p.team_cluster)}</span>}
                  <span style={{ fontSize:11 }}>{p.form}</span>
                </div>
              </div>
              <div style={{ textAlign:"right", fontSize:15, color:"#94a3b8", fontWeight:600 }}>${p.price}m</div>
              <div style={{ textAlign:"right", fontSize:12, color:p.E_mins<60?"#eab308":"#94a3b8" }}>{Math.round(p.E_mins)}'</div>
              <div style={{ textAlign:"center" }}><RoleArrow shift={p.roleShift} note={p.roleShiftNote}/></div>
              <div title={`Predicted ${p.displayPts.toFixed(1)} pts (${riskMode}). Floor ${p.pts_median?.toFixed(1)} · ceiling ${p.pts_p90?.toFixed(1)}`}
                style={{ textAlign:"right", fontSize:18, fontWeight:800, cursor:"help",
                color:p.displayPts>30?"#f97316":p.displayPts>20?"#22c55e":TEXT }}>{p.displayPts.toFixed(1)}</div>
              <div title={`${(p.value||0).toFixed(2)} group-stage xPts per $m`} style={{ textAlign:"right", fontSize:12, fontWeight:700, cursor:"help", color:p.value>3?"#f97316":p.value>2?"#22c55e":DIM }}>{(p.value||0).toFixed(1)}</div>
              {[0,1,2].map(mi => { const ms = mdScore(p, mi); return (
                <div key={mi} title={`MD${mi+1}${ms.opp?` vs ${ms.opp}`:""} — projected ${ms.pts.toFixed(1)} pts`} style={{ textAlign:"right", fontSize:12, fontWeight:700, cursor:"help", color: ms.pts>6?"#f97316":ms.pts>4?"#22c55e":DIM }}>{ms.pts.toFixed(1)}</div>
              ); })}
              <div style={{ textAlign:"right" }}><MispriceTag flag={p.mispricing_flag} score={p.intl_premium_score}/></div>
              <div style={{ display:"flex", justifyContent:"flex-end" }}><OwnBar pct={p.own}/></div>
              <div title={TIER_TIP[p.tier]||""} style={{ textAlign:"center", fontSize:13, fontWeight:800, fontFamily:MONO, cursor:"help",
                color:p.tier==="S"?"#fbbf24":p.tier==="A"?"#cbd5e1":p.tier==="B"?"#d97706":DIM }}>{p.tier||"-"}</div>
              <div><MDDots fixtures={p.fixtures}/></div>
            </div>
          );
        })}
      </div>
      )}
      </div>{/* left: table */}
      {!mobile && (
        <div style={{ flex:"0 0 320px", width:320, position:"sticky", top:8, alignSelf:"flex-start", maxHeight:"calc(100vh - 24px)", overflowY:"auto" }}>
          <WatchlistBox players={allPlayers} watch={watch} toggleWatch={toggleWatch} onPick={(p)=>setSelected(p)} pickLabel="view" />
          {selected ? <PlayerDetail p={selected} riskMode={riskMode} onClose={()=>setSelected(null)} watch={watch} toggleWatch={toggleWatch} />
            : <div style={{ background:CARD, border:`1px dashed ${BORDER}`, borderRadius:10, padding:"24px 16px", textAlign:"center", color:DIM, fontSize:12 }}>Click a player to see their full breakdown here.</div>}
        </div>
      )}
      </div>{/* 2-col */}
    </>
  );
}

// ─── PLAYER DETAIL (with MODEL DEEP DIVE + fixtures + role analysis) ────────────
function PlayerDetail({ p, riskMode, onClose, watch, toggleWatch }) {
  const hot = (watch || []).includes(p.id);
  const pred = computePrediction(p, riskMode);
  const posCol = POS_COLOR[p.pos];
  const rm = ROLE_MULT[p.roleShift] || [1,1];
  return (
    <div style={{ background:CARD, border:`1px solid ${posCol}44`, borderRadius:10, padding:"18px 20px",
      marginTop:10, boxShadow:`0 0 30px ${posCol}18` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14, flexWrap:"wrap", gap:10 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:900, color:"#fff" }}>{flagOf(p)} {p.name}</div>
          <div style={{ fontSize:12, color:DIM, marginTop:3 }}>{p.team} · {p.pos} · ${p.price}m · {p.own}% owned · {cleanCluster(p.team_cluster)}</div>
          {toggleWatch && <div style={{ fontSize:10, color:"#fbbf2599", marginTop:3 }}>Highlighted players appear in the Squad Planner ⭐</div>}
        </div>
        <div style={{ display:"flex", gap:6, flexShrink:0 }}>
          {toggleWatch && <button onClick={()=>toggleWatch(p.id)} style={{ background: hot?"#fbbf2422":"transparent", border:`1px solid ${hot?"#fbbf24":BORDER}`, color: hot?"#fbbf24":DIM, padding:"4px 10px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:11, fontWeight:700, whiteSpace:"nowrap" }}>{hot?"★ Highlighted":"☆ Highlight"}</button>}
          <button onClick={onClose} style={{ background:"transparent", border:`1px solid ${BORDER}`, color:DIM,
            padding:"4px 10px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:11 }}>✕</button>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:10 }}>
        {/* points */}
        <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>PREDICTED POINTS</div>
          {[["Median (safe)",pred.pts_median,"#64748b"],["Mean (balanced)",pred.pts_mean,"#f97316"],
            ["P90 (diff)",pred.pts_p90,"#22c55e"],["Captain value",pred.captainValue,"#fbbf24"]].map(([l,v,c])=>(
            <div key={l} style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
              <span style={{ fontSize:11, color:DIM }}>{l}</span><span style={{ fontSize:14, fontWeight:700, color:c }}>{v.toFixed(1)}</span>
            </div>
          ))}
          <div style={{ borderTop:`1px solid ${BORDER}`, marginTop:8, paddingTop:8, fontSize:11, color:DIM }}>
            xMins/game <b style={{color:TEXT}}>{Math.round(pred.E_mins)}'</b> · Exp matches <b style={{color:TEXT}}>{pred.E_MATCHES.toFixed(1)}</b>
            {pred.scoutBonusEV>0 && <div style={{ color:"#4ade80", marginTop:4 }}>✓ Scout Bonus EV +{pred.scoutBonusEV.toFixed(1)}</div>}
          </div>
        </div>

        {/* fixture schedule */}
        <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>FIXTURE SCHEDULE</div>
          {(p.fixtures||[]).map(f => {
            const c = f.oddsWin>0.65?"#22c55e":f.oddsWin>=0.40?"#eab308":"#ef4444";
            return (
              <div key={f.md} style={{ marginBottom:9 }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:3 }}>
                  <span style={{ color:TEXT }}>MD{f.md} · {f.opponent}</span>
                  <span style={{ color:DIM }}>{Math.round(f.oddsWin*100)}/{Math.round(f.oddsDraw*100)}/{Math.round(f.oddsLoss*100)}</span>
                </div>
                <div style={{ height:5, background:"#1e293b", borderRadius:3, overflow:"hidden" }}>
                  <div style={{ width:`${f.oddsWin*100}%`, height:"100%", background:c }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* role analysis */}
        <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>ROLE ANALYSIS</div>
          {p.roleShift && p.roleShift!=="SAME" ? (
            <>
              <div style={{ fontSize:12, color:"#f97316", fontWeight:700, marginBottom:6 }}>{p.roleShift.replace(/_/g," ")}</div>
              <div style={{ fontSize:12, color:"#c8c8c8", marginBottom:8 }}>{p.roleShiftNote}</div>
              <div style={{ fontSize:11, color:DIM }}>xG ×{rm[0]} · xA ×{rm[1]}</div>
              {p.own<15 &&
                <div style={{ marginTop:8, fontSize:11, color:"#fbbf24", fontWeight:700 }}>⚠ POTENTIAL MISPRICING</div>}
            </>
          ) : <div style={{ fontSize:12, color:DIM }}>Club role consistent with international deployment.</div>}
        </div>

        {/* MODEL DEEP DIVE */}
        <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>MODEL DEEP DIVE</div>
          <ul style={{ margin:0, paddingLeft:16, fontSize:11, color:"#c8c8c8", lineHeight:1.7 }}>
            <li>xG/90 club {p.xGp90} → adjusted {pred.xGadj.toFixed(2)}</li>
            <li>Tier <b style={{color:p.tier==="S"?"#fbbf24":TEXT}}>{p.tier||"-"}</b> (score {p.tier_score ?? "—"})</li>
            <li>Playstyle: {cleanCluster(p.team_cluster)}</li>
            <li>Captain EV (R model): {p.captain_ev ?? "—"}</li>
            {p.form_n>0 && <li>Intl form: <b style={{color:p.form_mult>1.05?"#4ade80":p.form_mult<0.95?"#ff6b6b":TEXT}}>×{p.form_mult}</b> (last {p.form_n} intl match{p.form_n>1?"es":""})</li>}
          </ul>
          {p.mispricing_flag==="UNDERRATED" &&
            <div style={{ marginTop:8, fontSize:11, color:"#4ade80" }}>★ Model underprices: +{p.intl_premium_score?.toFixed(2)}σ intl premium</div>}
          {p.mispricing_flag==="OVERRATED" &&
            <div style={{ marginTop:8, fontSize:11, color:"#ff6b6b" }}>Model overprices: {p.intl_premium_score?.toFixed(2)}σ intl premium</div>}
        </div>

        {/* CAUSAL OUTLOOK */}
        {p.team_overperf_predicted != null && (
          <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
            <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>CAUSAL OUTLOOK</div>
            <div style={{ fontSize:12, color:"#c8c8c8", marginBottom:8 }}>
              Team overperformance (model): <b style={{ color: p.team_overperf_predicted>0?"#4ade80":p.team_overperf_predicted<0?"#ff6b6b":TEXT }}>
              {p.team_overperf_predicted>0?"+":""}{p.team_overperf_predicted}</b> rounds vs ELO expectation
            </div>
            {p.giant_killer_flag && <div style={{ fontSize:11, color:"#4ade80", fontWeight:700, marginBottom:4 }}>🏔 GIANT KILLER TEAM — defenders/GK underpriced vs true clean-sheet odds</div>}
            {p.overvalued_team_flag && <div style={{ fontSize:11, color:"#ff8c42", fontWeight:700, marginBottom:4 }}>⚠ OVERVALUED TEAM RISK — early-exit caps points ceiling</div>}
            <div style={{ fontSize:12, fontWeight:700, color: p.causal_pts_adjustment>0?"#4ade80":p.causal_pts_adjustment<0?"#ff6b6b":DIM }}>
              {p.causal_pts_adjustment>0?"+":""}{p.causal_pts_adjustment} pts (causal adj)
            </div>
          </div>
        )}

        {/* INTERNATIONAL FORM (sparkline) */}
        {p.form_n>0 && (
          <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
            <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>INTERNATIONAL FORM</div>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
              <Sparkline matches={p.formMatches}/>
              <span style={{ fontSize:18, fontWeight:800, color:p.form_mult>1.05?"#4ade80":p.form_mult<0.95?"#ff6b6b":TEXT }}>×{p.form_mult}</span>
            </div>
            {(p.formMatches||[]).map((m,i)=>(
              <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#c8c8c8" }}>
                <span>{m.date} · {m.opp}</span><span style={{ color:m.gi>0.6?"#4ade80":m.gi>0.3?"#eab308":DIM }}>{m.gi} xGI</span>
              </div>
            ))}
            <div style={{ fontSize:10, color:DIM, marginTop:6 }}>form multiplier applied to xG/xA vs club baseline</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TAB: STARTING XI (CSS pitch with positioned cards) ────────────────────────
function StartingXITab({ pool, mobile }) {
  const [open, setOpen] = useState(null);
  const [md, setMd] = useState(0);
  const [showDesc, setShowDesc] = useState(true);
  if (!pool || !pool.length) return <div style={{ color:DIM }}>No player data.</div>;

  // centred spread: keeps lines balanced and puts a 2-man strikeforce central (≈39/61) not on the flanks
  const ROW = n => { if (!n) return []; const step = n>1 ? Math.min(22, 76/(n-1)) : 0; return Array.from({length:n}, (_,i)=> 50 + (i-(n-1)/2)*step); };
  const score = (p, mi) => mdScore(p, mi);   // single shared per-matchday engine (no duplicate formula)
  const benchReason = (p, mi) => {
    const wins=(p.fixtures||[]).map(f=>f?.oddsWin||0), bestMd=wins.indexOf(Math.max(...wins));
    if (bestMd>mi) return `Tough MD${mi+1} fixture — key MD${bestMd+1} asset`;
    if ((p.startProb||1)<0.88) return "Rotation risk — monitor";
    if (p.own<10) return "Differential option — activate for easy fixtures";
    if (p.price<5.0) return "Budget enabler — quality backup";
    return `Strong backup — covers ${p.pos} injury risk`;
  };
  const buildXI = (mi) => {
    // budget-aware: optimise the 11 starters while RESERVING money for 4 cheap bench, so the
    // whole 15-man squad fits $100m (the old version ignored budget and overspent on the bench too)
    const sc = pool.map(p=>{ const s=score(p,mi); return {...p, mdPts:s.pts, mdOpp:s.opp, mdWin:s.win}; });
    const byScore = pos => sc.filter(p=>p.pos===pos).sort((a,b)=>b.mdPts-a.mdPts);
    const byCheap = pos => sc.filter(p=>p.pos===pos).sort((a,b)=>a.price-b.price);
    const minP = sc.reduce((mn,p)=>Math.min(mn,p.price),99)||3.8;
    const BUDGET=100, ORDER=["GK","DEF","MID","FWD"];
    let best=null;
    for (const [d,m,f] of [[3,4,3],[3,5,2],[4,3,3],[4,4,2],[4,5,1],[5,3,2],[5,4,1]]) {
      const chosen=[], team={}; let cost=0, ok=true;
      const need={GK:1,DEF:d,MID:m,FWD:f};
      const br=(1+(5-d)+(5-m)+(3-f))*minP; let sl=1+d+m+f;
      for (const pos of ORDER) {
        let got=0;
        for (const p of byScore(pos)) {
          if (got>=need[pos]) break;
          if (chosen.includes(p)||(team[p.team]||0)>=3) continue;
          const rs=(sl-1)*minP+br;
          if (cost+p.price>BUDGET-rs+1e-9) continue;
          chosen.push(p); cost+=p.price; team[p.team]=(team[p.team]||0)+1; got++; sl--;
        }
        if (got<need[pos]) { ok=false; break; }
      }
      if (!ok) continue;
      const tot=chosen.reduce((s,p)=>s+p.mdPts,0);
      if (!best||tot>best.tot) best={form:`${d}-${m}-${f}`, dims:[d,m,f], arr:chosen.slice(), tot, team:{...team}, cost};
    }
    const [d,m,f]=best.dims;
    // bench: cheapest players to complete 2/5/5/3, respecting team cap + remaining budget
    const bn={GK:1,DEF:5-d,MID:5-m,FWD:3-f}, team={...best.team}; let cost=best.cost; const benchArr=[];
    const xiIds=new Set(best.arr.map(p=>p.id));
    for (const pos of ORDER) {
      let got=0;
      for (const p of byCheap(pos)) {
        if (got>=bn[pos]) break;
        if (xiIds.has(p.id)||benchArr.includes(p)||(team[p.team]||0)>=3) continue;
        if (cost+p.price>BUDGET+1e-9) continue;
        benchArr.push(p); cost+=p.price; team[p.team]=(team[p.team]||0)+1; got++;
      }
    }
    const xs=[50,...ROW(d),...ROW(m),...ROW(f)], ys=[88,...Array(d).fill(72),...Array(m).fill(50),...Array(f).fill(22)];
    const cap=best.arr.reduce((a,b)=>b.mdPts>a.mdPts?b:a);
    const cap2 = best.arr.filter(p=>p.id!==cap.id).reduce((a,b)=>((b.pts_diff||b.mdPts)>(a.pts_diff||a.mdPts)?b:a));
    const players=best.arr.map((p,i)=>({...p, x:xs[i], y:ys[i], pts_balanced:Math.round(p.mdPts*10)/10,
      is_captain:p.id===cap.id, is_vc:p.id===cap2.id, value:+(p.mdPts/p.price).toFixed(2)}));
    const bench = benchArr.map((p,i)=>({...p, benchOrder:i+1, pts_balanced:Math.round(p.mdPts*10)/10,
      benchPts:+((p.mdPts||0)*0.3).toFixed(1), benchReason:benchReason(p,mi)}));
    return { formation:best.form, total_pts:best.tot, players, bench,
      budget:+cost.toFixed(1), captain:{...cap, opp:cap.mdOpp, win:cap.mdWin} };
  };
  const xis = [0,1,2].map(buildXI);
  const idSets = xis.map(x=>new Set(x.players.map(p=>p.id)));
  const allThree = id => idSets.every(s=>s.has(id));      // FIXTURE SHIFT = not in all 3 MD XIs
  const xi = xis[md], cap = xi.captain;
  const fixCtx = [...new Map(pool.filter(p=>(p.fixtures||[])[md]).map(p=>{const f=p.fixtures[md];return [p.team,{team:p.team,opp:f.opponent,win:f.oddsWin}];})).values()].sort((a,b)=>b.win-a.win).slice(0,5);
  const MD_DATES=["Jun 11-15","Jun 16-21","Jun 22-27"];

  return (
    <div>
      <div style={{ fontSize:16, fontWeight:800, color:"#fff", marginBottom:2 }}>Econometrics Best Fantasy XI</div>
      <div style={{ fontSize:11, color:DIM, marginBottom:12 }}>Model-selected optimal XI · Built from xPts, role regression, fixture difficulty and LP optimization</div>
      <div style={{ display:"flex", gap:4, marginBottom:12 }}>
        {[0,1,2].map(i=>(
          <button key={i} onClick={()=>setMd(i)} style={{ padding:"7px 16px", borderRadius:6, fontFamily:"inherit", fontSize:13, cursor:"pointer", fontWeight:md===i?700:400,
            border:`1px solid ${md===i?"#f97316":BORDER}`, background:md===i?"#f9731618":"transparent", color:md===i?"#f97316":DIM }}>MD{i+1}</button>
        ))}
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", flexWrap:"wrap", gap:8, marginBottom:6 }}>
        <span style={{ fontSize:15, fontWeight:800, color:"#fff" }}>Formation: {xi.formation} | Total xPts: {Math.round(xi.total_pts)} | Budget: ${xi.budget}m used</span>
        <label style={{ fontSize:11, color:DIM, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
          <input type="checkbox" checked={showDesc} onChange={e=>setShowDesc(e.target.checked)} style={{accentColor:"#f97316"}} /> Show descriptions
        </label>
      </div>
      <div style={{ fontSize:12, color:DIM, marginBottom:6 }}>MD{md+1} — {MD_DATES[md]} | optimised for matchday {md+1} fixtures</div>
      <div style={{ fontSize:12, color:"#fbbf24", marginBottom:4, fontWeight:600 }}>MD{md+1} CAPTAIN: {cap.name} vs {cap.opp} ({Math.round(cap.win*100)}% win prob)</div>
      <div style={{ fontSize:11, color:DIM, marginBottom:12 }}>Easiest fixtures: {fixCtx.map(x=>`${x.team} v ${x.opp} (${Math.round(x.win*100)}%)`).join(" · ")}</div>
      {mobile && <div style={{ fontSize:11, color:DIM, marginBottom:8 }}>Tap a player for detail · bench is below the pitch</div>}
      {<div style={{ position:"relative", width:"100%", maxWidth:560, margin:"0 auto", aspectRatio:"3/4",
        background:"linear-gradient(#0a3d1f,#072d17)", border:`2px solid #1e6b3a`, borderRadius:10 }}>
        <div style={{ position:"absolute", top:"50%", left:0, right:0, height:1, background:"#2e7d4f" }} />
        <div style={{ position:"absolute", left:"30%", right:"30%", bottom:0, height:"14%", border:"1px solid #2e7d4f", borderBottom:"none" }} />
        {xi.players.map(pl => (
          <div key={pl.id} onClick={()=>setOpen(open===pl.id?null:pl.id)}
            style={{ position:"absolute", left:`${pl.x}%`, top:`${pl.y}%`, transform:"translate(-50%,-50%)",
              textAlign:"center", cursor:"pointer", width: mobile?58:84 }}>
            <div style={{ width: mobile?40:52, height: mobile?40:52, margin:"0 auto", borderRadius:"50%", background:POS_COLOR[pl.pos], display:"flex",
              alignItems:"center", justifyContent:"center", fontSize: mobile?11:13, fontWeight:800, color:"#fff",
              border: pl.is_captain ? "3px solid #fbbf24" : pl.is_vc ? "3px solid #cbd5e1" : "2px solid #ffffff55", position:"relative" }}>
              {pl.pts_balanced}
              {pl.is_captain && <span style={{ position:"absolute", top:-6, right:-6, width:18, height:18, fontSize:10, fontWeight:800, background:"#fbbf24", color:"#000", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center" }}>C</span>}
              {pl.is_vc && <span style={{ position:"absolute", top:-6, right:-6, width:18, height:18, fontSize:8, fontWeight:800, background:"#cbd5e1", color:"#000", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center" }}>VC</span>}
            </div>
            <div style={{ fontSize: mobile?9:12, color:"#fff", fontWeight:700, marginTop:3, textShadow:"0 1px 3px #000", maxWidth: mobile?56:80, marginLeft:"auto", marginRight:"auto", lineHeight:1.1, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }}>{pl.name}</div>
            {pl.mdOpp && <div style={{ fontSize: mobile?8:9, color:"#9fb4c9", textShadow:"0 1px 3px #000", marginTop:1 }}>vs {pl.mdOpp}</div>}
            {pl.is_captain && <div style={{ fontSize:10, color:"#f97316", fontWeight:700 }}>2× pts</div>}
            {pl.is_vc && <div style={{ fontSize:10, color:"#f97316" }}>2× if C DNP</div>}
          </div>
        ))}
      </div>}
      {!mobile && (
        <div style={{ width:"100%", maxWidth:560, margin:"4px auto 0", background:"#06210f", border:`2px solid #1e6b3a`, borderRadius:10, padding:"8px 10px" }}>
          <div style={{ fontSize:9, letterSpacing:2, color:"#7fa890", fontFamily:MONO, marginBottom:6 }}>BENCH (auto-sub order)</div>
          <div style={{ display:"flex", gap:8 }}>
            {(xi.bench||[]).map(b=>(
              <div key={b.id} onClick={()=>setOpen(open===b.id?null:b.id)} style={{ textAlign:"center", cursor:"pointer", flex:"1 1 0", minWidth:0 }}>
                <div style={{ width:40, height:40, margin:"0 auto", borderRadius:"50%", background:POS_COLOR[b.pos], display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:800, color:"#fff", border:"2px solid #ffffff44" }}>{b.pts_balanced}</div>
                <div style={{ fontSize:10, color:"#fff", fontWeight:600, marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{b.name}</div>
                <div style={{ fontSize:9, color:"#7fa890" }}>{b.pos} · ${b.price}m</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ display:"grid", gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fill,minmax(260px,1fr))", gap:10, marginTop:16 }}>
        {xi.players.map(pl => (
          <div key={pl.id} onClick={()=>setOpen(open===pl.id?null:pl.id)}
            style={{ background:CARD, border:`1px solid ${pl.is_captain?"#fbbf24":BORDER}`, borderRadius:8, padding:"10px 12px", cursor:"pointer" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ color:"#fff", fontWeight:700, fontSize:14 }}>{pl.name} {pl.is_captain && <span style={{color:"#fbbf24"}}>©</span>}
                {!allThree(pl.id) && <span style={{ fontSize:9, color:"#f97316", marginLeft:6, fontFamily:MONO }}>⇄ SHIFT</span>}</span>
              <span style={{ fontSize:12, color:POS_COLOR[pl.pos], fontFamily:MONO }}>{pl.pos}</span>
            </div>
            <div style={{ fontSize:11, color:DIM, margin:"4px 0" }}>{pl.team} · ${pl.price}m · {pl.pts_balanced} xPts · {pl.value} val</div>
            {showDesc && (() => {
              const E = "3";   // group-stage scope (MD1–3)
              const why = `MD${md+1} pick — ${Math.round(pl.mdWin*100)}% win vs ${pl.mdOpp}, ${pl.pts_balanced} xPts.`;
              const key = (pl.pos==="GK"||pl.pos==="DEF")
                ? `Clean sheet prob ${Math.round((pl.csP||0)*100)}% → expected CS pts (adv ${pl.advP}%, ~${E} matches)`
                : `npxG/90 ${(pl.xGp90||0).toFixed(2)} → goal threat (adv ${pl.advP}%, ~${E} matches)`;
              const risk = pl.own>40 ? `⚠ ${pl.own}% owned — template, no mini-league edge`
                : pl.cardRisk==="high" ? "⚠ High card risk — avoid captaining"
                : (pl.startProb||1)<0.88 ? "⚠ Rotation possible if group already won"
                : "✓ Low risk profile";
              return (
                <div style={{ marginTop:6, borderTop:`1px solid ${BORDER}`, paddingTop:6, fontSize:11, lineHeight:1.5 }}>
                  <div style={{ color:"#c8c8c8" }}>{why}</div>
                  <div style={{ color:"#94a3b8", marginTop:3 }}>{key}</div>
                  <div style={{ color: risk.startsWith("✓")?"#4ade80":"#ff8c42", marginTop:3 }}>{risk}</div>
                </div>
              );
            })()}
          </div>
        ))}
      </div>

      {/* BENCH */}
      <div style={{ marginTop:18 }}>
        <div style={{ fontSize:11, letterSpacing:2, color:DIM, marginBottom:8, fontFamily:MONO }}>BENCH — AUTO-SUB ORDER</div>
        <div style={{ display:"flex", gap:10, flexWrap: mobile?"nowrap":"wrap", overflowX: mobile?"auto":"visible", WebkitOverflowScrolling:"touch", paddingBottom: mobile?6:0 }}>
          {(xi.bench||[]).map(b=>(
            <div key={b.id} style={{ flex: mobile?"0 0 70%":"1 1 170px", background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:"10px 12px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>
                  <span title={`Priority ${b.benchOrder} auto-sub — activates if a starter does not play`} style={{ background:"#1e293b", color:"#94a3b8", borderRadius:4, padding:"0 5px", fontSize:10, marginRight:5, fontFamily:MONO, cursor:"help" }}>{b.benchOrder}</span>
                  {b.name}</span>
                <span style={{ fontSize:11, color:POS_COLOR[b.pos], fontFamily:MONO }}>{b.pos}</span>
              </div>
              <div style={{ fontSize:11, color:DIM, margin:"4px 0" }}>${b.price}m · Bench EV: {b.benchPts} pts</div>
              <div style={{ fontSize:11, color:"#94a3b8" }}>{b.benchReason}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── TAB: OPTIMAL SQUADS ─────────────────────────────────────────────────────────
// Squad builder (client-side). Optimises the STARTING XI's points and fills the 4 bench slots with the
// CHEAPEST valid players — so it never wastes budget stacking 8 premium attackers (only 7 can start) and
// it spends on a real starting keeper. 2/5/5/3, $100m, ≤3 per team; always returns a valid, complete 15.
function buildBalancedSquad(pool, scoreFn, spMin, opts = {}) {
  const benchSp = opts.benchSpMin ?? 0.70, benchMinPts = opts.benchMinPts ?? 8;
  const restricted = pool.filter(p => p.price > 0 && (!opts.candFilter || opts.candFilter(p)));
  const elig = restricted.length >= 18 ? restricted : pool.filter(p => p.price > 0);  // never over-restrict
  const byScore = pos => elig.filter(p => p.pos === pos && (!spMin || (p.startProb || 0) >= spMin)).sort((a, b) => scoreFn(b) - scoreFn(a));
  // BENCH = cheapest DEPENDABLE starters (real minutes + decent points), not budget passengers
  const benchPool = pos => {
    const good = elig.filter(p => p.pos === pos && (p.startProb || 0) >= benchSp && (p.pts_balanced || 0) >= benchMinPts).sort((a, b) => a.price - b.price);
    return good.length ? good : elig.filter(p => p.pos === pos).sort((a, b) => a.price - b.price);
  };
  const minP = elig.reduce((m, p) => Math.min(m, p.price), 99) || 3.8;
  const benchMinP = 4.2;   // reserve enough that the 4 bench slots can be real starters, not $3.5 scrubs
  const FORMS = [[3,4,3],[3,5,2],[4,3,3],[4,4,2],[4,5,1],[5,3,2],[5,4,1]];
  const BUDGET = 100, ORDER = ["GK","DEF","MID","FWD"];
  let best = null;
  for (const [d, m, f] of FORMS) {
    const chosen = [], team = {}; let cost = 0, ok = true;
    const need = { GK:1, DEF:d, MID:m, FWD:f };
    const benchNeed = { GK:1, DEF:5-d, MID:5-m, FWD:3-f };
    const benchReserve = (1 + (5-d) + (5-m) + (3-f)) * benchMinP;   // reserve for DECENT bench
    let slotsLeft = 1 + d + m + f;
    for (const pos of ORDER) {                                  // STARTERS — best score, budget-aware
      let got = 0;
      for (const p of byScore(pos)) {
        if (got >= need[pos]) break;
        if (chosen.includes(p) || (team[p.team] || 0) >= 3) continue;
        const reserve = (slotsLeft - 1) * minP + benchReserve;
        if (cost + p.price > BUDGET - reserve + 1e-9) continue;
        chosen.push(p); cost += p.price; team[p.team] = (team[p.team] || 0) + 1; got++; slotsLeft--;
      }
      if (got < need[pos]) { ok = false; break; }
    }
    if (!ok) continue;
    const xiPts = chosen.reduce((s, p) => s + scoreFn(p), 0);
    const starterIds = new Set(chosen.map(p => p.id));
    for (const pos of ORDER) {                                  // BENCH — cheapest dependable starter
      let got = 0;
      for (const p of benchPool(pos)) {
        if (got >= benchNeed[pos]) break;
        if (chosen.includes(p) || (team[p.team] || 0) >= 3) continue;
        if (cost + p.price > BUDGET + 1e-9) continue;
        chosen.push(p); cost += p.price; team[p.team] = (team[p.team] || 0) + 1; got++;
      }
      if (got < benchNeed[pos]) { ok = false; break; }
    }
    if (!ok || chosen.length !== 15) continue;
    if (!best || xiPts > best.xiPts) best = { chosen, starterIds, xiPts, form: `${d}-${m}-${f}`, cost };
  }
  if (!best && (spMin || opts.candFilter)) return buildBalancedSquad(pool, scoreFn, spMin ? Math.max(0, spMin - 0.1) : 0, { ...opts, candFilter: null });
  return best;
}
function buildOptimalSquads(pool) {
  if (!pool || !pool.length) return { squads: null, meta: {} };
  const scoutB = p => (p.own < 5 ? 3 : 0);   // scout-bonus tilt (FIFA: eligible only <5% owned)
  const defs = {
    safe:      { label: "Safe — Minutes Certainty", description: "Nailed-on starters only (start prob ≥ 0.80). Bench are the cheapest dependable starters, not passengers. For people who put on a helmet when driving their car to work — this is Arteta-ball in fantasy mode.", objective: "max XI Σ pts_safe", score: p => p.pts_safe || 0, sp: 0.80 },
    balanced:  { label: "Balanced — Core + Edge", description: "Best expected group-stage points; every pick (incl. bench) is a real starter.", objective: "max XI Σ pts_balanced", score: p => p.pts_balanced || 0, sp: 0.75 },
    diff:      { label: "Differential — Value Hunt", description: "Low-owned starters (<25%) with decent minutes & points, tilted toward scout-bonus picks.", objective: "max XI Σ (pts_balanced + scout-bonus EV) · own < 25%", score: p => (p.pts_balanced || 0) + scoutB(p), sp: 0.70, opts: { candFilter: p => p.own < 25, benchMinPts: 8 } },
    psychopath:{ label: "Psychopath — Giant-Killers", description: "Starters at underdog / giant-killer sides (Morocco, Japan, NZ…) who could pull an upset — high ceiling, barely owned. For absolutely fucking mentally ill people who should be locked up — but if things go right they'll win this shit.", objective: "max XI Σ pts_diff × giant-killer × scarcity", score: p => (p.pts_diff || 0) * (p.giant_killer_flag ? 2.2 : 1) * (p.own < 10 ? 1.3 : 1) * ((p.pos === "MID" || p.pos === "FWD") ? 1.15 : 1), sp: 0.70, opts: { candFilter: p => p.own < 35, benchMinPts: 7 } },
  };
  const squads = {}, meta = {};
  Object.entries(defs).forEach(([k, d]) => {
    const r = buildBalancedSquad(pool, d.score, d.sp, d.opts);
    if (!r) { squads[k] = []; meta[k] = { label: d.label, description: d.description, objective: d.objective }; return; }
    const sq = r.chosen.map(p => ({ id: p.id, name: p.name, pos: p.pos, price: p.price, pts: Math.round((p.pts_balanced || 0) * 10) / 10, own: p.own, start: r.starterIds.has(p.id) }));
    squads[k] = sq;
    const xi = sq.filter(p => p.start);
    const tot = xi.reduce((s, p) => s + p.pts, 0), bud = sq.reduce((s, p) => s + p.price, 0);
    const own = sq.length ? sq.reduce((s, p) => s + (p.own || 0), 0) / sq.length : 0;
    meta[k] = { label: d.label, description: d.description + ` · ${r.form} · group-stage xPts`, objective: d.objective,
      total_pts: Math.round(tot), budget: Math.round(bud * 10) / 10, avg_own: Math.round(own * 10) / 10,
      n_scout: sq.filter(p => (p.own || 0) < 5).length, template_overlap_pct: Math.round(sq.filter(p => (p.own || 0) > 20).length / (sq.length || 1) * 100) };
  });
  return { squads, meta };
}

function OptimalSquadsTab({ squads, meta, mobile }) {
  if (!squads) return <div style={{ color:DIM }}>No squad data — run the R pipeline.</div>;
  return (
    <div style={{ display:"grid", gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fit,minmax(250px,1fr))", gap:12 }}>
      {Object.entries(squads).map(([key, sq]) => {
        if (!sq) return null;
        const m = (meta && meta[key]) || {};
        return (
          <div key={key} style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"12px 14px" }}>
            <div style={{ fontSize:14, fontWeight:800, color:"#fff", marginBottom:3, display:"flex", alignItems:"center", gap:6 }}>{key==="psychopath" && <img src="/img/makkauijau.png" alt="" className="mki-shake" style={{ height:24 }} />}{key==="safe" && <img src="/img/tucheliban.png" alt="tucheliban" title="tucheliban" className="mki-shake" style={{ height:28, width:28, borderRadius:"50%", objectFit:"cover" }} />}{m.label||key}</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6, lineHeight:1.45 }}>{m.description||""}</div>
            <div style={{ fontSize:mobile?11:10, color:"#475569", fontFamily:MONO, marginBottom:8 }}>{m.objective||""}</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:10, fontSize:11, color:DIM, marginBottom:10, borderBottom:`1px solid ${BORDER}`, paddingBottom:8 }}>
              <span><b style={{color:TEXT}}>{m.total_pts??"—"}</b> XI pts</span>
              <span><b style={{color:TEXT}}>${m.budget??"—"}m</b></span>
              <span>own <b style={{color:TEXT}}>{m.avg_own??"—"}%</b></span>
              <span>scout <b style={{color:"#4ade80"}}>{m.n_scout??0}</b></span>
              <span>template <b style={{color:TEXT}}>{m.template_overlap_pct??"—"}%</b></span>
            </div>
            {["GK","DEF","MID","FWD"].map(pos => (
              <div key={pos} style={{ marginBottom:6 }}>
                <div style={{ fontSize:9, color:POS_COLOR[pos], letterSpacing:1, marginBottom:2 }}>{pos}</div>
                {sq.filter(p=>p.pos===pos).sort((a,b)=>(b.start?1:0)-(a.start?1:0)).map(p => (
                  <div key={p.id} style={{ display:"flex", justifyContent:"space-between", fontSize:11, padding:"2px 0", opacity:p.start===false?0.5:1 }}>
                    <span style={{ color:"#e2e8f0" }}>{p.name}{p.start===false && <span style={{ color:DIM, fontSize:9 }}> · bench</span>}</span>
                    <span style={{ color:DIM }}>${p.price} · {p.pts}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── TAB: TIERS ──────────────────────────────────────────────────────────────────
const BAND_CUT = { GK:[4.1,5.0], DEF:[4.4,5.5], MID:[6.4,8.5], FWD:[6.9,9.0] };  // [budgetMax, premiumMin]
const bandOf = (pos,pr) => { const c=BAND_CUT[pos]||[6.4,8.5]; return pr>=c[1]?"PREMIUM":pr<=c[0]?"BUDGET":"MID-RANGE"; };
const TIER_COLOR = { S:"#fbbf24", A:"#cbd5e1", B:"#d97706", C:"#64748b", D:"#475569" };

function TiersTab({ tiers, pool, riskMode, posFilter, setPosFilter, pureDiff, setPureDiff, mobile }) {
  const [tierTab, setTierTab] = useState("S");
  const [open, setOpen] = useState(null);
  if (!pool || !pool.length) return <div style={{ color:DIM }}>No data.</div>;
  const xptsOf = p => riskMode==="safe"?p.pts_safe : riskMode==="diff"?p.pts_diff : p.pts_balanced;
  const narr = {}; ["S","A","B"].forEach(t=>(tiers?.[t]||[]).forEach(n=>{narr[n.id]=n;}));
  const bestInBand = {};
  pool.forEach(p=>{ const k=p.pos+"|"+bandOf(p.pos,p.price); if(!bestInBand[k]||(p.tier_score||0)>bestInBand[k].ts) bestInBand[k]={id:p.id, ts:p.tier_score||0}; });
  const BANDS=["PREMIUM","MID-RANGE","BUDGET"], POSES=["GK","DEF","MID","FWD"];

  const card = (p) => {
    const band=bandOf(p.pos,p.price), n=narr[p.id]||{}, tc=TIER_COLOR[p.tier]||DIM;
    const isBest=bestInBand[p.pos+"|"+band]?.id===p.id;
    return (
      <div key={p.id} onClick={()=>setOpen(open===p.id?null:p.id)}
        style={{ background:CARD, border:`1.5px solid ${tc}`, borderRadius:10, padding:"11px 13px", cursor:"pointer", marginBottom:8, boxShadow:p.tier==="S"?"0 0 12px #fbbf2422":"none" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
          <span style={{ color:"#fff", fontWeight:700, fontSize:14 }}>{flagOf(p)} {p.name}</span>
          <span style={{ fontSize:12, color:tc, fontWeight:800 }} title={TIER_TIP[p.tier]}>{(p.tier_score||0).toFixed(0)}</span>
        </div>
        <div style={{ display:"flex", gap:5, alignItems:"center", marginBottom:6, flexWrap:"wrap" }}>
          <span style={{ fontSize:11, color:DIM }}>{p.team}</span>
          <span title={POS_TIP[p.pos]} style={{ fontSize:10, color:POS_COLOR[p.pos], border:`1px solid ${POS_COLOR[p.pos]}44`, padding:"0 5px", borderRadius:3, fontFamily:MONO, cursor:"help" }}>{p.pos}</span>
          <span style={{ fontSize:11, color:DIM }}>${p.price}m · {band}</span>
          {isBest && <Badge bg="#3b2f0a" bd="#fbbf24" fg="#fbbf24" title="Highest tier score in this position + price band">BEST IN BAND</Badge>}
          {p.own<5 && <ScoutBadge/>}
          {p.mispricing_flag==="UNDERRATED" && <Badge bg="#16a34a22" bd="#22c55e88" fg="#4ade80" title={`Model edge: +${(p.intl_premium_score||0).toFixed(2)}σ vs club stats`}>★ MODEL EDGE</Badge>}
          {p.roleShift && p.roleShift!=="SAME" && <Badge bg="#f9731618" bd="#f9731688" fg="#f97316" title={`Role shift: ${p.roleShiftNote||p.roleShift}`}>↑ ROLE SHIFT</Badge>}
          {p.aerial_threat && <Badge bg="#0ea5e918" bd="#38bdf888" fg="#38bdf8" title={`Aerial threat — wins ${p.aerial_won_p90??"?"} aerials/90 at ${p.aerial_won_pct??"?"}% (club, FBref)`}>🛩 AERIAL</Badge>}
        </div>
        <OwnBar pct={p.own}/>
        <div style={{ fontSize:12, color:TEXT, marginTop:6 }}>{xptsOf(p)?.toFixed(1)} xPts <span style={{color:DIM,fontSize:10}}>({riskMode})</span></div>
        <div style={{ fontSize:11, color:"#94a3b8", marginTop:4, fontStyle:"italic" }}>{n.one_line_verdict||n.headline||""}</div>
        {open===p.id && (
          <div style={{ marginTop:8, borderTop:`1px solid ${BORDER}`, paddingTop:8, fontSize:11, color:"#c8c8c8", lineHeight:1.6 }}>
            <div style={{ marginBottom:5 }}><b style={{color:TIER_COLOR[p.tier]}}>CEILING:</b> {n.ceiling_case||"—"}</div>
            <div style={{ marginBottom:5 }}><b style={{color:"#4ade80"}}>EDGE:</b> {n.differential_edge||"—"}</div>
            <div style={{ marginBottom:5, color:"#ff8c42" }}><b>RISK:</b> {n.floor_warning||"—"}</div>
            {p.captainSlot===3 && n.captain_verdict && <div style={{ color:"#fbbf24" }}>{n.captain_verdict}</div>}
          </div>
        )}
      </div>
    );
  };

  const tierPlayers = pool.filter(p=>p.tier===tierTab && (posFilter==="ALL"||p.pos===posFilter) && (!pureDiff||p.own<=15));
  return (
    <div>
      {/* BEST VALUE BY BAND */}
      <div style={{ fontSize:13, fontWeight:900, color:"#fff", letterSpacing:1, marginBottom:10 }}>BEST VALUE BY BAND</div>
      <div style={{ marginBottom:24 }}>
        {BANDS.map(b=>(
          <div key={b} style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:800, color:"#f97316", letterSpacing:1, marginBottom:6 }}>{b}</div>
            <div style={{ display:"grid", gridTemplateColumns: mobile ? "repeat(2,1fr)" : "repeat(4,1fr)", gap:8 }}>
              {POSES.map(pos=>{
                const best=pool.filter(p=>p.pos===pos&&bandOf(p.pos,p.price)===b).sort((a,c)=>(c.tier_score||0)-(a.tier_score||0))[0];
                if(!best) return (
                  <div key={b+pos} style={{ background:CARD, border:`1px dashed ${BORDER}`, borderRadius:8, padding:"9px 11px", opacity:0.5 }}>
                    <div style={{ fontSize:9, color:DIM, letterSpacing:1 }}>BEST {b} {pos}</div>
                    <div style={{ fontSize:11, color:DIM, marginTop:6 }}>—</div>
                  </div>);
                const tc=TIER_COLOR[best.tier]||DIM; const n=narr[best.id]||{};
                return (
                  <div key={b+pos} style={{ background:CARD, border:`2px solid ${tc}`, borderRadius:8, padding:"9px 11px" }}>
                    <div style={{ fontSize:9, color:DIM, letterSpacing:1, marginBottom:3 }}>BEST {b} {pos}</div>
                    <div style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{TEAM_FLAG[best.team]||best.nat||"🏳️"} {best.name}</div>
                    <div style={{ fontSize:11, color:DIM, marginTop:2 }}><b style={{color:tc}}>{best.tier}</b> · {xptsOf(best)?.toFixed(1)} xPts · ${best.price}m</div>
                    <div style={{ fontSize:10, color:"#94a3b8", marginTop:3, fontStyle:"italic" }}>{(n.one_line_verdict||n.headline||"").slice(0,70)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* tier tabs + filters */}
      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
        {["S","A","B"].map(t=>(
          <button key={t} className="tier-tab" onClick={()=>setTierTab(t)} style={{ padding:"7px 16px", borderRadius:6, fontFamily:"inherit", fontSize:13, fontWeight:tierTab===t?800:400, cursor:"pointer",
            border:`1px solid ${tierTab===t?TIER_COLOR[t]:BORDER}`, background:tierTab===t?`${TIER_COLOR[t]}18`:"transparent", color:tierTab===t?TIER_COLOR[t]:DIM }}>{t} TIER</button>
        ))}
        <span style={{ width:12 }} />
        {["ALL","FWD","MID","DEF","GK"].map(pos=>(
          <button key={pos} className="filter-btn" onClick={()=>setPosFilter(pos)} style={{ padding:"6px 11px", borderRadius:6, fontFamily:"inherit", fontSize:12, cursor:"pointer",
            border:`1px solid ${posFilter===pos?(POS_COLOR[pos]||"#f97316"):BORDER}`, background:posFilter===pos?`${(POS_COLOR[pos]||"#f97316")}18`:"transparent", color:posFilter===pos?(POS_COLOR[pos]||"#f97316"):DIM }}>{pos}</button>
        ))}
        <button onClick={()=>setPureDiff(v=>!v)} style={{ padding:"6px 11px", borderRadius:6, fontFamily:"inherit", fontSize:12, cursor:"pointer", marginLeft:"auto",
          border:`1px solid ${pureDiff?"#4ade80":BORDER}`, background:pureDiff?"#16a34a22":"transparent", color:pureDiff?"#4ade80":DIM }}>PURE DIFFERENTIALS</button>
      </div>

      {/* band grid (single column on mobile — bands become section headers) */}
      <div style={{ display:"grid", gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fit,minmax(280px,1fr))", gap:14 }}>
        {BANDS.map(b=>(
          <div key={b}>
            <div style={{ fontSize:12, fontWeight:800, color:"#fff", letterSpacing:1, marginBottom:8, borderBottom:`2px solid ${BORDER}`, paddingBottom:4 }}>{b}</div>
            {POSES.map(pos=>{
              const grp=tierPlayers.filter(p=>p.pos===pos&&bandOf(p.pos,p.price)===b).sort((a,c)=>(c.tier_score||0)-(a.tier_score||0));
              if(!grp.length) return null;
              return (<div key={pos} style={{ marginBottom:6 }}>
                <div style={{ fontSize:9, color:POS_COLOR[pos], letterSpacing:1, marginBottom:4 }}>{pos}</div>
                {grp.map(card)}
              </div>);
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── TAB: CAUSAL (overperformance model + giant killers + historical scatter) ──
function CausalTab({ causal, players }) {
  if (!causal) return <div style={{ color:DIM }}>No causal analysis — run the R pipeline (09).</div>;
  const coefs = (causal.stage2_coefficients || []).filter(c => c.term !== "(Intercept)");
  const maxAbs = Math.max(...coefs.map(c => Math.abs(c.Estimate)), 1);
  const preds = causal.overperformance_predictions || [];
  const killers = preds.filter(t => t.giant_killer_flag);
  const overv = preds.filter(t => t.overvalued_flag);
  const hist = causal.historical || [];
  const teamPlayers = (tm) => players.filter(p => p.team === tm).map(p => p.name);
  // scatter scales
  const elos = hist.map(h => h.elo_entering); const eMin = Math.min(...elos, 1480), eMax = Math.max(...elos, 1990);
  const sx = e => 6 + ((e - eMin) / (eMax - eMin)) * 88;          // % x
  const sy = r => 92 - (r / 5) * 84;                              // % y (rounds 0-5)
  const notable = { "Iceland2016":1, "Morocco2022":1, "Germany2022":1, "Croatia2018":1, "Denmark2021":1, "Argentina2022":1 };

  return (
    <div>
      {/* SECTION 1 — coefficient plot */}
      <div style={{ marginBottom:8, fontSize:15, fontWeight:800, color:"#fff" }}>What Predicts Beating Expectations</div>
      <div style={{ fontSize:11, color:DIM, marginBottom:12 }}>
        Stage-2 causal predictors (controlling for team quality) · major tournaments 2016–2024 ·
        adj R² {causal.model_summary?.stage2_adj_r2}. <span style={{ color:"#ff8c42" }}>{causal.model_summary?.model_warning}</span>
      </div>
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"14px 16px", marginBottom:24 }}>
        {coefs.map(c => {
          const pos = c.Estimate >= 0, w = (Math.abs(c.Estimate) / maxAbs) * 50;
          return (
            <div key={c.term} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
              <div style={{ width:170, fontSize:11, color:"#c8c8c8", textAlign:"right" }}>{c.term.replace(/_/g," ")}</div>
              <div style={{ flex:1, display:"flex", alignItems:"center", position:"relative", height:18 }}>
                <div style={{ position:"absolute", left:"50%", top:0, bottom:0, width:1, background:BORDER }} />
                <div style={{ position:"absolute", left:pos?"50%":`${50-w}%`, width:`${w}%`, height:14,
                  background:pos?"#22c55e":"#ef4444", borderRadius:2 }} />
              </div>
              <div style={{ width:54, fontSize:11, color:pos?"#4ade80":"#ff6b6b", textAlign:"left" }}>
                {pos?"+":""}{c.Estimate.toFixed(2)}</div>
            </div>
          );
        })}
        <div style={{ fontSize:10, color:DIM, marginTop:6 }}>← hurts overperformance · helps overperformance →</div>
      </div>

      {/* SECTION 2 — giant killers vs overvalued */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:16, marginBottom:24 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:900, color:"#4ade80", letterSpacing:1, marginBottom:10 }}>🏔 GIANT KILLERS (iceland ≥ 4)</div>
          {killers.length===0 && <div style={{ color:DIM, fontSize:12 }}>None flagged.</div>}
          {killers.map(t => (
            <div key={t.team} style={{ background:CARD, border:"1px solid #22c55e55", borderRadius:8, padding:"10px 12px", marginBottom:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"#fff", fontWeight:700 }}>{t.team}</span>
                <span style={{ color:"#4ade80", fontSize:12 }}>iceland {t.iceland_score}/6 · +{t.overperformance_predicted} rounds</span>
              </div>
              <div style={{ fontSize:11, color:DIM, marginTop:4 }}>ELO {t.elo_entering} · expected {t.rounds_expected} rounds · {t.confidence} confidence</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>Underpriced players: {teamPlayers(t.team).join(", ")||"—"}</div>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize:13, fontWeight:900, color:"#ff8c42", letterSpacing:1, marginBottom:10 }}>⚠ OVERVALUED (germany 2022 print)</div>
          {overv.length===0 && <div style={{ color:DIM, fontSize:12 }}>None flagged.</div>}
          {overv.map(t => (
            <div key={t.team} style={{ background:CARD, border:"1px solid #ff8c4255", borderRadius:8, padding:"10px 12px", marginBottom:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"#fff", fontWeight:700 }}>{t.team}</span>
                <span style={{ color:"#ff8c42", fontSize:12 }}>{t.overperformance_predicted} rounds</span>
              </div>
              <div style={{ fontSize:11, color:DIM, marginTop:4 }}>ELO {t.elo_entering} · dispersed squad, low cohesion</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>Premium risk: {teamPlayers(t.team).join(", ")||"—"}</div>
            </div>
          ))}
        </div>
      </div>

      {/* SECTION 3 — historical scatter */}
      <div style={{ fontSize:13, fontWeight:800, color:"#fff", marginBottom:4 }}>The Iceland Test — Historical Overperformers</div>
      <div style={{ fontSize:11, color:DIM, marginBottom:10 }}>ELO entering (x) vs rounds reached (y) · green = beat expectation, red = fell short · 2016–2024</div>
      <div style={{ position:"relative", width:"100%", maxWidth:640, height:300, background:CARD, border:`1px solid ${BORDER}`, borderRadius:10 }}>
        {[0,1,2,3,4,5].map(r => (
          <div key={r} style={{ position:"absolute", left:0, right:0, top:`${sy(r)}%`, borderTop:`1px dashed ${BORDER}55`, fontSize:9, color:DIM }}>
            <span style={{ position:"absolute", left:2, top:-6 }}>{["Grp","R16","QF","SF","Fin","Win"][r]}</span></div>
        ))}
        {hist.map((h,i) => {
          const key = h.team + h.year, label = notable[key];
          const c = h.overperformance > 0.3 ? "#22c55e" : h.overperformance < -0.3 ? "#ef4444" : "#94a3b8";
          const sz = 6 + Math.min(Math.abs(h.overperformance) * 5, 12);
          return (
            <div key={i} title={`${h.team} ${h.year}: reached ${h.rounds_reached}, expected ${h.rounds_expected} (${h.overperformance>0?"+":""}${h.overperformance})`}
              style={{ position:"absolute", left:`${sx(h.elo_entering)}%`, top:`${sy(h.rounds_reached)}%`,
                transform:"translate(-50%,-50%)", width:sz, height:sz, borderRadius:"50%", background:c,
                border: label?"2px solid #fff":"none" }}>
              {label && <span style={{ position:"absolute", left:sz+2, top:-4, fontSize:9, color:"#fff", whiteSpace:"nowrap" }}>{h.team} {String(h.year).slice(2)}</span>}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize:10, color:"#475569", marginTop:8 }}>
        Iceland/Germany fingerprints are heuristic pattern-matching, not model output. 2026 composition features are estimated.
        Closest 2026 "Iceland": <b style={{color:"#4ade80"}}>{causal.iceland_2016_analysis?.closest_2026_match}</b>.
      </div>
    </div>
  );
}

// ─── TAB: LINEUPS (Change 8 — reads pre-fetched public/data/lineups.json) ──────
const LU_GROUPS = {A:["Mexico","South Korea","South Africa","Czech Republic"],B:["Canada","Switzerland","Qatar","Bosnia and Herzegovina"],C:["Brazil","Morocco","Scotland","Haiti"],D:["United States","Paraguay","Australia","Turkey"],E:["Germany","Curacao","Ivory Coast","Ecuador"],F:["Netherlands","Japan","Sweden","Tunisia"],G:["Belgium","Egypt","Iran","New Zealand"],H:["Spain","Cape Verde","Saudi Arabia","Uruguay"],I:["France","Senegal","Iraq","Norway"],J:["Argentina","Algeria","Austria","Jordan"],K:["Portugal","DR Congo","Uzbekistan","Colombia"],L:["England","Croatia","Ghana","Panama"]};
const LU_CONF = {UEFA:["Spain","France","England","Germany","Portugal","Netherlands","Belgium","Croatia","Switzerland","Austria","Norway","Scotland","Sweden","Czech Republic","Bosnia and Herzegovina","Turkey"],CONMEBOL:["Brazil","Argentina","Uruguay","Colombia","Ecuador","Paraguay"],CAF:["Morocco","Senegal","Egypt","Algeria","Tunisia","Ivory Coast","South Africa","DR Congo","Cape Verde","Ghana"],AFC:["Japan","South Korea","Iran","Saudi Arabia","Qatar","Australia","Iraq","Uzbekistan","Jordan"],CONCACAF:["Mexico","United States","Canada","Panama","Haiti","Curacao"],OFC:["New Zealand"]};
const LU_GROUP_OF = {}; Object.entries(LU_GROUPS).forEach(([g,ts])=>ts.forEach(t=>LU_GROUP_OF[t]=g));
// pitch layout: each slot → a vertical row + a left-right order. Players in the same row are
// spread horizontally (so a double pivot sits side-by-side, two strikers sit central, LB/RB on
// the correct flanks, and CAM sits on its own row ABOVE the CM/CDM line).
const PITCH_ROW_Y = { GK:88, DEF:70, MID:50, AM:34, FWD:18 };
const SLOT_ROW = { GK:"GK",
  LB:"DEF",LWB:"DEF",LCB:"DEF",CB:"DEF",RCB:"DEF",RB:"DEF",RWB:"DEF",
  CDM:"MID",LDM:"MID",RDM:"MID",LM:"MID",LCM:"MID",CM:"MID",RCM:"MID",RM:"MID",
  CAM:"AM",LAM:"AM",RAM:"AM",
  LW:"FWD",LF:"FWD",ST:"FWD",CF:"FWD",RF:"FWD",RW:"FWD" };
const SLOT_ORDER = { GK:50,
  LB:10,LWB:6,LCB:34,CB:50,RCB:66,RB:90,RWB:94,
  LDM:36,CDM:50,RDM:64, LM:12,LCM:36,CM:50,RCM:64,RM:88,
  LAM:30,CAM:50,RAM:70, LW:14,LF:36,ST:50,CF:50,RF:64,RW:86 };
const POS_ROW = { GK:"GK", DEF:"DEF", MID:"MID", FWD:"FWD" };
const luNorm = s => (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z ]/g," ").trim();
const luStatusColor = (status, pos) => status==="DOUBT" ? "#eab308" : status==="OUT" ? "#475569"
  : status==="PROBABLE" ? (POS_COLOR[pos]||"#888")+"aa" : (POS_COLOR[pos]||"#888");

function LineupReview({ L }) {
  const [open, setOpen] = useState(false);
  const conf = L.confidence, rev = L.review || {};
  const nCorr = (rev.errors_found || []).length;
  let b;
  if (conf === "SEED_DATA" || conf === "AI_PREDICTED") b = { txt:"🤖 AI predicted lineup — based on squad knowledge", bg:"#0a1322", bd:BORDER, fg:"#60a5fa" };
  else if (conf === "UNREVIEWED") b = { txt:"🔍 Unreviewed prediction", bg:"#1e293b", bd:"#334155", fg:"#94a3b8" };
  else if (conf === "LOW") b = { txt:"⚠️ Low confidence — verify independently", bg:"#3a1e00", bd:"#b45309", fg:"#fb923c" };
  else if (conf === "MEDIUM" || nCorr > 0) b = { txt:`⚠️ Reviewed — ${nCorr} correction${nCorr === 1 ? "" : "s"} applied`, bg:"#3d2a00", bd:"#a16207", fg:"#eab308" };
  else if (conf === "HIGH") b = { txt:"✅ Reviewed — high confidence", bg:"#052e16", bd:"#15803d", fg:"#4ade80" };
  else b = { txt:`🔍 ${conf || "Unreviewed"}`, bg:"#1e293b", bd:"#334155", fg:"#94a3b8" };
  const details = rev.reviewer_note || nCorr > 0;
  return (
    <div style={{ marginTop:6 }}>
      <span style={{ display:"inline-block", fontSize:11, fontWeight:600, background:b.bg, border:`1px solid ${b.bd}`, color:b.fg, borderRadius:6, padding:"3px 9px" }}>{b.txt}</span>
      {details && <span onClick={()=>setOpen(o=>!o)} style={{ marginLeft:8, fontSize:11, color:DIM, cursor:"pointer" }}>Show review details {open?"↑":"↓"}</span>}
      {open && details && (
        <div style={{ marginTop:6, background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:"8px 11px", fontSize:11, color:"#c8c8c8", lineHeight:1.5 }}>
          {rev.reviewer_note && <div style={{ marginBottom: nCorr ? 6 : 0 }}><b style={{ color:DIM }}>Reviewer:</b> {rev.reviewer_note}</div>}
          {(rev.errors_found || []).map((e,i)=>(
            <div key={i} style={{ color:"#ff8c42", marginBottom:3 }}>• <b>{e.type}</b>{e.player_affected ? ` (${e.player_affected})` : ""} — {e.description}{e.correction ? ` → ${e.correction}` : ""}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function FullSquad({ players }) {
  const [open, setOpen] = useState(false);
  if (!players || !players.length) return null;
  return (
    <div style={{ marginTop:10 }}>
      <span onClick={()=>setOpen(o=>!o)} style={{ fontSize:11, color:DIM, cursor:"pointer" }}>{open ? "− Hide full squad" : `+ Show full squad (${players.length} players)`}</span>
      {open && <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:6 }}>
        {players.map((p,i)=><span key={i} style={{ fontSize:11, background:BG, border:`1px solid ${BORDER}`, borderRadius:14, padding:"3px 9px", color:"#cbd5e1" }}>{p.name} <span style={{ color:DIM }}>{p.slot || p.position}</span></span>)}
      </div>}
    </div>
  );
}

function LineupsTab({ lineups, pool, goToPlayer, mobile, narrow, sel, setSel, cmp, setCmp }) {
  const [compareMode, setCompareMode] = useState(false);
  if (!lineups) return <div style={{ color:DIM }}>Loading lineups… (run <code>npm run fetch-lineups</code> to populate)</div>;
  const teamsData = lineups.teams || {};
  const matchPool = (nm, team) => {
    const toks = new Set(luNorm(nm).split(" ").filter(t=>t.length>1));
    return pool.filter(p=>p.team===team).map(p=>({p, s:luNorm(p.name).split(" ").filter(t=>toks.has(t)).length}))
      .filter(x=>x.s>0).sort((a,b)=>b.s-a.s)[0]?.p;
  };

  const renderLineup = (team) => {
    const L = teamsData[team];
    if (!L) return <div style={{ color:DIM, padding:12 }}>No lineup fetched for {team}. Run <code>npm run fetch-lineups</code>.</div>;
    const picks = (L.players||[]).map(pl=>({pl, m:matchPool(pl.name, team)})).filter(x=>x.m)
      .map(x=>({...x.pl, m:x.m})).sort((a,b)=>(b.m.pts_balanced||0)-(a.m.pts_balanced||0));
    return (
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"14px 16px", marginTop:8 }}>
        <div style={{ display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
          <div style={{ fontSize:16, fontWeight:800, color:"#fff" }}>{L.flag} {L.team} <span style={{ fontSize:12, color:DIM, fontWeight:400 }}>{L.formation} · {L.manager}</span></div>
        </div>
        <LineupReview L={L} />
        <div style={{ fontSize:10, color: L.news_items_used>0?"#60a5fa":DIM, marginTop:4 }}>
          {L.news_items_used>0 ? `📰 ${L.news_items_used} news item${L.news_items_used===1?"":"s"} used as context` : "ℹ No recent news context available"}
        </div>
        <div style={{ display:"grid", gridTemplateColumns: mobile ? "1fr" : "minmax(220px,1fr) minmax(220px,1.2fr)", gap:14, marginTop:10 }}>
          {/* pitch — hidden on very narrow screens (<480); positions computed per line with ≥18% x spacing */}
          {!narrow && <div style={{ position:"relative", aspectRatio:"3/4", maxWidth:"100%", background:"linear-gradient(#0a3d1f,#072d17)", border:"2px solid #1e6b3a", borderRadius:10 }}>
            <div style={{ position:"absolute", top:"50%", left:0, right:0, height:1, background:"#2e7d4f" }} />
            {(() => {
              const players = L.players || [];
              // group players into vertical rows (GK/DEF/MID/AM/FWD), order each row left→right by slot,
              // then spread evenly so nothing stacks: double pivots sit side-by-side, CAM sits above the
              // CM/CDM line, two strikers sit central, full-backs hug the flanks.
              const rows = {};
              players.forEach(pl => { const r = SLOT_ROW[pl.slot] || POS_ROW[pl.position] || "MID"; (rows[r] = rows[r] || []).push(pl); });
              const positioned = [];
              Object.entries(rows).forEach(([r, arr]) => {
                arr.sort((a, b) => (SLOT_ORDER[a.slot] ?? 50) - (SLOT_ORDER[b.slot] ?? 50));
                const n = arr.length, step = n > 1 ? Math.min(22, 76 / (n - 1)) : 0;
                arr.forEach((pl, i) => positioned.push({ pl, x: n === 1 ? (SLOT_ORDER[pl.slot] ?? 50) : 50 + (i - (n - 1) / 2) * step, y: PITCH_ROW_Y[r] }));
              });
              return positioned.map(({pl,x,y},i)=>(
                <div key={i} title={pl.doubt_reason||pl.status} style={{ position:"absolute", left:`${x}%`, top:`${y}%`, transform:"translate(-50%,-50%)", textAlign:"center", width:64 }}>
                  <div style={{ width:52, height:52, margin:"0 auto", borderRadius:"50%", background:luStatusColor(pl.status,pl.position), border:"2px solid #ffffff55", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:"#06121f", fontWeight:800 }}>
                    {pl.status==="DOUBT"?"⚠":pl.status==="OUT"?"✕":pl.slot}
                  </div>
                  <div style={{ fontSize:11, color:"#fff", fontWeight:700, marginTop:3, textShadow:"0 1px 3px #000", lineHeight:1.1, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }}>{pl.name}</div>
                </div>
              ));
            })()}
          </div>}
          {/* list — name prominent, slot/status/price below (ISSUE 3) */}
          <div>
            {(L.players||[]).map((pl,i)=>{ const m=matchPool(pl.name,team);
              return (<div key={i} style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:`1px solid ${BORDER}33`, alignItems:"flex-start" }}>
                <span style={{ width:18, flex:"0 0 auto", color:DIM, fontFamily:MONO, fontSize:12, paddingTop:1 }}>{i+1}</span>
                <div style={{ flex:"1 1 auto", minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:"#fff", whiteSpace: mobile?"nowrap":"normal", overflow:"hidden", textOverflow:"ellipsis" }}>{pl.name}
                    {m && !mobile && <span onClick={(e)=>{e.stopPropagation();goToPlayer(m.name);}} style={{ marginLeft:6, fontSize:9, color:"#f97316", cursor:"pointer", border:"1px solid #f9731655", borderRadius:3, padding:"0 4px", whiteSpace:"nowrap" }}>VIEW →</span>}
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", marginTop:2 }}>
                    <span style={{ fontSize:10, color:POS_COLOR[pl.position], fontFamily:MONO }}>{pl.slot}</span>
                    <Badge bg={pl.status==="CERTAIN"?"#16a34a22":pl.status==="DOUBT"?"#3d2a00":"#1e293b"} bd={pl.status==="CERTAIN"?"#22c55e88":pl.status==="DOUBT"?"#eab30888":"#334155"} fg={pl.status==="CERTAIN"?"#4ade80":pl.status==="DOUBT"?"#eab308":"#94a3b8"}>{pl.status}</Badge>
                    {m && <span style={{ fontSize:10, color:DIM }}>${m.price}m · {m.pts_balanced} xPts · {m.own}%</span>}
                    {m && mobile && <span onClick={(e)=>{e.stopPropagation();goToPlayer(m.name);}} style={{ fontSize:13, color:"#f97316", cursor:"pointer" }}>→</span>}
                  </div>
                  {pl.doubt_reason && <div style={{ fontSize:10, color:"#ff6b6b", marginTop:2 }}>{pl.doubt_reason}</div>}
                </div>
              </div>);
            })}
          </div>
        </div>
        {(L.key_absences||[]).length>0 && <div style={{ marginTop:10 }}>
          <div style={{ fontSize:9, letterSpacing:2, color:DIM, marginBottom:4 }}>KEY ABSENCES</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>{L.key_absences.map((a,i)=><span key={i} style={{ fontSize:11, color:"#ff8c42", background:"#3d0d0d", border:"1px solid #5a0000", borderRadius:6, padding:"3px 8px" }}>{a}</span>)}</div>
        </div>}
        {L.tactical_note && <div style={{ fontSize:12, color:"#c8c8c8", marginTop:10 }}><b style={{color:DIM}}>Tactical:</b> {L.tactical_note}</div>}
        {L.fantasy_note && <div style={{ fontSize:12, color:"#4ade80", marginTop:4 }}><b style={{color:DIM}}>Fantasy:</b> {L.fantasy_note}</div>}
        {(L.bench||[]).length>0 && <div style={{ marginTop:12 }}>
          <div style={{ fontSize:9, letterSpacing:2, color:DIM, marginBottom:6 }}>BENCH</div>
          <div style={{ display:"flex", gap:8, flexWrap: mobile?"nowrap":"wrap", overflowX: mobile?"auto":"visible", paddingBottom: mobile?6:0 }}>
            {L.bench.map((bp,i)=>(
              <div key={i} style={{ flex: mobile?"0 0 58%":"0 0 auto", background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:"7px 10px", minWidth:120 }}>
                <div style={{ color:"#fff", fontWeight:700, fontSize:12 }}>{bp.name}</div>
                <div style={{ fontSize:10, color:DIM, marginTop:1 }}><span style={{ color:POS_COLOR[bp.position], fontFamily:MONO }}>{bp.slot}</span> · {bp.status}</div>
              </div>
            ))}
          </div>
        </div>}
        {(() => {
          const seen = new Set([...(L.players||[]), ...(L.bench||[])].map(p=>luNorm(p.name)));
          const extras = (L.squad||[]).filter(p=>!seen.has(luNorm(p.name)));
          return <FullSquad players={extras} />;
        })()}
        {picks.length>0 && <div style={{ marginTop:12, borderTop:`1px solid ${BORDER}`, paddingTop:10 }}>
          <div style={{ fontSize:11, letterSpacing:1, color:"#f97316", fontWeight:700, marginBottom:8 }}>⭐ FANTASY PICKS FROM THIS XI</div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>{picks.map(x=>(
            <div key={x.m.id} onClick={()=>goToPlayer(x.m.name)} style={{ background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:"7px 10px", cursor:"pointer", minWidth:130 }}>
              <div style={{ color:"#fff", fontWeight:700, fontSize:12 }}>{x.m.name} <span style={{ fontSize:10, color:POS_COLOR[x.m.pos] }}>{x.m.pos}</span></div>
              <div style={{ fontSize:11, color:DIM }}>${x.m.price}m · {x.m.pts_balanced} xPts · {x.m.own}% {x.m.tier&&<b style={{color:TIER_COLOR[x.m.tier]}}>· {x.m.tier}</b>}</div>
            </div>))}</div>
        </div>}
        <div style={{ marginTop:12, fontSize:10, color:DIM, fontStyle:"italic" }}>🤖 AI predicted lineup based on squad knowledge · Verify against official team announcements</div>
      </div>
    );
  };

  const QUICK = [["Spain","🇪🇸","ESP"],["France","🇫🇷","FRA"],["Brazil","🇧🇷","BRA"],["Argentina","🇦🇷","ARG"],["England","🏴󠁧󠁢󠁥󠁮󠁧󠁿","ENG"],["Germany","🇩🇪","GER"],["Portugal","🇵🇹","POR"],["Morocco","🇲🇦","MAR"]];
  const selectStyle = { width:"100%", background:"#0d1829", border:`1px solid ${BORDER}`, color:"#e2e8f0", padding:"10px 36px 10px 14px", borderRadius:8, fontFamily:SANS, fontSize:14, minHeight:44, appearance:"none", WebkitAppearance:"none", MozAppearance:"none", cursor:"pointer", outline:"none" };
  const teamSelect = (value, onChange, placeholder) => (
    <div style={{ position:"relative", width: mobile?"100%":400, maxWidth:"100%" }}>
      <select value={value||""} onChange={e=>onChange(e.target.value||null)} style={selectStyle}>
        <option value="">{placeholder}</option>
        {Object.entries(LU_CONF).map(([conf,ts])=>(
          <optgroup key={conf} label={`── ${conf} (${ts.length}) ──`}>
            {ts.map(t=><option key={t} value={t}>{(teamsData[t]?.flag?teamsData[t].flag+" ":"")}{t}</option>)}
          </optgroup>
        ))}
      </select>
      <span style={{ position:"absolute", right:14, top:"50%", transform:"translateY(-50%)", color:"#f97316", pointerEvents:"none", fontSize:11 }}>▼</span>
    </div>
  );
  const statusFor = (t) => {
    if (!t) return null;
    const L = teamsData[t];
    if (!L) return { txt:"○ Not yet fetched", c:DIM };
    if (L.confidence==="SEED_DATA") return { txt:"🤖 AI predicted lineup — based on squad knowledge", c:"#60a5fa" };
    return { txt:"🤖 AI predicted · updated manually before each matchday", c:"#60a5fa" };
  };
  const status = statusFor(sel);

  return (
    <div>
      <div style={{ marginBottom:4, fontSize:16, fontWeight:800, color:"#fff" }}>📋 Predicted Lineups — WC2026</div>
      <div style={{ fontSize:11, color:DIM, marginBottom:2 }}>AI squad-knowledge based · Updated manually before each matchday</div>
      <div style={{ fontSize:11, color:"#475569", marginBottom:12 }}>Last updated: {lineups.generated_at}</div>

      {/* prominent AI disclaimer (always shown) */}
      <div style={{ background:"#1e1010", border:"1px solid #7f1d1d", color:"#fca5a5", borderRadius:10, padding:"12px 14px", marginBottom:14, fontSize:12, lineHeight:1.55 }}>
        <div style={{ fontWeight:800, marginBottom:4 }}>🤖 AI-Predicted Lineups — Powered by Claude AI</div>
        These lineups are generated by artificial intelligence based on squad knowledge and training data. They are NOT scraped from official sources and may contain errors, outdated information, or hallucinations.
        <div style={{ marginTop:6 }}>Always verify against official team announcements before making fantasy decisions. Take with a heap of salt.</div>
        <div style={{ marginTop:8, color:"#86efac", fontSize:11, lineHeight:1.6 }}>
          <div>✓ Confirmed FIFA WC 2026 squad lists (sourced from Wikipedia)</div>
          <div>✓ Latest injury/lineup news (from AI news feed)</div>
          <div>✓ AI tactical knowledge of each team's system</div>
        </div>
      </div>

      {/* selector row */}
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", marginBottom:8 }}>
        {teamSelect(sel, setSel, "🔍 Select a team…")}
        <button onClick={()=>setCompareMode(v=>!v)} style={{ minHeight:44, padding:"9px 14px", borderRadius:8, fontFamily:"inherit", fontSize:13, cursor:"pointer", border:`1px solid ${compareMode?"#f97316":BORDER}`, background:compareMode?"#f9731618":"transparent", color:compareMode?"#f97316":DIM }}>⇄ COMPARE</button>
        <button onClick={()=>alert("To refresh lineups, run:  npm run fetch-lineups\nor trigger the 'Update Predicted Lineups' GitHub Action.")} style={{ minHeight:44, padding:"9px 14px", borderRadius:8, fontFamily:"inherit", fontSize:13, cursor:"pointer", border:`1px solid ${BORDER}`, background:"transparent", color:DIM }}>↻ REFRESH</button>
        {status && <span style={{ fontSize:11, color:status.c }}>{status.txt}</span>}
      </div>

      {/* quick picks (desktop) */}
      {!mobile && (
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center", marginBottom:12 }}>
          <span style={{ fontSize:10, letterSpacing:1, color:DIM, marginRight:2 }}>QUICK PICK</span>
          {QUICK.map(([team,flag,code])=>(
            <button key={code} onClick={()=>setSel(team)} style={{ display:"inline-flex", alignItems:"center", gap:5, minHeight:36, padding:"5px 10px", borderRadius:20, border:`1px solid ${sel===team?"#f97316":BORDER}`, background:sel===team?"#f9731618":CARD, color:sel===team?"#f97316":"#cbd5e1", cursor:"pointer", fontFamily:"inherit", fontSize:12 }}>{flag} {code}</button>
          ))}
        </div>
      )}

      {/* compare second selector */}
      {compareMode && (
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:10, letterSpacing:1, color:DIM, marginBottom:4 }}>COMPARE WITH</div>
          {teamSelect(cmp, setCmp, "🔍 Compare with…")}
        </div>
      )}

      {/* lineups */}
      {compareMode ? (
        <div style={{ display:"grid", gridTemplateColumns: mobile?"1fr":"repeat(auto-fit,minmax(300px,1fr))", gap:12 }}>
          {sel ? renderLineup(sel) : <div style={{ color:DIM, padding:12 }}>Select a team above.</div>}
          {cmp ? renderLineup(cmp) : <div style={{ color:DIM, padding:12, alignSelf:"center" }}>Pick a second team to compare…</div>}
        </div>
      ) : (sel ? renderLineup(sel) : <div style={{ color:DIM, padding:"24px 12px", textAlign:"center" }}>Select a team to view its predicted XI.</div>)}
    </div>
  );
}

// ─── TAB: METHOD (static methodology explainer) ───────────────────────────────
const OR = "#f97316";
function MtCollapse({ title, sub, children, open: defOpen=false }) {
  const [open, setOpen] = useState(defOpen);
  return (
    <div style={{ border:`1px solid ${BORDER}`, borderRadius:8, marginBottom:8, background:CARD, overflow:"hidden" }}>
      <div onClick={()=>setOpen(o=>!o)} style={{ display:"flex", alignItems:"center", gap:8, padding:"11px 14px", cursor:"pointer" }}>
        <span style={{ color:OR, fontSize:11, width:10 }}>{open?"▾":"▸"}</span>
        <span style={{ fontWeight:700, color:"#fff", fontSize:13.5 }}>{title}</span>
        {sub && <span style={{ fontSize:11, color:DIM }}>· {sub}</span>}
      </div>
      {open && <div style={{ padding:"0 16px 14px 32px", fontSize:13, lineHeight:1.6, color:"#cbd5e1" }}>{children}</div>}
    </div>
  );
}
const MtFormula = ({ children }) => (
  <div style={{ background:"#0a1322", border:`1px solid ${BORDER}`, borderLeft:`3px solid ${OR}`, borderRadius:6, padding:"10px 14px", margin:"10px 0", fontFamily:MONO, fontSize:12.5, color:"#e2e8f0", whiteSpace:"pre-wrap", lineHeight:1.7 }}>{children}</div>
);
const MtH = ({ children }) => <div style={{ fontSize:18, fontWeight:800, color:"#fff", margin:"30px 0 4px" }}>{children}</div>;
const MtO = ({ children }) => <span style={{ color:OR, fontWeight:700, fontFamily:MONO }}>{children}</span>;
const MtNote = ({ children }) => <div style={{ background:"#1a1206", border:"1px solid #3d2a00", borderRadius:6, padding:"9px 12px", margin:"8px 0", fontSize:12, color:"#d4a574", fontStyle:"italic" }}>⚠ {children}</div>;
const MtTable = ({ head, rows }) => (
  <div style={{ overflowX:"auto", margin:"10px 0" }}>
    <table style={{ borderCollapse:"collapse", fontSize:12, width:"100%" }}>
      <thead><tr>{head.map((h,i)=><th key={i} style={{ textAlign:"left", padding:"6px 10px", color:DIM, borderBottom:`1px solid ${BORDER}`, fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r,i)=><tr key={i}>{r.map((c,j)=><td key={j} style={{ padding:"5px 10px", borderBottom:`1px solid ${BORDER}44`, color: j===r.length-1&&typeof c==="string"&&c.includes("✓")?"#4ade80":"#cbd5e1" }}>{c}</td>)}</tr>)}</tbody>
    </table>
  </div>
);

function MethodTab({ analytics }) {
  const flags = analytics?.player_analytics || [];
  const under = flags.filter(p => p.mispricing_flag === "UNDERRATED").slice(0, 20);
  const over  = flags.filter(p => p.mispricing_flag === "OVERRATED").slice(0, 20);
  const sig = p => { const v = p.mispricing_z ?? p.intl_z ?? p.intl_residual_z; return v==null ? "" : `${v>0?"+":""}${Number(v).toFixed(1)}σ`; };
  const Pill = ({ name, s, col }) => <span style={{ display:"inline-block", fontSize:11, background:CARD, border:`1px solid ${col}55`, color:"#e2e8f0", borderRadius:20, padding:"3px 10px", margin:3 }}>{name} {s && <b style={{ color:col }}>{s}</b>}</span>;

  return (
    <div style={{ maxWidth:800, margin:"0 auto", fontFamily:SANS }}>
      {/* SECTION 0 — TL;DR */}
      <div style={{ background:CARD, borderLeft:`4px solid ${OR}`, borderRadius:8, padding:"16px 18px", marginBottom:14 }}>
        <div style={{ fontSize:10, letterSpacing:3, color:OR, marginBottom:8, fontFamily:MONO }}>TL;DR</div>
        <div style={{ fontSize:14.5, lineHeight:1.65, color:"#e2e8f0" }}>
          WC26 SCOUT builds predicted fantasy points from the ground up — combining club-level performance stats, international role adjustments, betting market signals, and a causal model of tournament overperformance. <b style={{ color:"#fff" }}>Every number has a source. Every pick has a reason.</b>
          <div style={{ marginTop:10, fontSize:12.5, color:"#94a3b8" }}>Current scope: xPts is the <b style={{color:"#fff"}}>group stage (MD1–3)</b>, so everyone's compared over the same three games; <b style={{color:"#fff"}}>start probability is grounded in the predicted XIs</b>; tiers and the four optimal squads are recomputed on those numbers; and the new <b style={{color:"#fff"}}>Planner</b> (build your own XI) and <b style={{color:"#fff"}}>Odds</b> (scorer/assist/CS/win probabilities) tabs run entirely client-side.</div>
        </div>
        <div style={{ display:"flex", gap:8, marginTop:14, flexWrap:"wrap" }}>
          {["group-stage xPts","lineup-grounded minutes","client-side tiers & squads"].map(t=>(
            <span key={t} style={{ background:"#0a1322", border:`1px solid ${BORDER}`, borderRadius:20, padding:"6px 14px", fontSize:12, color:"#fff", fontWeight:600 }}>{t}</span>
          ))}
        </div>
      </div>

      {/* SECTION 1 — Data Sources */}
      <MtH>What data powers this</MtH>
      <MtCollapse title="1.1 — Player Statistics" sub="FBref · worldfootballR">
        <div>Source: <b>FBref</b> via the <code>worldfootballR</code> R package. Variables pulled per 90 minutes:</div>
        <ul style={{ margin:"8px 0", paddingLeft:18 }}>
          <li><MtO>npxG/90</MtO> — non-penalty expected goals</li>
          <li><MtO>xAG/90</MtO> — expected assisted goals</li>
          <li><MtO>SoT/90</MtO> — shots on target · <MtO>KP/90</MtO> — key passes · <MtO>TklW/90</MtO> — tackles won</li>
          <li><MtO>Save%</MtO> and <MtO>SoTA/90</MtO> for goalkeepers · yellow/red card rates</li>
        </ul>
        <div>Coverage: Big 5 European leagues (EPL, La Liga, Bundesliga, Serie A, Ligue 1) + supplementary Understat. Season: <b>2025/26</b>.</div>
        <MtNote>FBref rate limits mean some pulls use cached data. Players from non-Big5 leagues (Saudi Pro League, Liga MX, MLS) use manually seeded estimates flagged with lower confidence.</MtNote>
      </MtCollapse>
      <MtCollapse title="1.2 — International Performance Data" sub="FBref national-team pages">
        <div>Source: FBref national team pages via <code>worldfootballR</code>. Coverage: last <b>24 months</b> of international matches. Used to calibrate club stats to international context.</div>
        <div style={{ marginTop:8 }}><b style={{color:"#fff"}}>Key insight:</b> a player's club xG/90 systematically over- or under-estimates their international output depending on role, team-quality differential, and playing style.</div>
      </MtCollapse>
      <MtCollapse title="1.3 — Betting Market Signals" sub="The Odds API">
        <div>We extract P(win)/P(draw)/P(loss) per fixture → clean-sheet probability; outright tournament odds → advancement probability; Golden Boot odds → forward-valuation cross-check.</div>
        <div style={{ marginTop:8 }}>Betting markets aggregate injury news, squad depth, tactical matchups. We treat implied probabilities as <b>priors, not gospel</b> — where our model diverges from the market, that divergence is the signal.</div>
        <div style={{ marginTop:8 }}><b style={{color:"#fff"}}>Vig removal:</b> we use Pinnacle (lowest-margin book) as the no-vig reference and normalise probabilities to sum to 1 across outcomes.</div>
      </MtCollapse>
      <MtCollapse title="1.4 — Tournament Structure" sub="OpenFootball">
        <div>Source: <b>OpenFootball</b> (free GitHub JSON) — fixtures, groups, round schedules for all 48 teams. Used to compute expected matches per team given advancement probability.</div>
      </MtCollapse>

      {/* SECTION 2 — Points model */}
      <MtH>How xPts is calculated</MtH>
      <div style={{ fontSize:13, color:"#cbd5e1", lineHeight:1.6, marginBottom:6 }}>xPts is not a single number — it's a <b>distribution</b>. We report three versions: <MtO>Median</MtO> (safe floor), <MtO>Mean</MtO> (balanced), and <MtO>P90</MtO> (ceiling). The risk slider moves between them.</div>
      <MtCollapse title="2.1 — Scoring Rules Implementation" sub="official FIFA fantasy scoring">
        <MtTable head={["Position","Action","Pts"]} rows={[
          ["GK","Clean sheet (60+ mins)","+5"],["GK","Goal scored","+9"],["GK","Penalty save","+3"],["GK","Every 3 saves","+1"],["GK","Each goal conceded after 1st","−1"],
          ["DEF","Clean sheet","+5"],["DEF","Goal scored","+7"],["DEF","Each goal conceded after 1st","−1"],
          ["MID","Goal scored","+6"],["MID","Every 2 chances created","+1"],["MID","Every 3 tackles","+1"],["MID","Clean sheet","+1"],
          ["FWD","Goal scored","+5"],["FWD","Every 2 shots on target","+1"],
          ["ALL","Appearance <60 mins","+1"],["ALL","Appearance 60+ mins","+2"],["ALL","Assist","+3"],["ALL","Yellow card","−1"],["ALL","Red card","−2"],["ALL","Scouting Bonus (>4pts, <5% owned)","+2"],
        ]} />
      </MtCollapse>
      <MtCollapse title="2.2 — Expected Minutes" sub="grounded in the predicted lineups">
        <div>Every prediction is weighted by expected minutes:</div>
        <MtFormula>{`E[mins]            = startProb × minsIfStarted
E[appearance_pts]  = startProb × 2   (60+ min players)`}</MtFormula>
        <div><MtO>startProb</MtO> is <b style={{color:"#fff"}}>grounded in the AI-predicted starting XIs</b>: a predicted starter ≈ <MtO>0.90</MtO>, a named substitute ≈ <MtO>0.32</MtO>, anyone outside the predicted 15 ≈ <MtO>0.12</MtO>. This stops backup keepers and rotation players from inheriting a starter's points — fix a team's predicted XI and every player's xPts follows. (Players are matched to the lineup by <b>surname</b> to avoid first-name collisions.)</div>
      </MtCollapse>
      <MtCollapse title="2.3 — Per-Matchday Fixture Difficulty" sub="MD1/MD2/MD3 separately">
        <div>Difficulty is computed for each of the three group-stage matchdays, not a single FDR:</div>
        <MtFormula>{`csP_md   = oddsWin × 0.72 + oddsDraw × 0.28
goalP_md = oddsWin × 1.60 + oddsDraw × 0.50`}</MtFormula>
        <div>Clean-sheet probability scales with win probability (winners keep clean sheets). The 0.72 coefficient is calibrated against WC 2018 & 2022 data.</div>
        <div style={{ background:"#0a1322", border:`1px solid ${BORDER}`, borderRadius:6, padding:"10px 12px", marginTop:10, fontSize:12 }}>
          <b style={{ color:OR }}>Worked example — Spain vs Cape Verde (MD1):</b><br/>
          oddsWin = 0.91 → csP = 0.91×0.72 + 0.09×0.28 = <MtO>0.681</MtO><br/>
          Spain defenders project a 68% clean-sheet probability in MD1 — worth <MtO>+3.4</MtO> expected pts from the clean sheet alone.
        </div>
      </MtCollapse>
      <MtCollapse title="2.4 — Role Shift Adjustment" sub="club role ≠ international role">
        <div>Many players are priced on their club role but deployed differently for their country. We identify the gap and adjust:</div>
        <MtTable head={["Role Shift","xG ×","xA ×","Rationale"]} rows={[
          ["DEF_to_ATT","1.40","1.60","Attacking FB deployed as winger"],
          ["MID_to_ATT","1.25","1.20","Deep mid given advanced freedom"],
          ["WING_to_STRIKER","1.30","0.80","Winger used as false 9"],
          ["MID_to_DEF","0.75","0.80","Creative mid in defensive role"],
          ["ATT_to_DEF","0.60","0.70","Forward deployed deeper"],
          ["SAME","1.00","1.00","Club role consistent"],
        ]} />
        <div><b style={{color:"#fff"}}>Example:</b> Kimmich plays DM/CM for Bayern but operates as an attacking RB for Germany. His club xA/90 understates his creative output — we apply <MtO>×1.60</MtO> to his xA.</div>
      </MtCollapse>
      <MtCollapse title="2.5 — Set Piece Bonuses" sub="undervalued dead-ball EV">
        <ul style={{ margin:0, paddingLeft:18 }}>
          <li>FK taker: <MtO>+0.4</MtO> pts/match (FK goal EV + bonus pt prob)</li>
          <li>Corner taker: <MtO>+0.3</MtO> pts/match (indirect goal threat)</li>
          <li>Penalty taker: <MtO>+0.5</MtO> pts/match (pen win EV + conversion)</li>
        </ul>
      </MtCollapse>
      <MtCollapse title="2.6 — Tournament Scale" sub="group stage only (MD1–3)">
        <MtFormula>{`E[matches] = 3   (the three group-stage games — same for everyone)`}</MtFormula>
        <div>xPts is currently scoped to the <b style={{color:"#fff"}}>group stage</b> so every player is compared over the same three games. We deliberately do <b>not</b> pre-credit a deep knockout run — the old <code>3 + advP/100 × 5</code> rule rewarded strong teams for matches they hadn't played yet and inflated their squads. Knockout games are added matchday-by-matchday as teams actually advance.</div>
      </MtCollapse>
      <MtCollapse title="2.7 — Scorer / Assist Probabilities" sub="the Odds tab">
        <div>The Odds tab turns the same xG/xA into model-implied <b style={{color:"#fff"}}>anytime-scorer</b> and <b style={{color:"#fff"}}>anytime-assist</b> probabilities via a Poisson transform:</div>
        <MtFormula>{`P(≥1 goal)   = 1 − e^(−λ),  λ = xG × minutes × fixture goal-context
P(≥1 assist) = 1 − e^(−μ),  μ = xA × minutes × fixture goal-context`}</MtFormula>
        <div>Shown alongside win/draw/loss and clean-sheet % per fixture. These are <b>model estimates, not bookmaker lines</b> — World Cup player-prop odds aren't sold on the cheap data feeds, so we derive them from the model (the more useful comparison anyway).</div>
      </MtCollapse>

      {/* SECTION 3 — Regression */}
      <MtH>Detecting mispricing with econometrics</MtH>
      <div style={{ fontSize:13, color:"#cbd5e1", lineHeight:1.6, marginBottom:6 }}>Prices are set pre-tournament on club reputation and league form. International football differs — we use regression to quantify the gap.</div>
      <MtCollapse title="3.1 — The Model" sub="8+ caps in last 24 months">
        <MtFormula>{`intl_npxG_p90 = β₀ + β₁·club_npxG_p90 + β₂·league_tier
              + β₃·role_shift + β₄·natl_team_elo + ε`}</MtFormula>
        <div>The residual <MtO>ε</MtO> is the mispricing signal: positive → outperforms club stats internationally; negative → underperforms.</div>
      </MtCollapse>
      <MtCollapse title="3.2 — Interpretation" sub="z-score normalised">
        <div>Residuals are normalised to a z-score: <MtO>+1.0σ</MtO> = one SD above expected international output.</div>
        <ul style={{ margin:"8px 0", paddingLeft:18 }}>
          <li>Above <MtO>+1.0σ</MtO> AND under 20% owned → <b style={{color:"#4ade80"}}>UNDERRATED</b></li>
          <li>Below <MtO>−1.0σ</MtO> → <b style={{color:"#ff6b6b"}}>OVERRATED</b></li>
        </ul>
        <MtNote>With limited international data (WC is every 4 years), the regression uses qualifiers and friendlies as proxies. Competitive internationals (WC qualifying, Nations League, continental championships) are weighted 3× friendlies.</MtNote>
      </MtCollapse>
      <MtCollapse title="3.3 — Current flags" sub={`${under.length} under · ${over.length} over`} open={true}>
        {under.length>0 ? <>
          <div style={{ fontSize:11, letterSpacing:1, color:"#4ade80", marginBottom:4 }}>UNDERRATED</div>
          <div style={{ marginBottom:10 }}>{under.map(p=><Pill key={p.id||p.name} name={p.name} s={sig(p)} col="#4ade80" />)}</div>
        </> : <div style={{ color:DIM }}>No underrated flags in loaded analytics.</div>}
        {over.length>0 && <>
          <div style={{ fontSize:11, letterSpacing:1, color:"#ff6b6b", marginBottom:4 }}>OVERRATED</div>
          <div>{over.map(p=><Pill key={p.id||p.name} name={p.name} s={sig(p)} col="#ff6b6b" />)}</div>
        </>}
        {!analytics && <div style={{ color:DIM }}>Run the R pipeline to populate analytics.json for live flags.</div>}
      </MtCollapse>

      {/* SECTION 4 — Causal */}
      <MtH>Why some teams beat expectations</MtH>
      <MtCollapse title="4.1 — The Two-Model Approach" sub="quality vs overperformance">
        <div>We separate two questions most tools conflate: (1) how good is this team absolutely? (2) will it beat expectations? These have different predictors. France is strong but rarely massively overperforms — the market already prices them. <b>Overperformance is a property of underestimated teams.</b></div>
      </MtCollapse>
      <MtCollapse title="4.2 — Key Predictors" sub="WC 2006–2022 + continental panel">
        <ol style={{ margin:0, paddingLeft:18, lineHeight:1.55 }}>
          <li><b style={{color:"#4ade80"}}>Squad cohesion (shared caps) ↑</b> — Iceland 2016 averaged 47 caps/player, highest in the field.</li>
          <li><b style={{color:"#4ade80"}}>Age profile (peak 26–29) ↑</b> — physical prime + experience; young squads overperform only with high cohesion.</li>
          <li><b style={{color:OR}}>Foreign-league share (inverted-U)</b> — 60–80% is optimal; too low = limited exposure, too high = no shared tactical language.</li>
          <li><b style={{color:"#4ade80"}}>Manager tenure ↑</b> — strongest in first 3 years, diminishing after.</li>
          <li><b style={{color:"#4ade80"}}>Counter-defensive vs possession opponents ↑</b> — Morocco 2022, Iceland 2016, Greece 2004.</li>
          <li><b style={{color:"#ff6b6b"}}>Narrative pressure ↓</b> — hosts / defending champions / heavily-hyped sides underperform; mechanism unclear.</li>
        </ol>
      </MtCollapse>
      <MtCollapse title="4.3 — Historical Validation" sub="leave-one-out">
        <MtTable head={["Team","Tournament","Pred OP","Actual OP","Verdict"]} rows={[
          ["Iceland","Euro 2016","+1.8 rd","+2 rd","✓ Correct"],
          ["Morocco","WC 2022","+1.5 rd","+2 rd","✓ Correct"],
          ["Greece","Euro 2004","+2.1 rd","+3 rd","✓ Correct"],
          ["Costa Rica","WC 2014","+1.2 rd","+2 rd","✓ Correct"],
          ["Germany","WC 2018","−1.4 rd","−2 rd","✓ Correct"],
        ]} />
        <MtNote>Better calibrated for UEFA and CONMEBOL where more historical data exists. AFCON and AFC predictions carry lower confidence due to smaller samples.</MtNote>
      </MtCollapse>

      {/* SECTION 5 — LP */}
      <MtH>Finding the mathematically optimal squad</MtH>
      <MtCollapse title="5.1 — The Problem">
        <div>Squad selection is a constrained optimisation: maximise predicted points subject to budget and structure constraints.</div>
      </MtCollapse>
      <MtCollapse title="5.2 — The Constraints">
        <ul style={{ margin:0, paddingLeft:18 }}>
          <li>Total price ≤ <MtO>$100m</MtO></li>
          <li>Exactly <MtO>2 GK, 5 DEF, 5 MID, 3 FWD</MtO></li>
          <li>Max <MtO>3 players per nation</MtO> (group stage)</li>
          <li>All selections binary (0/1)</li>
        </ul>
      </MtCollapse>
      <MtCollapse title="5.3 — Four Objective Functions" sub="same constraints, 4 objectives">
        <div style={{ marginBottom:6 }}><b style={{color:"#fff"}}>Safe (Minutes Certainty)</b> — nailed starters only (startProb ≥ 0.80), max Σ pts_safe.</div>
        <div style={{ marginBottom:6 }}><b style={{color:"#fff"}}>Balanced (Core + Edge)</b> — max Σ pts_balanced across the XI.</div>
        <div style={{ marginBottom:6 }}><b style={{color:"#fff"}}>Differential (Value Hunt)</b> — low-owned (&lt;25%) starters with real minutes & points, tilted toward scout-bonus (&lt;5% owned) picks.</div>
        <div style={{ marginBottom:6 }}><b style={{color:"#fff"}}>Psychopath (Giant-Killers)</b> — starters at underdog / giant-killer sides (Morocco, Japan, NZ), maximising <code>pts_p90 × giant-killer × 1/(own+1)</code>.</div>
        <MtNote>Recomputed client-side on the group-stage numbers via a budget-aware greedy (2 GK / 5 DEF / 5 MID / 3 FWD, ≤3 per nation, ≤$100m). Bench slots get the cheapest <b>dependable starters</b> (startProb ≥ 0.70, decent points) — never $3.5 passengers.</MtNote>
      </MtCollapse>
      <MtCollapse title="5.4 — Why four squads?">
        <div>Strategy depends on your mini-league position. Leading? Play <b>Safe</b> — protect the lead. 10 points behind? Go <b>Differential</b> — you need variance. Starting fresh? <b>Balanced</b> is optimal for overall rank.</div>
      </MtCollapse>

      {/* SECTION 6 — Tiers */}
      <MtH>How players are ranked for gambling play</MtH>
      <div style={{ fontSize:13, color:"#cbd5e1", lineHeight:1.6, marginBottom:6 }}>The tier list answers a different question than xPts: not "who scores most on average" but "who gives the best chance of <b>winning my mini-league</b>".</div>
      <MtFormula>{`tier_score = pts_p90 × 0.45
           + (pts_p90 − pts_median) × 0.20
           + scouting_bonus_ev × 0.15
           + intl_premium_score × 0.10
           + captain_slot_bonus × 0.05
           + set_piece_involvement × 0.05
           − card_risk_penalty
           − start_uncertainty_penalty
           − early_exit_penalty`}</MtFormula>
      <div style={{ fontSize:13, color:"#cbd5e1", lineHeight:1.6 }}>The heaviest weight (<MtO>0.45</MtO>) goes to ceiling (pts_p90), not mean. The variance premium (<MtO>0.20</MtO>) explicitly rewards boom-or-bust players — in a mini-league a 2-or-20 player beats a steady 8.</div>
      <MtTable head={["Tier","Cutoff"]} rows={[["S","top 8%"],["A","next 17%"],["B","next 25%"],["C","next 25%"],["D","bottom 25%"]]} />
      <MtNote>Re-derived client-side on the group-stage xPts so tiers match the rest of the dashboard. Hard rules: startProb &lt; 0.70 → cannot be S/A; advP &lt; 40% → cannot be S; own &gt; 55% → downgraded one tier; intl-premium &gt; 1.5σ AND own &lt; 10% → upgraded one tier.</MtNote>

      {/* SECTION 7 — Limitations */}
      <MtH>What this model doesn't do well</MtH>
      {[
        ["1. In-tournament form is not yet incorporated","Pre-tournament stats are the only inputs. Once MD1 results are in, the model needs updating with actual tournament data. Live xG tracking is planned."],
        ["2. Friendly data is low signal","We use competitive internationals only (weighted 3×). Friendlies are included but heavily discounted."],
        ["3. Non-Big5 league coverage is weaker","Saudi Pro League, MLS, Liga MX, and African/Asian domestic leagues use manually estimated stats with lower confidence — flagged in player cards."],
        ["4. Injury news is not real-time","The newsfeed provides updates, but the xPts model does not auto-adjust for confirmed injuries. If a key player is injured, manually check startProb."],
        ["5. The regression has limited international data","WC qualification gives ~10 matches per team every 4 years. Individual residuals (mispricing flags) are directional signals, not precise estimates."],
        ["6. Tactical changes mid-tournament","Managers adapt; a 4-3-3 may become 5-3-2 after a bad result. Role-shift flags are set pre-tournament and won't update mid-competition."],
      ].map(([t,b])=> <MtCollapse key={t} title={t}>{b}</MtCollapse>)}

      {/* SECTION 8 — Workflow */}
      <MtH>Recommended workflow</MtH>
      <ol style={{ paddingLeft:18, lineHeight:1.6, fontSize:13, color:"#cbd5e1" }}>
        <li style={{ marginBottom:8 }}><b style={{color:"#fff"}}>Set your risk profile</b> — In Players, set risk by mini-league position. Behind → Differential. Ahead → Safe.</li>
        <li style={{ marginBottom:8 }}><b style={{color:"#fff"}}>Check the Causal tab first</b> — open the Causal tab → Teams to Attack section. Find the weakest defences facing your matchday; these are captain targets.</li>
        <li style={{ marginBottom:8 }}><b style={{color:"#fff"}}>Use smart filters</b> — "MD1 Captain Picks" surfaces late-kickoff players with easy fixtures.</li>
        <li style={{ marginBottom:8 }}><b style={{color:"#fff"}}>Check for mispricing</b> — "Role Arbitrage" finds players deployed more offensively internationally than their club price implies.</li>
        <li style={{ marginBottom:8 }}><b style={{color:"#fff"}}>Validate with Lineups</b> — predicted lineups are generated by Claude using its knowledge of WC 2026 squads and typical national-team formations. They are updated manually before each matchday and represent the model's best assessment of likely starting XIs based on known squad compositions, injuries, and manager preferences. Confirm key picks are in the predicted XI; if DOUBT, consider alternatives.</li>
        <li style={{ marginBottom:8 }}><b style={{color:"#fff"}}>Check the News tab</b> — Check the 📡 News tab for the latest injury and lineup news before each matchday deadline. One late withdrawal can change your captain decision.</li>
        <li><b style={{color:"#fff"}}>Use Optimal Squads for budget</b> — Start from the Balanced squad, then swap in your differentials.</li>
      </ol>

      {/* SECTION 9 — About */}
      <MtH>tucheliban's WC26 SCOUT</MtH>
      <div style={{ fontSize:13, color:"#cbd5e1", lineHeight:1.65 }}>
        Built for the 2026 FIFA World Cup. Combines fantasy football analytics with econometric methods usually reserved for academic research — regression analysis, causal inference, linear programming, and Monte Carlo simulation.
        <div style={{ marginTop:8, color:"#fff", fontWeight:600 }}>The goal: make every pick defensible with data.</div>
      </div>
      <div style={{ fontSize:11, color:DIM, marginTop:14, lineHeight:1.7 }}>
        Data: FBref · Understat · FIFA Fantasy API · The Odds API · OpenFootball<br/>
        Model: R (worldfootballR, lpSolve, lme4, factoextra)<br/>
        Frontend: React + Vite · Deployed on Cloudflare Pages
      </div>
      <div style={{ textAlign:"right", fontSize:11, fontStyle:"italic", color:"#475569", marginTop:18 }}>it's coming home 🏴󠁧󠁢󠁥󠁮󠁧󠁿</div>
    </div>
  );
}

// ─── MOBILE + CHROME (hook, deadline banner, url badge, news tab, global css) ──
function useIsMobile() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return { mobile: w <= 768, narrow: w < 480, width: w };
}

function GlobalCSS() {
  return <style>{`
    *, *::before, *::after { box-sizing: border-box; }
    html, body, #root { width: 100%; max-width: 100vw; margin: 0; overflow-x: hidden; }
    @keyframes dlPulse { 0%,100%{opacity:1} 50%{opacity:.5} }
    @keyframes dlFlash { 0%,100%{background:#991b1b} 50%{background:#5c0f0f} }
    @keyframes mkiShake { 0%{transform:translate(0,0) rotate(-4deg)} 20%{transform:translate(-1.5px,1px) rotate(3deg)} 40%{transform:translate(1.5px,-1px) rotate(-3deg)} 60%{transform:translate(-1px,-1px) rotate(4deg)} 80%{transform:translate(1px,1.5px) rotate(-2deg)} 100%{transform:translate(0,0) rotate(-4deg)} }
    .mki-shake { animation: mkiShake .42s infinite; transform-origin:center; }
    .tabbar { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: thin; scroll-behavior: smooth; }
    .tabbar::-webkit-scrollbar { height: 3px; }
    .tabbar::-webkit-scrollbar-thumb { background:#334155; border-radius:2px; }
    .urlbadge:hover { border-color:#f97316 !important; color:#fff !important; }
    .filter-btn, .sort-tab, .risk-btn, .smart-filter, .tier-tab, .news-filter { min-height: 44px; }
    @media (max-width:768px){
      .tabwrap { position: relative; }
      .tabwrap::after { content:""; position:absolute; top:0; right:0; bottom:0; width:30px; pointer-events:none; background:linear-gradient(to right, transparent, #060d1a); }
    }
  `}</style>;
}

const MATCHDAY_DEADLINES = [
  { label: "MD1 Deadline", datetime: "2026-06-12T12:00:00-05:00" },
  { label: "MD2 Deadline", datetime: "2026-06-20T09:00:00-05:00" },
  { label: "MD3 Deadline", datetime: "2026-06-26T14:00:00-04:00" },
  { label: "R32 Deadline", datetime: "2026-06-29T12:00:00-04:00" },
  { label: "R16 Deadline", datetime: "2026-07-05T12:00:00-04:00" },
  { label: "QF Deadline",  datetime: "2026-07-10T12:00:00-04:00" },
  { label: "SF Deadline",  datetime: "2026-07-14T12:00:00-04:00" },
  { label: "Final",        datetime: "2026-07-19T11:00:00-04:00" },
];
const MD_FULL = { "MD1 Deadline":"Matchday 1", "MD2 Deadline":"Matchday 2", "MD3 Deadline":"Matchday 3",
  "R32 Deadline":"Round of 32", "R16 Deadline":"Round of 16", "QF Deadline":"Quarter-finals",
  "SF Deadline":"Semi-finals", "Final":"Final" };
const pad2 = n => String(n).padStart(2, "0");

function DeadlineBanner({ mobile }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const next = MATCHDAY_DEADLINES.find(d => new Date(d.datetime).getTime() > now);
  const base = { display:"flex", alignItems:"center", justifyContent:"center", color:"#fff",
    fontFamily:SANS, borderBottom:`1px solid ${BORDER}` };
  if (!next) return <div style={{ ...base, height: mobile?28:36, fontSize: mobile?12:14, fontWeight:700, background:"linear-gradient(90deg,#166534,#14532d)" }}>Tournament Complete 🏆</div>;
  const ms = new Date(next.datetime).getTime() - now;
  const d = Math.floor(ms/86400000), h = Math.floor(ms/3600000)%24, m = Math.floor(ms/60000)%60, s = Math.floor(ms/1000)%60;
  const under24 = ms < 86400000, under1 = ms < 3600000;
  const short = next.label.split(" ")[0], full = MD_FULL[next.label] || next.label;
  const center = short === full ? full : `${short} · ${full}`;
  const cd = `${d}d ${pad2(h)}h ${pad2(m)}m ${pad2(s)}s`;
  const bg = under1 ? "#991b1b" : under24 ? "#991b1b" : "linear-gradient(90deg,#92400e,#78350f)";
  const anim = under1 ? "dlFlash 1s steps(1) infinite" : undefined;
  const cdAnim = under24 ? "dlPulse 1.2s ease-in-out infinite" : undefined;

  if (mobile) {
    return (
      <div style={{ ...base, height:28, fontSize:12, background:bg, animation:anim, gap:8, padding:"0 12px" }}>
        {under24 && <img src="/img/makkauijau.png" alt="" className="mki-shake" style={{ height:22 }} />}
        <span style={{ fontFamily:MONO, fontWeight:700, animation:cdAnim }}>{short} · {d}d {pad2(h)}h {pad2(m)}m</span>
        {under1 && <span style={{ fontSize:10, fontWeight:800 }}>⚠ LOCK</span>}
      </div>
    );
  }
  return (
    <div style={{ ...base, height:36, background:bg, animation:anim, padding:"0 20px" }}>
      <div style={{ maxWidth:1240, width:"100%", margin:"0 auto", display:"flex", alignItems:"center", gap:14 }}>
        {under24 && <img src="/img/makkauijau.png" alt="" title="Mak kau ijau — deadline dah dekat!" className="mki-shake" style={{ height:30, filter:"drop-shadow(0 1px 2px #000a)" }} />}
        <span style={{ fontSize:9, letterSpacing:2, color:"#fde68a", fontFamily:MONO }}>NEXT DEADLINE</span>
        <span style={{ fontSize:13, fontWeight:700 }}>{center}</span>
        {under1 && <span style={{ fontSize:11, fontWeight:800, color:"#fff" }}>⚠ LOCK IMMINENT</span>}
        <span style={{ marginLeft:"auto", fontFamily:MONO, fontSize:17, fontWeight:800, letterSpacing:0.5, animation:cdAnim }}>{cd}</span>
      </div>
    </div>
  );
}

function UrlBadge() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const t = "https://makscouthijau.uk";
    (navigator.clipboard?.writeText(t) || Promise.reject())
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <span className="urlbadge" title="Share this dashboard" onClick={copy}
      style={{ background:"#0f172a", border:"1px solid #334155", color:"#94a3b8", borderRadius:20,
        padding:"4px 10px", fontSize:11, cursor:"pointer", whiteSpace:"nowrap", transition:"all .15s",
        fontFamily:MONO }}>
      {copied ? "✓ copied!" : "🌐 makscouthijau.uk"}
    </span>
  );
}

// ─── TAB: NEWS (reads pre-fetched public/data/news.json; no client API calls) ──
function NewsTab({ news, mobile }) {
  const [filter, setFilter] = useState("ALL");
  const [q, setQ] = useState("");
  const items = news?.items || [];
  const gen = news?.generated_at;
  const ageH = gen ? (Date.now() - new Date(gen).getTime()) / 3600000 : null;
  const stale = ageH == null ? { t:"● —", c:DIM } : ageH < 3 ? { t:"● LIVE", c:"#4ade80" } : ageH < 6 ? { t:"● RECENT", c:"#eab308" } : { t:"● STALE", c:"#ef4444" };
  const PRI = { HIGH:"#ef4444", MEDIUM:"#f97316", LOW:"#475569" };
  const Header = () => (
    <div style={{ marginBottom:12 }}>
      <div style={{ display:"flex", alignItems:"baseline", gap:10, flexWrap:"wrap" }}>
        <span style={{ fontSize:17, fontWeight:800, color:"#fff" }}>📡 LIVE INTEL</span>
        <span style={{ fontSize:12, fontWeight:700, color:stale.c }}>{stale.t}</span>
        {gen && <span style={{ fontSize:11, color:DIM }}>updated {new Date(gen).toLocaleString("en-GB",{ timeZone:"Asia/Kuala_Lumpur", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })} MYT</span>}
      </div>
      <div style={{ fontSize:11, color:"#475569", marginTop:2 }}>Refreshes every 3 hours</div>
    </div>
  );
  if (!items.length) return (
    <div><Header />
      <div style={{ background:CARD, border:`1px dashed ${BORDER}`, borderRadius:10, padding:"40px 20px", textAlign:"center", color:DIM, fontSize:14 }}>
        📡 News data loading — check back shortly
      </div>
    </div>
  );
  const FILTERS = [["ALL","ALL"],["HIGH","🔴 HIGH"],["INJURY","INJURY"],["LINEUP","LINEUP"],["TRAINING","TRAINING"],["SUSPENSION","SUSPENSION"]];
  const s = (q||"").toLowerCase();
  const shown = items.filter(it => {
    if (filter === "HIGH" && it.priority !== "HIGH") return false;
    if (filter !== "ALL" && filter !== "HIGH" && it.category !== filter) return false;
    return !s || (it.player_name||"").toLowerCase().includes(s) || (it.team||"").toLowerCase().includes(s) || (it.headline||"").toLowerCase().includes(s);
  });
  return (
    <div><Header />
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 }}>
        {FILTERS.map(([k,l]) => (
          <button key={k} className="news-filter" onClick={()=>setFilter(k)} style={{ padding:"8px 11px", borderRadius:6, fontFamily:"inherit", fontSize:12, cursor:"pointer",
            border:`1px solid ${filter===k?"#f97316":BORDER}`, background:filter===k?"#f9731618":"transparent", color:filter===k?"#f97316":DIM }}>{l}</button>
        ))}
      </div>
      <input placeholder="Search player or team…" value={q} onChange={e=>setQ(e.target.value)} style={{ width:"100%", background:CARD, border:`1px solid ${BORDER}`, borderRadius:6, padding:"9px 12px", color:TEXT, fontFamily:"inherit", fontSize:13, marginBottom:12 }} />
      {shown.map((it,i) => (
        <div key={it.id||i} style={{ background:CARD, border:`1px solid ${BORDER}`, borderLeft:`4px solid ${PRI[it.priority]||DIM}`, borderRadius:8, padding:"11px 14px", marginBottom:8 }}>
          <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", marginBottom:4 }}>
            <Badge bg="#0a1322" bd={BORDER} fg="#94a3b8">{it.category||"NEWS"}</Badge>
            {it.priority==="HIGH" && <Badge bg="#3d0d0d" bd="#ef444488" fg="#ff6b6b">HIGH</Badge>}
            {it.player_name && <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{it.player_name}</span>}
            {it.team && <span style={{ fontSize:11, color:DIM }}>{it.team}</span>}
            {it.timestamp && <span style={{ marginLeft:"auto", fontSize:10, color:"#475569" }}>{new Date(it.timestamp).toLocaleString("en-GB",{ day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}</span>}
          </div>
          <div style={{ fontSize:14, fontWeight:600, color:"#e2e8f0", marginBottom:3 }}>{it.headline}</div>
          {it.summary && <div style={{ fontSize:12.5, color:"#94a3b8", lineHeight:1.5 }}>{it.summary}</div>}
          {it.fantasy_impact && <div style={{ fontSize:12, color:"#4ade80", marginTop:5 }}>⚽ {it.fantasy_impact}</div>}
          {it.source_hint && <div style={{ fontSize:10, color:"#475569", marginTop:4 }}>{it.source_hint}</div>}
        </div>
      ))}
      {!shown.length && <div style={{ color:DIM, padding:12 }}>No items match this filter.</div>}
    </div>
  );
}

// ─── TAB: PLANNER (build 15-man squad, $100m cap, per-MD xP, transfers, PNG) ──────
const PL_LIMITS = { GK: 2, DEF: 5, MID: 5, FWD: 3 };   // 15-man squad shape
const PL_XI_MAX = { GK: 1, DEF: 5, MID: 5, FWD: 3 };   // max of each position in the starting XI
const PL_BUDGET = 100;
const PL_FORMS = [[3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 3, 2], [5, 4, 1]];
const PL_KEY = "wc26_planner_v1";
const PL_MD_DATES = ["Jun 11-15", "Jun 16-21", "Jun 22-27"];

function PlannerTab({ pool, mobile, watch, toggleWatch }) {
  const byId = useMemo(() => { const m = {}; (pool || []).forEach(p => { m[p.id] = p; }); return m; }, [pool]);
  const load = () => { try { return JSON.parse(localStorage.getItem(PL_KEY)) || {}; } catch { return {}; } };
  const init = load();
  const [squad, setSquad] = useState(init.squad || []);
  const [starters, setStarters] = useState(init.starters || []);
  const [captain, setCaptain] = useState(init.captain ?? null);
  const [viceCaptain, setViceCaptain] = useState(init.viceCaptain ?? null);
  const [transfers, setTransfers] = useState(init.transfers || 0);
  const [pendingOut, setPendingOut] = useState(0);   // removals from a full squad awaiting a replacement
  const [md, setMd] = useState(NEXT_MD);
  const [pickPos, setPickPos] = useState(null);
  const [pickQ, setPickQ] = useState("");
  const [pickMax, setPickMax] = useState("");   // optional max-price cap in the picker
  const [pngBusy, setPngBusy] = useState(false);
  const [menuId, setMenuId] = useState(null);        // pitch player whose action menu is open
  const [subbingId, setSubbingId] = useState(null);  // starter being subbed out (awaiting bench pick)

  useEffect(() => {
    try { localStorage.setItem(PL_KEY, JSON.stringify({ squad, starters, captain, viceCaptain, transfers })); } catch { /* private mode */ }
  }, [squad, starters, captain, viceCaptain, transfers]);

  const sp = squad.map(id => byId[id]).filter(Boolean);
  const spent = +sp.reduce((s, p) => s + p.price, 0).toFixed(1);
  const remaining = +(PL_BUDGET - spent).toFixed(1);
  const countPos = (pos) => sp.filter(p => p.pos === pos).length;
  const benchPlayers = sp.filter(p => !starters.includes(p.id));

  // per-MD projected points — same model number the Players table shows (no flat scout bonus;
  // scout upside is conditional, flagged by the 🔍 badge and already in the group-stage EV)
  const ptsOf = (p, mi) => +mdScore(p, mi).pts.toFixed(1);
  const oppOf = (p, mi) => mdScore(p, mi).opp;

  const addPlayer = (p) => {
    if (squad.includes(p.id)) return;
    if (countPos(p.pos) >= PL_LIMITS[p.pos]) return;
    if (squad.length >= 15) return;
    if (p.price > remaining + 1e-9) return;
    setSquad([...squad, p.id]);
    if (pendingOut > 0) { setPendingOut(pendingOut - 1); setTransfers(t => t + 1); }   // completing a swap on a full squad
  };
  const removePlayer = (id) => {
    if (squad.length >= 15 || pendingOut > 0) setPendingOut(pendingOut + 1);            // removing from a full squad starts a transfer
    setSquad(squad.filter(x => x !== id));
    setStarters(starters.filter(x => x !== id));
    if (captain === id) setCaptain(null);
    if (viceCaptain === id) setViceCaptain(null);
    if (subbingId === id) setSubbingId(null);
  };
  const toggleStarter = (id) => {
    if (starters.includes(id)) {
      setStarters(starters.filter(x => x !== id));
      if (captain === id) setCaptain(null);
      if (viceCaptain === id) setViceCaptain(null);
    } else {
      const p = byId[id]; if (!p || starters.length >= 11) return;
      const inPos = starters.map(i => byId[i]).filter(x => x && x.pos === p.pos).length;
      if (inPos >= PL_XI_MAX[p.pos]) return;   // blocks a 2nd GK, 6th DEF, etc.
      setStarters([...starters, id]);
    }
  };
  // a bench player is a valid replacement for a starter if the resulting XI is still a legal formation
  const validReplacement = (outId, inId) => {
    const next = starters.filter(x => x !== outId).concat(inId).map(i => byId[i]).filter(Boolean);
    const c = (pos) => next.filter(p => p.pos === pos).length;
    return next.length === 11 && c("GK") === 1 && c("DEF") >= 3 && c("DEF") <= 5 && c("MID") >= 2 && c("MID") <= 5 && c("FWD") >= 1 && c("FWD") <= 3;
  };
  const doSub = (outId, inId) => {
    if (!validReplacement(outId, inId)) return;
    setStarters(starters.map(x => x === outId ? inId : x));
    if (captain === outId) setCaptain(inId);
    if (viceCaptain === outId) setViceCaptain(inId);
    setSubbingId(null);
  };

  const startersPos = (pos) => starters.map(id => byId[id]).filter(p => p && p.pos === pos);
  const fCounts = { GK: startersPos("GK").length, DEF: startersPos("DEF").length, MID: startersPos("MID").length, FWD: startersPos("FWD").length };
  const formationValid = starters.length === 11 && fCounts.GK === 1 && fCounts.DEF >= 3 && fCounts.DEF <= 5 && fCounts.MID >= 2 && fCounts.MID <= 5 && fCounts.FWD >= 1 && fCounts.FWD <= 3;
  const formationStr = `${fCounts.DEF}-${fCounts.MID}-${fCounts.FWD}`;

  const autoXI = (mi) => {
    const byPos = (pos) => sp.filter(p => p.pos === pos).map(p => ({ id: p.id, s: ptsOf(p, mi) })).sort((a, b) => b.s - a.s);
    const G = byPos("GK"), D = byPos("DEF"), M = byPos("MID"), F = byPos("FWD");
    let best = null;
    for (const [d, m, f] of PL_FORMS) {
      if (!G[0] || D.length < d || M.length < m || F.length < f) continue;
      const arr = [G[0], ...D.slice(0, d), ...M.slice(0, m), ...F.slice(0, f)];
      const tot = arr.reduce((s, x) => s + x.s, 0);
      if (!best || tot > best.tot) best = { ids: arr.map(x => x.id), tot };
    }
    if (best) { setStarters(best.ids); const capId = best.ids.reduce((a, b) => ptsOf(byId[b], mi) > ptsOf(byId[a], mi) ? b : a); setCaptain(capId); }
  };

  // Autofill: fill remaining squad slots with the highest next-MD xP players that are affordable,
  // reserving ~$3.9m per still-empty slot so the squad can always be completed to 15.
  const autofill = () => {
    const sq = [...squad];
    const priceOf = id => byId[id]?.price || 0;
    const cntP = pos => sq.map(id => byId[id]).filter(p => p && p.pos === pos).length;
    let guard = 0;
    while (sq.length < 15 && guard++ < 80) {
      const rem = PL_BUDGET - sq.reduce((s, id) => s + priceOf(id), 0);
      const reserve = (15 - sq.length - 1) * 3.9;   // keep enough for the cheapest remaining fills
      const cands = (pool || []).filter(p => !sq.includes(p.id) && cntP(p.pos) < PL_LIMITS[p.pos] && p.price <= rem - reserve + 1e-9);
      if (!cands.length) break;
      cands.sort((x, y) => ptsOf(y, NEXT_MD) - ptsOf(x, NEXT_MD) || (y.pts_balanced || 0) / y.price - (x.pts_balanced || 0) / x.price);
      sq.push(cands[0].id);
    }
    setSquad(sq);
  };

  const mdTotal = (mi) => {
    let t = starters.map(id => ptsOf(byId[id], mi)).reduce((s, x) => s + x, 0);
    if (captain && starters.includes(captain)) t += ptsOf(byId[captain], mi);   // captain scores double
    return Math.round(t * 10) / 10;
  };

  // suggested transfers for current MD: best same-position upgrade per squad player, within budget
  const suggestions = useMemo(() => {
    if (sp.length < 11) return [];
    const out = [];
    sp.forEach(o => {
      const cand = (pool || []).filter(c => c.pos === o.pos && !squad.includes(c.id) && c.price <= remaining + o.price + 1e-9)
        .map(c => ({ c, gain: +(ptsOf(c, md) - ptsOf(o, md)).toFixed(1) }))
        .sort((a, b) => b.gain - a.gain)[0];
      if (cand && cand.gain > 0.3) out.push({ outP: o, inP: cand.c, gain: cand.gain });
    });
    return out.sort((a, b) => b.gain - a.gain).slice(0, 5);
  }, [squad, md, remaining, pool]); // eslint-disable-line

  const applySwap = (outId, inId) => {
    const inP = byId[inId]; if (!inP) return;
    const wasStarter = starters.includes(outId), wasCap = captain === outId;
    setSquad(squad.map(x => x === outId ? inId : x));
    setStarters(prev => wasStarter ? prev.map(x => x === outId ? inId : x) : prev);
    if (wasCap) setCaptain(inId);
    setTransfers(t => t + 1);
  };

  const exportPng = async () => {
    setPngBusy(true);
    try {
      const mod = await import(/* @vite-ignore */ "https://esm.sh/html2canvas@1.4.1");
      const h2c = mod.default || mod;
      const node = document.getElementById("planner-export");
      const canvas = await h2c(node, { backgroundColor: "#0d1829", scale: 2 });
      const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
      const file = new File([blob], "wc26-planner-3mds.png", { type: "image/png" });
      const download = () => { const a = document.createElement("a"); a.download = file.name; a.href = URL.createObjectURL(blob); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
      // mobile: open the share sheet (→ "Save to Photos"); desktop or unsupported: download to Files
      if (mobile && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "WC26 Planner — my squad" }); }
        catch (e) { if (e && e.name !== "AbortError") download(); }   // not a user-cancel → fall back
      } else { download(); }
    } catch (e) { alert("PNG export needs an internet connection to load the renderer.\n(" + e.message + ")"); }
    setPngBusy(false);
  };

  const transferHit = Math.max(0, transfers - 2) * 4;
  const POS_ORDER = ["GK", "DEF", "MID", "FWD"];
  const btn = (active) => ({ padding: "7px 12px", borderRadius: 6, fontFamily: "inherit", fontSize: 12, cursor: "pointer", border: `1px solid ${active ? "#f97316" : BORDER}`, background: active ? "#f9731618" : "transparent", color: active ? "#f97316" : DIM });

  // ─ player chip used in squad list ─
  const SquadCard = (p) => {
    const isS = starters.includes(p.id), isC = captain === p.id, isVC = viceCaptain === p.id, pts = ptsOf(p, md), opp = oppOf(p, md), scout = scoutEligible(p);
    return (
      <div key={p.id} style={{ background: isS ? "#0f1c2d" : CARD, border: `1px solid ${isC ? "#fbbf24" : isVC ? "#cbd5e1" : isS ? "#22c55e55" : BORDER}`, borderRadius: 8, padding: "8px 10px", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, color: POS_COLOR[p.pos], fontFamily: MONO, width: 26 }}>{p.pos}</span>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div style={{ color: "#fff", fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{flagOf(p)} {p.name} {isC && <span style={{ color: "#fbbf24" }}>©</span>}{isVC && <span style={{ color: "#cbd5e1" }}>Ⓥ</span>} {scout && <span title="Scout-bonus eligible (<5% owned): +2 pts if returns >4">🔍</span>}</div>
          <div style={{ fontSize: 10, color: DIM }}>{p.team} · ${p.price}m · {opp ? `MD${md + 1} vs ${opp}` : `no MD${md + 1} fixture`} · <b style={{ color: pts > 6 ? "#f97316" : pts > 4 ? "#22c55e" : DIM }}>{pts} xP</b></div>
        </div>
        <button onClick={() => toggleStarter(p.id)} title="Toggle starter / bench" style={{ ...btn(isS), padding: "4px 8px" }}>{isS ? "XI" : "sub"}</button>
        <button onClick={() => { setCaptain(p.id); if (viceCaptain === p.id) setViceCaptain(null); }} disabled={!isS} title="Make captain" style={{ ...btn(isC), padding: "4px 8px", opacity: isS ? 1 : 0.4 }}>C</button>
        <button onClick={() => { setViceCaptain(p.id); if (captain === p.id) setCaptain(null); }} disabled={!isS} title="Make vice-captain" style={{ ...btn(isVC), padding: "4px 8px", opacity: isS ? 1 : 0.4 }}>VC</button>
        <button onClick={() => removePlayer(p.id)} title="Remove" style={{ ...btn(false), padding: "4px 8px", color: "#ff6b6b", borderColor: "#ef444455" }}>✕</button>
      </div>
    );
  };

  // ─ off-screen export node: all 3 MDs ─
  const ExportNode = () => (
    <div id="planner-export" style={{ position: "absolute", left: -99999, top: 0, width: 520, background: "#0d1829", padding: 18, fontFamily: SANS, color: TEXT }}>
      <div style={{ fontSize: 16, fontWeight: 900, color: "#fff", marginBottom: 2 }}>WC26 SCOUT — My Squad</div>
      <div style={{ fontSize: 10, color: DIM, marginBottom: 10 }}>Budget ${spent}m/{PL_BUDGET}m · {formationValid ? formationStr : "XI incomplete"}</div>
      {[0, 1, 2].map(mi => (
        <div key={mi} style={{ marginBottom: 12, borderTop: `1px solid ${BORDER}`, paddingTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#f97316", marginBottom: 4 }}>MD{mi + 1} ({PL_MD_DATES[mi]}) — {mdTotal(mi)} xPts</div>
          {starters.map(id => byId[id]).filter(Boolean).sort((a, b) => POS_ORDER.indexOf(a.pos) - POS_ORDER.indexOf(b.pos)).map(p => (
            <div key={p.id} style={{ fontSize: 11, color: "#cbd5e1", display: "flex", justifyContent: "space-between" }}>
              <span>{p.pos} · {p.name}{captain === p.id ? " ©" : ""} {oppOf(p, mi) ? `vs ${oppOf(p, mi)}` : ""}</span>
              <span style={{ color: "#94a3b8" }}>{ptsOf(p, mi)}{captain === p.id ? " ×2" : ""}</span>
            </div>
          ))}
        </div>
      ))}
      <div style={{ fontSize: 9, color: DIM, marginTop: 4 }}>makscouthijau.uk · xP = model projection incl. scout bonus</div>
    </div>
  );

  return (
    <div>
      {ExportNode()}
      <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", marginBottom: 2 }}>🧑‍💼 Team Planner</div>
      <div style={{ fontSize: 11, color: DIM, marginBottom: 12 }}>Build a 15-man squad under ${PL_BUDGET}m · pick your XI + captain · plan transfers across matchdays · saved in your browser</div>

      {/* budget + squad status */}
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
          <span>Budget: <b style={{ color: remaining < 0 ? "#ef4444" : "#fff" }}>${spent}m</b> / ${PL_BUDGET}m · <span style={{ color: remaining < 0 ? "#ef4444" : "#4ade80" }}>${remaining}m left</span></span>
          <span>Squad: <b style={{ color: squad.length === 15 ? "#4ade80" : "#fff" }}>{squad.length}/15</b> · XI: <b style={{ color: formationValid ? "#4ade80" : "#eab308" }}>{starters.length}/11 {formationValid ? `(${formationStr})` : "(invalid)"}</b></span>
        </div>
        <div style={{ height: 6, background: "#0a121f", borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.min(100, spent)}%`, background: remaining < 0 ? "#ef4444" : "linear-gradient(90deg,#22c55e,#f97316)" }} />
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <button onClick={autofill} disabled={squad.length >= 15} style={btn(false)}>✨ Autofill (best xP, affordable)</button>
          <button onClick={() => autoXI(md)} disabled={squad.length < 11} style={btn(false)}>⚡ Auto-pick XI (MD{md + 1})</button>
          <button onClick={exportPng} disabled={!starters.length || pngBusy} style={btn(false)}>{pngBusy ? "…rendering" : "📸 Save PNG (3 MDs)"}</button>
          <button onClick={() => { if (confirm("Clear your whole squad?")) { setSquad([]); setStarters([]); setCaptain(null); setViceCaptain(null); setTransfers(0); setPendingOut(0); setSubbingId(null); setMenuId(null); } }} style={{ ...btn(false), color: "#ff6b6b", borderColor: "#ef444455" }}>Clear</button>
        </div>
        {squad.length >= 15 && <div style={{ fontSize: 11, color: DIM, marginTop: 8 }}>Transfers made: <b style={{ color: "#fff" }}>{transfers}</b> · 2 free/MD, then −4 each → projected hit <b style={{ color: transferHit ? "#ef4444" : "#4ade80" }}>−{transferHit}</b> · <button onClick={() => setTransfers(0)} style={{ background: "none", border: "none", color: "#f97316", cursor: "pointer", fontSize: 11, padding: 0 }}>reset (new matchday)</button></div>}
      </div>

      {/* MD tabs + total */}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        {[0, 1, 2].map(i => <button key={i} onClick={() => setMd(i)} style={btn(md === i)}>MD{i + 1}</button>)}
        <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: "#fff" }}>MD{md + 1} projected: <span style={{ color: "#f97316" }}>{mdTotal(md)} xPts</span></span>
      </div>

      <div style={{ display:"flex", gap:14, alignItems:"flex-start", flexDirection: mobile?"column":"row", marginBottom:10 }}>
      <div style={{ flex:"1 1 0", minWidth:0 }}>
      {/* PITCH — selected starting XI in auto-formation + bench (shown on mobile too) */}
      {(
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>Starting XI {formationValid ? `· ${formationStr}` : `· ${starters.length}/11`} {!formationValid && <span style={{ color: "#eab308", fontWeight: 400, fontSize: 11 }}>(pick a valid XI: 1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD)</span>}</span>
            <span style={{ fontSize: 11, color: DIM }}>tap a player = captain · MD{md + 1}: <b style={{ color: "#f97316" }}>{mdTotal(md)} xPts</b></span>
          </div>
          <div onClick={() => setMenuId(null)} style={{ position: "relative", width: "100%", maxWidth: 560, margin: "0 auto", aspectRatio: "3/4", background: "linear-gradient(#0a3d1f,#072d17)", border: "2px solid #1e6b3a", borderRadius: 10 }}>
            <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "#2e7d4f" }} />
            <div style={{ position: "absolute", left: "30%", right: "30%", bottom: 0, height: "14%", border: "1px solid #2e7d4f", borderBottom: "none" }} />
            {[["GK", 88], ["DEF", 70], ["MID", 48], ["FWD", 24]].flatMap(([ln, y]) => {
              const arr = starters.map(id => byId[id]).filter(p => p && p.pos === ln), n = arr.length;
              return arr.map((p, i) => {
                const x = n === 1 ? 50 : 50 + (i - (n - 1) / 2) * Math.min(22, 76 / (n - 1)), isC = captain === p.id, isVC = viceCaptain === p.id, pts = ptsOf(p, md), opp = oppOf(p, md);
                const bord = isC ? "3px solid #fbbf24" : isVC ? "3px solid #cbd5e1" : subbingId === p.id ? "3px dashed #f97316" : "2px solid #ffffff55";
                return (
                  <div key={p.id} style={{ position: "absolute", left: `${x}%`, top: `${y}%`, transform: "translate(-50%,-50%)", textAlign: "center", width: mobile?56:78, zIndex: menuId === p.id ? 30 : 1 }}>
                    <div onClick={(e) => { e.stopPropagation(); setSubbingId(null); setMenuId(menuId === p.id ? null : p.id); }} title="Tap for options"
                      style={{ width: mobile?40:46, height: mobile?40:46, margin: "0 auto", borderRadius: "50%", background: POS_COLOR[p.pos], display: "flex", alignItems: "center", justifyContent: "center", fontSize: mobile?11:12, fontWeight: 800, color: "#fff", border: bord, position: "relative", cursor: "pointer" }}>
                      {pts}
                      {isC && <span style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, fontSize: 10, fontWeight: 800, background: "#fbbf24", color: "#000", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }}>C</span>}
                      {isVC && <span style={{ position: "absolute", top: -7, right: -8, minWidth: 18, height: 16, padding: "0 3px", fontSize: 8, fontWeight: 800, background: "#cbd5e1", color: "#000", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center" }}>VC</span>}
                    </div>
                    <div style={{ fontSize: mobile?9:11, color: "#fff", fontWeight: 700, marginTop: 3, textShadow: "0 1px 3px #000", lineHeight: 1.1, maxWidth: mobile?56:78, marginLeft: "auto", marginRight: "auto", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{p.name}</div>
                    {opp && <div style={{ fontSize: 9, color: "#9fb4c9", textShadow: "0 1px 3px #000" }}>vs {opp}</div>}
                    {menuId === p.id && (
                      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: "50%", top: 48, transform: "translateX(-50%)", background: "#0d1829", border: `1px solid ${BORDER}`, borderRadius: 8, padding: 4, display: "flex", flexDirection: "column", gap: 3, width: 128, boxShadow: "0 6px 16px #000b" }}>
                        <button onClick={() => { setCaptain(p.id); if (viceCaptain === p.id) setViceCaptain(null); setMenuId(null); }} style={{ ...btn(isC), padding: "5px 8px", textAlign: "left" }}>© Captain</button>
                        <button onClick={() => { setViceCaptain(p.id); if (captain === p.id) setCaptain(null); setMenuId(null); }} style={{ ...btn(isVC), padding: "5px 8px", textAlign: "left" }}>Ⓥ Vice-captain</button>
                        <button onClick={() => { setSubbingId(p.id); setMenuId(null); }} style={{ ...btn(false), padding: "5px 8px", textAlign: "left" }}>⇄ Sub out</button>
                      </div>
                    )}
                  </div>
                );
              });
            })}
            {starters.length === 0 && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#cbd5e1", fontSize: 13, textAlign: "center", padding: 24 }}>Add players below and tap <b>&nbsp;sub→XI&nbsp;</b> to build your XI — or hit <b>&nbsp;Auto-pick XI</b>.</div>}
          </div>
          {/* bench */}
          <div style={{ marginTop: 10 }}>
            {subbingId ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#fbbf24" }}>Subbing out <b>{byId[subbingId]?.name}</b> — tap a highlighted replacement:</span>
                <button onClick={() => setSubbingId(null)} style={{ ...btn(false), padding: "3px 8px" }}>cancel</button>
              </div>
            ) : (
              <div style={{ fontSize: 10, letterSpacing: 2, color: DIM, fontFamily: MONO, marginBottom: 6 }}>BENCH ({benchPlayers.length}) — tap to move into XI</div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {benchPlayers.length === 0 ? <span style={{ fontSize: 11, color: DIM }}>No substitutes yet.</span>
                : benchPlayers.map(p => {
                  const canIn = subbingId ? validReplacement(subbingId, p.id) : false;
                  const dim = subbingId && !canIn;
                  return (
                    <div key={p.id} onClick={() => { if (subbingId) { if (canIn) doSub(subbingId, p.id); } else toggleStarter(p.id); }}
                      title={subbingId ? (canIn ? "Swap in" : "Can't swap — would break the formation") : "Move into starting XI"}
                      style={{ background: CARD, border: `1px solid ${canIn ? "#22c55e" : BORDER}`, borderRadius: 8, padding: "6px 10px", cursor: dim ? "not-allowed" : "pointer", minWidth: 130, opacity: dim ? 0.4 : 1, boxShadow: canIn ? "0 0 8px #22c55e55" : "none" }}>
                      <div style={{ fontSize: 12, color: "#fff", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150 }}><span style={{ color: POS_COLOR[p.pos], fontFamily: MONO, fontSize: 10 }}>{p.pos}</span> {flagOf(p)} {p.name}</div>
                      <div style={{ fontSize: 10, color: DIM }}>{ptsOf(p, md)} xP · ${p.price}m</div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
      </div>{/* left: pitch + bench */}
      <div style={{ flex:"1 1 0", minWidth:0 }}>
      <div style={{ fontSize:11, letterSpacing:1, color:DIM, fontFamily:MONO, marginBottom:6 }}>YOUR SQUAD ({squad.length}/15) — toggle XI / captain</div>
      {/* squad by position + add buttons */}
      {POS_ORDER.map(pos => (
        <div key={pos} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, letterSpacing: 1, color: POS_COLOR[pos], fontFamily: MONO, marginBottom: 4 }}>{pos} ({countPos(pos)}/{PL_LIMITS[pos]})</div>
          <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fill,minmax(300px,1fr))", gap: 6 }}>
            {sp.filter(p => p.pos === pos).sort((a, b) => ptsOf(b, md) - ptsOf(a, md)).map(SquadCard)}
            {countPos(pos) < PL_LIMITS[pos] && <button onClick={() => { setPickPos(pos); setPickQ(""); setPickMax(""); }} style={{ ...btn(pickPos === pos), padding: "10px", borderStyle: "dashed" }}>+ Add {pos}</button>}
          </div>
        </div>
      ))}
      </div>{/* right: squad selection */}
      </div>{/* pitch + squad 2-col */}

      {/* inline picker */}
      {pickPos && (
        <div style={{ background: CARD, border: `1px solid #f9731655`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <b style={{ color: "#fff", fontSize: 13 }}>Add a {pickPos} — highest MD{md + 1} xP first</b>
            <button onClick={() => setPickPos(null)} style={{ ...btn(false), padding: "4px 8px" }}>close</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input autoFocus placeholder="Search player or team…" value={pickQ} onChange={e => setPickQ(e.target.value)} style={{ flex: "1 1 160px", minWidth: 0, background: "#0a121f", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "8px 10px", color: TEXT, fontFamily: "inherit", fontSize: 13 }} />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: DIM, whiteSpace: "nowrap" }}>Max £
              <input type="number" min="0" step="0.1" placeholder={`${remaining}`} value={pickMax} onChange={e => setPickMax(e.target.value)} style={{ width: 64, background: "#0a121f", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "8px 8px", color: TEXT, fontFamily: "inherit", fontSize: 13 }} />m
            </label>
            <span style={{ fontSize: 10, color: DIM }}>affordable ≤ ${remaining}m</span>
          </div>
          {(() => { const cap = pickMax !== "" ? Math.min(remaining, +pickMax || 0) : remaining; return (
          <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {(pool || []).filter(p => p.pos === pickPos && !squad.includes(p.id) && p.price <= cap + 1e-9)
              .filter(p => { const s = pickQ.toLowerCase(); return !s || p.name.toLowerCase().includes(s) || p.team.toLowerCase().includes(s); })
              .map(p => ({ p, s: ptsOf(p, md) })).sort((a, b) => b.s - a.s).slice(0, 40)
              .map(({ p, s }) => (
                <div key={p.id} onClick={() => addPlayer(p)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: "pointer", border: `1px solid ${BORDER}33` }}>
                  <span style={{ color: "#fff", fontSize: 13, fontWeight: 600, flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{flagOf(p)} {p.name} {scoutEligible(p) && "🔍"}</span>
                  <span style={{ fontSize: 11, color: DIM }}>{p.team}</span>
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>${p.price}m</span>
                  <span style={{ fontSize: 12, color: s > 6 ? "#f97316" : s > 4 ? "#22c55e" : DIM, fontWeight: 700, width: 34, textAlign: "right" }}>{s}</span>
                </div>
              ))}
          </div>
          ); })()}
        </div>
      )}

      {/* watchlist (highlighted in the Players tab) → quick-add to squad */}
      <WatchlistBox players={pool} watch={watch} toggleWatch={toggleWatch} md={md} onPick={(p) => addPlayer(p)} pickLabel="+ add" />

      {/* suggested transfers */}
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, marginTop: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 6 }}>💡 Suggested transfers — MD{md + 1} (by xP gain · 🔍 = scout upgrade)</div>
        {sp.length < 11 ? <div style={{ fontSize: 12, color: DIM }}>Fill your squad to see transfer suggestions.</div>
          : suggestions.length === 0 ? <div style={{ fontSize: 12, color: DIM }}>No positive-value swaps within budget — your squad looks optimal for MD{md + 1}.</div>
            : suggestions.map((sg, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: i ? `1px solid ${BORDER}33` : "none", fontSize: 12, flexWrap: "wrap" }}>
                <span style={{ color: "#ff8c42", flex: "1 1 120px" }}>OUT {sg.outP.name} <span style={{ color: DIM }}>({ptsOf(sg.outP, md)})</span></span>
                <span style={{ color: "#4ade80", flex: "1 1 120px" }}>IN {sg.inP.name} {scoutEligible(sg.inP) && "🔍"} <span style={{ color: DIM }}>({ptsOf(sg.inP, md)}, ${sg.inP.price}m)</span></span>
                <span style={{ color: "#f97316", fontWeight: 700 }}>+{sg.gain}</span>
                <button onClick={() => applySwap(sg.outP.id, sg.inP.id)} style={{ ...btn(false), padding: "4px 8px" }}>apply</button>
              </div>
            ))}
      </div>
      <div style={{ fontSize: 10, color: "#475569", marginTop: 10, fontStyle: "italic" }}>xP projections reuse the dashboard model (per-MD fixture odds, role shift, minutes) and include a projected scout bonus (+2 if &lt;5% owned and &gt;4 pts). Plan only — verify against the AI Lineups and News tabs.</div>
    </div>
  );
}

// ─── TAB: ODDS (model-implied match + scorer/assist probabilities, MD1–3) ─────────
function OddsTab({ pool, lineups, mobile }) {
  const [md, setMd] = useState(NEXT_MD);
  if (!pool || !pool.length) return <div style={{ color: DIM }}>No data.</div>;
  const teams = {};
  pool.forEach(p => {
    if (!teams[p.team]) teams[p.team] = { flag: lineups?.teams?.[p.team]?.flag || TEAM_FLAG[p.team] || p.nat || "", fx: {}, players: [] };
    teams[p.team].players.push(p);
    (p.fixtures || []).forEach((f, idx) => { teams[p.team].fx[idx] = f; });   // key by 0-based MD index (matches mdScore)
  });
  const seen = new Set(), matches = [];
  Object.entries(teams).forEach(([t, info]) => {
    const f = info.fx[md]; if (!f) return;
    const key = [t, f.opponent].sort().join("|");
    if (seen.has(key)) return; seen.add(key);
    matches.push({ a: t, b: f.opponent, fa: f });
  });
  matches.sort((x, y) => Math.max(y.fa.oddsWin, y.fa.oddsLoss) - Math.max(x.fa.oddsWin, x.fa.oddsLoss));
  const pct = v => Math.round((v || 0) * 100);
  const flag = t => teams[t]?.flag || "";
  const scorers = (mt) => {
    const ps = [...(teams[mt.a]?.players || []), ...(teams[mt.b]?.players || [])]
      .map(p => ({ p, ...mdScorerProb(p, md) })).filter(x => x.pGoal > 0.03);
    return { goals: ps.slice().sort((a, b) => b.pGoal - a.pGoal).slice(0, 5), assists: ps.slice().sort((a, b) => b.pAssist - a.pAssist).slice(0, 3) };
  };
  const MD_DATES = ["Jun 11–15", "Jun 16–21", "Jun 22–27"];
  const Row = ({ g, key2 }) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
      <span style={{ color: "#e2e8f0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.p.name} <span style={{ color: DIM, fontSize: 10 }}>{g.p.team}</span></span>
      <span style={{ color: g[key2] > 0.4 ? "#f97316" : g[key2] > 0.22 ? "#22c55e" : DIM, fontWeight: 700, flex: "0 0 auto", marginLeft: 8 }}>{pct(g[key2])}%</span>
    </div>
  );
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>🎲 Match Odds & Scorer Probabilities</div>
      <div style={{ fontSize: 11, color: DIM, marginBottom: 10 }}>Model-implied probabilities (Poisson on the xG/xA model) — not bookmaker lines. Group stage · {matches.length} fixtures.</div>
      <div style={{ display: "flex", gap: 4, marginBottom: 12, alignItems: "center" }}>
        {[0, 1, 2].map(i => <button key={i} onClick={() => setMd(i)} style={{ padding: "7px 16px", borderRadius: 6, fontFamily: "inherit", fontSize: 13, cursor: "pointer", fontWeight: md === i ? 700 : 400, border: `1px solid ${md === i ? "#f97316" : BORDER}`, background: md === i ? "#f9731618" : "transparent", color: md === i ? "#f97316" : DIM }}>MD{i + 1}</button>)}
        <span style={{ marginLeft: "auto", fontSize: 11, color: DIM }}>{MD_DATES[md]}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fill,minmax(330px,1fr))", gap: 12 }}>
        {matches.map((mt, i) => {
          const fa = mt.fa, wA = fa.oddsWin, dr = fa.oddsDraw, wB = fa.oddsLoss;
          const csA = csFromFixture(fa), csB = wB * 0.72 + dr * 0.28;
          const { goals, assists } = scorers(mt);
          return (
            <div key={i} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 8, gap: 6 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{flag(mt.a)} {mt.a}</span>
                <span style={{ color: DIM, fontSize: 10, flex: "0 0 auto" }}>vs</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>{mt.b} {flag(mt.b)}</span>
              </div>
              <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 4 }}>
                <div style={{ width: `${pct(wA)}%`, background: "#22c55e" }} />
                <div style={{ width: `${pct(dr)}%`, background: "#475569" }} />
                <div style={{ width: `${pct(wB)}%`, background: "#3b82f6" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 8 }}>
                <span style={{ color: "#4ade80" }}>{pct(wA)}% W</span><span style={{ color: DIM }}>{pct(dr)}% D</span><span style={{ color: "#60a5fa" }}>{pct(wB)}% W</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8", marginBottom: 8, borderBottom: `1px solid ${BORDER}`, paddingBottom: 8 }}>
                <span>🧤 {mt.a}: <b style={{ color: csA > 0.4 ? "#4ade80" : TEXT }}>{pct(csA)}%</b> CS</span>
                <span>🧤 {mt.b}: <b style={{ color: csB > 0.4 ? "#4ade80" : TEXT }}>{pct(csB)}%</b> CS</span>
              </div>
              <div style={{ fontSize: 10, letterSpacing: 1, color: DIM, marginBottom: 4, fontFamily: MONO }}>⚽ ANYTIME SCORER</div>
              {goals.length ? goals.map((g, j) => <Row key={j} g={g} key2="pGoal" />) : <div style={{ fontSize: 11, color: DIM }}>—</div>}
              <div style={{ fontSize: 10, letterSpacing: 1, color: DIM, margin: "8px 0 4px", fontFamily: MONO }}>🅰 ANYTIME ASSIST</div>
              {assists.length ? assists.map((g, j) => <Row key={j} g={g} key2="pAssist" />) : <div style={{ fontSize: 11, color: DIM }}>—</div>}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "#475569", marginTop: 12, fontStyle: "italic" }}>Win/draw/loss from odds-derived fixture probabilities. Clean sheet = win×0.72 + draw×0.28. Anytime scorer/assist = 1 − e^(−λ), λ = expected goals/assists this match (xG/xA × minutes × fixture goal-context). Model estimates, not betting advice.</div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("table");
  const [riskMode, setRiskMode] = useState("balanced");
  const [posFilter, setPosFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("displayPts");
  const [search, setSearch] = useState("");
  const [ownMax, setOwnMax] = useState(100);
  const [priceMax, setPriceMax] = useState(11);
  const [selected, setSelected] = useState(null);
  const [mispricedOnly, setMispricedOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [F, setF] = useState(FILTER_DEFAULT);
  const [tierPos, setTierPos] = useState("ALL");
  const [pureDiff, setPureDiff] = useState(false);
  const [lineupSel, setLineupSel] = useState("Spain");
  const [lineupCmp, setLineupCmp] = useState(null);

  const [rawPlayers, setRawPlayers] = useState(null);
  const [dataTimestamp, setDataTimestamp] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [lineups, setLineups] = useState(null);
  const [news, setNews] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [watch, setWatch] = useState(() => { try { return JSON.parse(localStorage.getItem("wc26_watch") || "[]"); } catch { return []; } });
  const toggleWatch = (id) => setWatch(w => w.includes(id) ? w.filter(x => x !== id) : [...w, id]);
  useEffect(() => { try { localStorage.setItem("wc26_watch", JSON.stringify(watch)); } catch { /* private mode */ } }, [watch]);
  const [loading, setLoading] = useState(true);     // artificial 1s loader on open + every tab switch
  const [loaderFrame, setLoaderFrame] = useState(0);
  const { mobile, narrow } = useIsMobile();

  useEffect(() => {
    Promise.all([
      fetch("/data/players.json").then(r => { if (!r.ok) throw new Error("players " + r.status); return r.json(); }),
      fetch("/data/analytics.json").then(r => r.ok ? r.json() : null).catch(() => null), // optional
      fetch("/data/lineups.json").then(r => r.ok ? r.json() : null).catch(() => null), // optional
      fetch("/data/news.json").then(r => r.ok ? r.json() : null).catch(() => null), // optional
    ])
      .then(([players, a, l, nw]) => {
        // players.json may be a bare array (legacy) or { generated_at, players }
        const arr = Array.isArray(players) ? players : players.players;
        // merge R-model outputs (tier, tier_score, intl_premium_*, causal_pts_adjustment, form_mult, …)
        // from analytics.player_analytics by id — without this the Tiers tab/badges and smart filters are empty
        const paById = {}; (a?.player_analytics || []).forEach(r => { if (r && r.id != null) paById[r.id] = r; });
        // ground start probability in the predicted lineups: build a per-team name→role (XI/bench) lookup
        const lutok = nm => luNorm(nm).split(" ").filter(t => t.length > 2);
        const luByTeam = {};
        Object.entries(l?.teams || {}).forEach(([team, L]) => {
          const m = [];
          const add = (pl, role) => { const a = lutok(pl.name); m.push({ set: new Set(a), surname: a[a.length - 1] || "", role, status: pl.status || "CERTAIN" }); };
          (L.players || []).forEach(pl => add(pl, "XI"));
          (L.bench || []).forEach(pl => add(pl, "BENCH"));
          luByTeam[team] = m;
        });
        const roleOf = (p) => {
          const list = luByTeam[p.team]; if (!list) return null;            // team has no predicted lineup → keep prior
          const toks = lutok(p.name), ps = toks[toks.length - 1] || "", tset = new Set(toks);
          // surname match, plus mononym handling: "Alisson" (lineup) ↔ "Alisson Becker" (pool).
          // Still avoids "James" Trafford ↔ Reece "James" (neither side is a mononym there).
          const cands = list.filter(e =>
            e.surname === ps ||                                  // surname == surname
            (e.set.size === 1 && tset.has(e.surname)) ||         // lineup mononym appears in the pool name
            (toks.length === 1 && e.set.has(ps)));               // pool mononym appears in the lineup name
          if (!cands.length) return { role: "OUT" };                        // in squad but not XI/bench → deep squad
          let best = cands[0], bestS = -1;                                  // disambiguate same-surname by full overlap
          cands.forEach(e => { const s = toks.filter(t => e.set.has(t)).length; if (s > bestS) { bestS = s; best = e; } });
          return best;
        };
        const merged = arr.map(p => {
          const q = paById[p.id] ? { ...p, ...paById[p.id], id: p.id } : { ...p };
          const m = roleOf(q);
          if (m) {
            if (m.role === "XI") {
              // start prob from the lineup's confidence; minutes by position (forwards subbed more than keepers)
              q.startProb = m.status === "DOUBT" ? 0.62 : m.status === "PROBABLE" ? 0.82 : 0.92;
              q.minsIfStarted = q.pos === "GK" ? 90 : q.pos === "DEF" ? 88 : q.pos === "MID" ? 84 : 80;
            } else if (m.role === "BENCH") { q.startProb = 0.30; q.minsIfStarted = 30; }
            else { q.startProb = 0.10; q.minsIfStarted = 15; }              // OUT (deep squad)
          }
          // recompute the GROUP-STAGE points distribution with the grounded start prob so the Players
          // table, Tiers and smart filters all read the same numbers (E_MATCHES is fixed at 3 inside)
          const cp = computePrediction(q);
          q.pts_safe = +cp.pts_median.toFixed(1); q.pts_balanced = +cp.pts_mean.toFixed(1); q.pts_diff = +cp.pts_p90.toFixed(1);
          return q;
        });
        // re-derive tier_score + tier letters (S/A/B/C/D) on the group-stage numbers, replacing the
        // R pipeline's full-tournament tiers so the Tiers tab matches the rest of the dashboard
        const tierScoreOf = q => {
          const scoutEV = q.own < 5 ? 1.8 : 0;
          const capB = q.captainSlot === 3 ? 1 : q.captainSlot === 2 ? 0.5 : 0;
          const setP = (q.penTaker ? 1 : 0) + (q.fkTaker ? 0.6 : 0) + (q.cornerTaker ? 0.4 : 0);
          const cardPen = q.cardRisk === "high" ? 1.5 : q.cardRisk === "medium" ? 0.6 : 0;
          const startPen = (1 - (q.startProb ?? 0.5)) * 4;          // rotation risk
          const exitPen = (1 - ((q.advP ?? 50) / 100)) * 2;          // early-exit risk
          return (q.pts_diff || 0) * 0.45 + ((q.pts_diff || 0) - (q.pts_safe || 0)) * 0.20 + scoutEV * 0.15 + ((q.intl_premium_score || 0)) * 0.10 + capB * 0.5 + setP * 0.4 - cardPen - startPen - exitPen;
        };
        merged.forEach(q => { q.tier_score = +tierScoreOf(q).toFixed(1); });
        const ORD = ["S", "A", "B", "C", "D"];
        // rank tiers WITHIN the realistic fantasy pool (likely starters, startProb ≥ 0.5), not all 1481 —
        // otherwise the ~745 deep-squad players dilute the cutoffs and S-tier balloons.
        const relevant = merged.filter(q => (q.startProb ?? 0) >= 0.5).sort((x, y) => y.tier_score - x.tier_score);
        const NT = relevant.length || 1;
        relevant.forEach((q, i) => {
          const pct = i / NT;
          let t = pct < 0.08 ? "S" : pct < 0.25 ? "A" : pct < 0.50 ? "B" : pct < 0.75 ? "C" : "D";
          if ((q.startProb ?? 1) < 0.70 && (t === "S" || t === "A")) t = "B";        // not a nailed starter → cap at B
          if ((q.advP ?? 100) < 40 && t === "S") t = "A";                              // unlikely to advance → no S
          let idx = ORD.indexOf(t);
          if (q.own > 55) idx = Math.min(4, idx + 1);                                   // heavy template → down one
          if ((q.intl_premium_score || 0) > 1.5 && q.own < 10) idx = Math.max(0, idx - 1); // hidden edge → up one
          q.tier = ORD[idx];
        });
        merged.forEach(q => { if ((q.startProb ?? 0) < 0.5) q.tier = "D"; });          // deep squad → bottom tier
        setRawPlayers(merged);
        setDataTimestamp(Array.isArray(players) ? null : players.generated_at);
        setAnalytics(a); setLineups(l); setNews(nw);
      })
      .catch(err => { console.error("Failed to load data:", err); setLoadError(true); });
  }, []);

  // artificial 1-second loader on open/refresh and on every tab switch
  useEffect(() => { setLoading(true); const id = setTimeout(() => setLoading(false), 1000); return () => clearTimeout(id); }, [tab]);
  // while loading, flip through the loader images (kid calm → kid shouting → tucheliban)
  useEffect(() => { if (!loading) return; const id = setInterval(() => setLoaderFrame(f => f + 1), 260); return () => clearInterval(id); }, [loading]);

  const goToPlayer = (name) => { setSearch(name); setPosFilter("ALL"); setTab("table"); };

  const formById = useMemo(() => {
    const m = {}; (analytics?.form_log || []).forEach(r => { (m[r.id] = m[r.id] || []).push(r); }); return m;
  }, [analytics]);
  const clusterByTeam = useMemo(() => {
    const m = {}; (analytics?.team_clusters || []).forEach(t => { m[t.team] = (t.team_cluster||"").replace(/_\d+$/,""); }); return m;
  }, [analytics]);

  const players = useMemo(() => {
    if (!rawPlayers) return [];
    return rawPlayers
      .filter(p => posFilter === "ALL" || p.pos === posFilter)
      .filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.team.toLowerCase().includes(search.toLowerCase()))
      .filter(p => p.own <= ownMax)
      .filter(p => p.price <= priceMax)
      .filter(p => !mispricedOnly || ((p.roleShift !== "SAME" || p.mispricing_flag === "UNDERRATED") && p.own < 20))
      .filter(p => passesFilters(p, F, clusterByTeam))
      .map(p => ({ ...p, ...computePrediction(p, riskMode), formMatches: formById[p.id] || [] }))
      .sort((a,b) => {
        if (sortBy === "displayPts") return b.displayPts - a.displayPts;
        if (sortBy === "value")      return b.value - a.value;
        if (sortBy === "price")      return b.price - a.price;
        if (sortBy === "own")        return b.own - a.own;
        if (sortBy === "tier")       return (b.tier_score||0) - (a.tier_score||0);
        if (sortBy === "md0")        return mdScore(b, 0).pts - mdScore(a, 0).pts;
        if (sortBy === "md1")        return mdScore(b, 1).pts - mdScore(a, 1).pts;
        if (sortBy === "md2")        return mdScore(b, 2).pts - mdScore(a, 2).pts;
        if (sortBy === "xmins")      return (b.E_mins||0) - (a.E_mins||0);
        if (sortBy === "intl")       return (b.intl_premium_score||0) - (a.intl_premium_score||0);
        if (sortBy === "role")       return ((ROLE_MULT[b.roleShift]||[1])[0]) - ((ROLE_MULT[a.roleShift]||[1])[0]);
        return 0;
      });
  }, [rawPlayers, riskMode, posFilter, sortBy, search, ownMax, priceMax, mispricedOnly, formById, F, clusterByTeam]);

  const optimal = useMemo(() => buildOptimalSquads(rawPlayers || []), [rawPlayers]);

  const LOADER_IMGS = ["/img/makkauijau.png", "/img/makkauijau_shout.png", "/img/tucheliban.png"];
  const loaderOverlay = (
    <div style={{ position:"fixed", inset:0, zIndex:9999, background:"rgba(6,13,26,0.97)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, fontFamily:SANS }}>
      <GlobalCSS />
      <img key={loaderFrame % LOADER_IMGS.length} src={LOADER_IMGS[loaderFrame % LOADER_IMGS.length]} alt="" className="mki-shake" style={{ height:100, width:100, objectFit:"contain", filter:"drop-shadow(0 3px 8px #000a)" }} />
      <div style={{ fontSize:15, fontWeight:800, color:"#4ade80", fontStyle:"italic" }}>Mak kau ijau…</div>
    </div>
  );

  if (loadError) return (
    <div style={{ background:BG, minHeight:"100vh", color:TEXT, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12, fontFamily:SANS }}>
      <GlobalCSS />
      <img src="/img/makkauijau.png" alt="" className="mki-shake" style={{ height:90, filter:"drop-shadow(0 3px 6px #000a)" }} />
      <div style={{ fontSize:15, fontWeight:800, color:"#ff6b6b", fontStyle:"italic" }}>Mak kau ijau — data tak nak load 😤</div>
      <div style={{ fontSize:12, color:DIM }}>Failed to load data. Try refreshing.</div>
    </div>);
  if (!rawPlayers) return loaderOverlay;

  const TABS = [["table","📊 Players"],["planner","🧑‍💼 Planner"],["xi","⚽ Fantasy XI"],["squads","🧮 Squad Strategies"],["lineups","📋 AI Predicted Starting XIs"],["news","📡 News"],["tiers","🏆 Tiers"],["odds","🎲 Odds"],["causal","🔮 Causal"],["method","🔬 Method"]];
  return (
    <div style={{ background:BG, minHeight:"100vh", color:TEXT, fontFamily:SANS, fontSize:mobile?14:13, fontVariantNumeric:"tabular-nums" }}>
      <GlobalCSS />
      {loading && loaderOverlay}
      <div style={{ background:"linear-gradient(135deg,#0d1829,#0a1020)", borderBottom:`1px solid ${BORDER}`, padding:mobile?"12px 12px 0":"16px 20px 0" }}>
        <div style={{ maxWidth:1240, margin:"0 auto" }}>
          {!mobile && <div style={{ fontSize:9, letterSpacing:5, color:"#f97316", marginBottom:4, fontFamily:MONO }}>FIFA WORLD CUP 2026 · FANTASY ANALYTICS</div>}
          <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
            <div title="Mak kau ijau" style={{ display:"flex", flexDirection:"column", alignItems:"center", flex:"0 0 auto" }}>
              <img src="/img/makkauijau.png" alt="Mak kau ijau" className="mki-shake" style={{ height:mobile?40:52, width:"auto", display:"block", filter:"drop-shadow(0 2px 5px #000a)" }} />
              <span style={{ fontSize:mobile?8:9, fontWeight:800, color:"#4ade80", marginTop:2, whiteSpace:"nowrap", fontStyle:"italic", letterSpacing:0.3 }}>Mak kau ijau</span>
            </div>
            <div style={{ fontSize:mobile?20:24, fontWeight:900, letterSpacing:-1, color:"#fff" }}>
              <span style={{ fontSize:mobile?15:17, fontWeight:400, fontStyle:"italic", color:"#fff" }}>tucheliban's </span>
              WC26 <span style={{ color:"#f97316" }}>SCOUT</span>
            </div>
            <span style={{ fontSize:11, fontStyle:"italic", color:"#64748b" }}>it's coming home 🏴󠁧󠁢󠁥󠁮󠁧󠁿</span>
            <span style={{ marginLeft:"auto" }}><UrlBadge /></span>
          </div>
          <div style={{ fontSize:mobile?10:11, color:"#475569", marginTop:3, fontStyle:"italic" }}>makscouthijau — .uk because that was the cheapest domain</div>
          <div style={{ fontSize:mobile?11:12, color:DIM, marginTop:4 }}>Points Prediction Engine · {rawPlayers.length} players · R-model engine{analytics ? " · analytics loaded" : ""}</div>
        </div>
      </div>

      <DeadlineBanner mobile={mobile} />

      <div className="tabwrap" style={{ background:"linear-gradient(135deg,#0d1829,#0a1020)", borderBottom:`1px solid ${BORDER}` }}>
        <div style={{ maxWidth:1240, margin:"0 auto", padding:mobile?"0 12px":"0 20px" }}>
          <div className="tabbar" style={{ display:"flex", gap:mobile?2:4 }}>
            {TABS.map(([k,l]) => (
              <button key={k} onClick={()=>setTab(k)} style={{ padding:mobile?"8px 10px":"8px 14px", minHeight:mobile?44:0, border:"none", whiteSpace:"nowrap",
                borderBottom:`2px solid ${tab===k?"#f97316":"transparent"}`, background:"transparent",
                color:tab===k?"#f97316":DIM, cursor:"pointer", fontFamily:"inherit", fontSize:mobile?11:12, fontWeight:tab===k?700:400 }}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1240, margin:"0 auto", padding:mobile?"14px 12px 40px":"16px 16px 40px" }}>
        {tab==="table" && <PlayerTableTab {...{ players, selected, setSelected, riskMode, setRiskMode,
          posFilter, setPosFilter, sortBy, setSortBy, search, setSearch, ownMax, setOwnMax, priceMax, setPriceMax, mispricedOnly, setMispricedOnly,
          F, setF, showFilters, setShowFilters, allPlayers: rawPlayers, mobile, dataTimestamp, watch, toggleWatch }} />}
        {tab==="xi" && <StartingXITab pool={rawPlayers} mobile={mobile} />}
        {tab==="planner" && <PlannerTab pool={rawPlayers} mobile={mobile} watch={watch} toggleWatch={toggleWatch} />}
        {tab==="lineups" && <LineupsTab lineups={lineups} pool={rawPlayers} goToPlayer={goToPlayer} mobile={mobile} narrow={narrow} sel={lineupSel} setSel={setLineupSel} cmp={lineupCmp} setCmp={setLineupCmp} />}
        {tab==="news" && <NewsTab news={news} mobile={mobile} />}
        {tab==="odds" && <OddsTab pool={rawPlayers} lineups={lineups} mobile={mobile} />}
        {tab==="squads" && <OptimalSquadsTab squads={optimal.squads} meta={optimal.meta} mobile={mobile} />}
        {tab==="tiers" && <TiersTab tiers={analytics?.tier_list} pool={rawPlayers} riskMode={riskMode} posFilter={tierPos} setPosFilter={setTierPos} pureDiff={pureDiff} setPureDiff={setPureDiff} mobile={mobile} />}
        {tab==="causal" && <CausalTab causal={analytics?.causal_analysis} players={rawPlayers} />}
        {tab==="method" && <MethodTab analytics={analytics} />}

        {analytics?.model_summary && (
          <div style={{ display:"flex", gap:16, marginTop:24, flexWrap:"wrap", fontSize:10, color:DIM, borderTop:`1px solid ${BORDER}`, paddingTop:12 }}>
            <span>{analytics.model_summary.n_underrated} underrated · {analytics.model_summary.n_overrated} overrated</span>
            <span>top value: {analytics.model_summary.top_value_pick}</span>
            <span>top differential: {analytics.model_summary.top_differential}</span>
            <span style={{ marginLeft:"auto", color:"#475569" }}>R pipeline · FBref-blocked → seed-model · {analytics.generated_at}</span>
          </div>
        )}
      </div>
    </div>
  );
}
