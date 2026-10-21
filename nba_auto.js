#!/usr/bin/env node
/* NBA Edge Model v1.6 - headless runner (GitHub Actions). Same engine as the HTML model.
 *
 *   node nba_auto.js predict   today's picks + game projections -> state/pending.json   (never committed: picks stay private until games finish)
 *   node nba_auto.js grade     finished games -> graded rows appended to results/YYYY-MM.json (with closing lines)
 *   node nba_auto.js refit     refit calibration from graded rows, guarded -> nba_calibration.json + nba_calibration_log.json
 *   node nba_auto.js summary   -> nba_summary.json (what the Backtest tab reads)
 *   node nba_auto.js daily     grade -> refit -> summary -> predict
 * Options: --repo DIR (default .)  --state DIR (default ./state)  --data FILE (default <repo>/nba_model_data.json)  --now ISO (testing)
 */
'use strict';
const fs = require('fs'), path = require('path');
const E = require('./nba_engine.js');

const VERSION = '1.6';
const DEFAULTS = JSON.parse(JSON.stringify(E.getCalibration()));          // factory settings: the prior every refit is anchored to
const LIMITS = {   // guardrails: nothing moves without enough samples, never leaves [min,max], never moves more than `step` per run
  W_MARKET_SPREAD: { min: 0.20, max: 0.95, step: 0.05, minN: 60, tau: 0.15 },
  W_MARKET_TOTAL: { min: 0.20, max: 0.95, step: 0.05, minN: 60, tau: 0.15 },
  PROP_W_MARKET: { min: 0.10, max: 0.70, step: 0.04, minN: 200, tau: 0.12 },
  SHRINK: { min: 0.25, max: 1.00, step: 0.05, minN: 150, tau: 0.20 },
  PLATT_A: { min: 0.60, max: 1.40, step: 0.04, minN: 150, tau: 0.15 },
  PLATT_B: { min: -0.40, max: 0.40, step: 0.03, minN: 150, tau: 0.15 },
  MARGIN_SD: { min: 9, max: 17, step: 0.4, minN: 60, tau: 1.5 },
  TOTAL_SD: { min: 14, max: 24, step: 0.5, minN: 60, tau: 2.0 }
};
const STATS = ['pts', 'reb', 'ast', 'fg3m', 'pra', 'stl', 'blk'];
const MIN_DAYS = 10, SAMPLE_PCT = 12, SAMPLE_CAP = 250, PENDING_MAX_DAYS = 4, WINDOW = 4000;

// ── small helpers ───────────────────────────────────────────────────────────
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r3 = x => (x == null || isNaN(x)) ? null : Math.round(x * 1000) / 1000;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayMs = 86400000;
const dateDiff = (a, b) => Math.round((Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / dayMs);
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function writeJson(f, o, pretty) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, pretty ? 2 : 0)); }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }
function payout(pr) { return pr > 0 ? pr / 100 : 100 / -pr; }
function unitsNum(u) { return parseFloat(u) || 0; }

// ── calibration file ────────────────────────────────────────────────────────
function newCalFile() { return { format: 'nba-calibration-1', version: 0, updated: null, cal: JSON.parse(JSON.stringify(DEFAULTS)), fit: {}, limits: LIMITS }; }
function loadCal(repo) { const c = readJson(path.join(repo, 'nba_calibration.json'), null); if (!c || !c.cal) return newCalFile(); return c; }

// ── predict ─────────────────────────────────────────────────────────────────
function predict(data, calFile, now) {
  E.setCalibration(calFile.cal);
  const res = E.evaluateSlate(data), recs = [], calv = calFile.version || 0, nowMs = now.getTime();
  res.games.forEach(c => {
    const g = c.game, p = c.proj; if (g.time && Date.parse(g.time) < nowMs) return;   // already tipped: no hindsight
    recs.push({ t: 'game', id: 'g|' + g.date + '|' + g.home + '|' + g.away, date: g.date, gameId: g.id, home: g.home, away: g.away, start: g.time || null, calv,
      rawMargin: r3(p.rawMargin), margin: r3(p.margin), rawTotal: r3(p.rawTotal), total: r3(p.total), pHomeRaw: r3(p.pHomeRaw), pHome: r3(p.pHome), poss: r3(p.poss),
      mktSpread: p.spread ? p.spread.line : null, mktTotal: p.totalMkt ? p.totalMkt.line : null,
      spread: p.spread ? { pickHome: p.spread.pickHome, pCover: r3(p.spread.pCover) } : null, totalPick: p.totalMkt ? { over: p.totalMkt.pickOver, pHit: r3(p.totalMkt.pHit) } : null });
  });
  const gmap = {}; res.games.forEach(c => { gmap[c.game.id] = c.game; });
  const best = {}, all = {};
  res.props.forEach(x => { const k = x.player + '|' + x.stat; (all[k] = all[k] || []).push(x); if (x.tier !== 'SKIP' && (!best[k] || x.edge > best[k].edge)) best[k] = x; });
  const mk = (x, pick) => { const g = gmap[x.gameId] || {}, over = x.side === 'OVER';
    return { t: 'prop', id: 'p|' + (g.date || '') + '|' + x.player + '|' + x.stat + '|' + x.side + x.line + '|' + x.book, date: g.date, gameId: x.gameId, start: g.time || null, player: x.player, team: x.team, opp: x.opp, stat: x.stat,
      book: x.book, line: x.line, side: x.side, price: x.price, tier: x.tier, units: x.units, pick, calv, prob: r3(x.prob), pOverRaw: r3(over ? x.probRaw : 1 - x.probRaw), fairOver: r3(over ? x.fair : 1 - x.fair),
      proj: r3(x.proj), projRaw: r3(x.projRaw), mktMean: r3(x.mktMean), sd: r3(x.sd), minutes: x.minutes != null ? r3(x.minutes) : null, edge: r3(x.edge), flag: x.flag || null }; };
  Object.keys(best).forEach(k => { const x = best[k], g = gmap[x.gameId] || {}; if (g.time && Date.parse(g.time) < nowMs) return; recs.push(mk(x, true)); });
  let samples = 0;
  Object.keys(all).sort().forEach(k => {
    if (best[k] || samples >= SAMPLE_CAP) return; const x = all[k][0], g = gmap[x.gameId] || {};
    if ((g.time && Date.parse(g.time) < nowMs) || x.mktMean == null) return;
    if (hash((g.date || '') + '|' + k) % 100 < SAMPLE_PCT) { recs.push(mk(x, false)); samples++; }
  });
  return recs;
}

// ── grade ───────────────────────────────────────────────────────────────────
function indexForGrading(data) {
  const players = {}; (data.players || []).forEach(p => { players[p.name] = p; });
  return { players, ts: data.team_stats || {} };
}
function teamResult(ix, home, away, date) {
  const rs = ((ix.ts[home] || {}).results || []).filter(r => r.home && r.opp === away && Math.abs(dateDiff(r.date, date)) <= 1);
  return rs.length ? rs[rs.length - 1] : null;
}
function closeEntry(state, home, away, start) {
  const list = (state.closeGames || []).filter(e => e.home === home && e.away === away && (!start || !e.start || Math.abs(Date.parse(e.start) - Date.parse(start)) < 36 * 3600000));
  return list.length ? list[list.length - 1] : null;
}
function closeProp(state, rec) {
  const ev = (state.closeProps || []).filter(e => (e.home === rec.team || e.away === rec.team) && (!rec.start || !e.start || Math.abs(Date.parse(e.start) - Date.parse(rec.start)) < 36 * 3600000))[0];
  if (!ev) return null; const rows = ev.rows.filter(r => r.player === rec.player && r.market === rec.stat);
  return rows.filter(r => r.book === rec.book)[0] || null;
}
function gradeOne(rec, ix, state, nowMs) {
  if (rec.t === 'game') {
    const tr = teamResult(ix, rec.home, rec.away, rec.date);
    if (!tr) return Date.parse(rec.date) < nowMs - PENDING_MAX_DAYS * dayMs ? 'drop' : null;
    const am = tr.pf - tr.pa, at = tr.pf + tr.pa, out = Object.assign({}, rec, { actualMargin: am, actualTotal: at });
    if (rec.spread && rec.mktSpread != null) { const cover = am + rec.mktSpread; out.spreadResult = cover === 0 ? 'PUSH' : ((cover > 0) === rec.spread.pickHome ? 'WIN' : 'LOSS'); }
    if (rec.totalPick && rec.mktTotal != null) out.totalResult = at === rec.mktTotal ? 'PUSH' : ((at > rec.mktTotal) === rec.totalPick.over ? 'WIN' : 'LOSS');
    const ce = closeEntry(state, rec.home, rec.away, rec.start); if (ce && ce.close) { out.closeSpread = ce.close.spread != null ? ce.close.spread : null; out.closeTotal = ce.close.total != null ? ce.close.total : null; }
    return out;
  }
  const p = ix.players[rec.player], tr = teamResult(ix, rec.team, rec.opp, rec.date) || teamResult(ix, rec.opp, rec.team, rec.date);
  const row = p && (p.log || []).filter(r => r[10] === rec.opp && Math.abs(dateDiff(r[0], rec.date)) <= 1)[0];
  if (!row) { if (tr) return Object.assign({}, rec, { result: 'VOID' }); return Date.parse(rec.date) < nowMs - PENDING_MAX_DAYS * dayMs ? 'drop' : null; }
  if (row[1] < 1) return Object.assign({}, rec, { result: 'VOID' });
  const act = E.rowStat(row, rec.stat), out = Object.assign({}, rec, { actual: act });
  out.result = act === rec.line ? 'PUSH' : ((act > rec.line) === (rec.side === 'OVER') ? 'WIN' : 'LOSS');
  const cp = closeProp(state, rec); if (cp) { out.closeLine = cp.line; out.closeOver = cp.over; out.closeUnder = cp.under; }
  return out;
}
function grade(data, pending, state, now) {
  const ix = indexForGrading(data), graded = [], keep = [];
  pending.forEach(rec => { const g = gradeOne(rec, ix, state, now.getTime()); if (g === 'drop') return; if (g) graded.push(g); else keep.push(rec); });
  return { graded, keep };
}

// ── results store ───────────────────────────────────────────────────────────
function resultFiles(repo) { const d = path.join(repo, 'results'); try { return fs.readdirSync(d).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort(); } catch (e) { return []; } }
function loadResults(repo) { let all = []; resultFiles(repo).forEach(f => { all = all.concat((readJson(path.join(repo, 'results', f), { records: [] }).records) || []); }); return all; }
function appendResults(repo, recs) {
  const by = {}; recs.forEach(r => { const m = String(r.date).slice(0, 7); (by[m] = by[m] || []).push(r); });
  Object.keys(by).forEach(m => { const f = path.join(repo, 'results', m + '.json'), cur = readJson(f, { records: [] }), have = {}; cur.records.forEach(r => { have[r.id] = 1; });
    by[m].forEach(r => { if (!have[r.id]) cur.records.push(r); }); cur.records.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0); writeJson(f, cur); });
}

// ── refit ───────────────────────────────────────────────────────────────────
/* regression through the origin: y ~ b*x. Returns {b, se, n}. */
function origin(pairs) {
  let sxx = 0, sxy = 0; pairs.forEach(p => { sxx += p.x * p.x; sxy += p.x * p.y; }); if (pairs.length < 3 || sxx < 1e-9) return null;
  const b = sxy / sxx; let ss = 0; pairs.forEach(p => { ss += Math.pow(p.y - b * p.x, 2); });
  return { b, se: Math.sqrt(ss / Math.max(pairs.length - 1, 1) / sxx), n: pairs.length };
}
/* precision-weighted blend of the data estimate and the factory prior: noisy data barely moves the setting */
function posterior(est, se, prior, tau) { const wd = 1 / (se * se), wp = 1 / (tau * tau); return (est * wd + prior * wp) / (wd + wp); }
function logisticFit(pts) { // y ~ sigmoid(A*z + B)
  let A = 1, B = 0, hs = null;
  for (let it = 0; it < 30; it++) { let gA = 0, gB = 0, hAA = 0, hAB = 0, hBB = 0;
    pts.forEach(q => { const p = 1 / (1 + Math.exp(-(A * q.z + B))), w = p * (1 - p), e = q.y - p; gA += e * q.z; gB += e; hAA += w * q.z * q.z; hAB += w * q.z; hBB += w; });
    const det = hAA * hBB - hAB * hAB; if (Math.abs(det) < 1e-9) return null; A += (hBB * gA - hAB * gB) / det; B += (hAA * gB - hAB * gA) / det; hs = { hAA, hAB, hBB, det }; }
  if (!hs) return null; return { A, B, seA: Math.sqrt(hs.hBB / hs.det), seB: Math.sqrt(hs.hAA / hs.det) };
}
function logit(p) { p = clamp(p, 1e-4, 1 - 1e-4); return Math.log(p / (1 - p)); }

function refit(records, calFile, now) {
  const cal = JSON.parse(JSON.stringify(calFile.cal)), changes = [], notes = [], nUsed = {};
  const recent = t => records.filter(r => r.t === t).slice(-WINDOW);
  const days = {}; records.forEach(r => { if (r.result || r.actualMargin != null) days[r.date] = 1; }); const nDays = Object.keys(days).length;
  if (nDays < MIN_DAYS) return { cal, changes: [], notes: ['Only ' + nDays + ' graded day(s); ' + MIN_DAYS + ' needed before any automatic change (one night of games is too correlated to learn from)'], n: {}, changed: false, days: nDays };
  const games = recent('game').filter(r => r.actualMargin != null), props = recent('prop').filter(r => r.result && r.result !== 'VOID');
  const move = (key, sub, cur, target, n, extra) => { // apply guardrails then record the change
    const L = LIMITS[sub || key], to = Math.round(clamp(clamp(target, cur - L.step, cur + L.step), L.min, L.max) * 1000) / 1000;
    if (Math.abs(to - cur) >= 0.0005) changes.push(Object.assign({ key: sub ? key + '.' + sub : key, from: cur, to, target: Math.round(target * 1000) / 1000, n }, extra || {}));
    return to;
  };
  const gate = (n, L, label) => { if (n < L.minN) { notes.push(label + ': ' + n + ' of ' + L.minN + ' samples needed, unchanged'); return false; } return true; };

  // 1) blend weights: market share W minimises (actual - (market + (1-W)(model-market)))^2
  const fitW = (pairs, key, label) => { nUsed[key] = pairs.length; if (!gate(pairs.length, LIMITS[key], label)) return;
    const o = origin(pairs); if (!o) return; const What = 1 - o.b, p = posterior(What, o.se, DEFAULTS[key], LIMITS[key].tau);
    cal[key] = move(key, null, cal[key], p, pairs.length, { est: Math.round(What * 1000) / 1000, se: Math.round(o.se * 1000) / 1000 }); };
  fitW(games.filter(g => g.mktSpread != null).map(g => ({ x: g.rawMargin + g.mktSpread, y: g.actualMargin + g.mktSpread })), 'W_MARKET_SPREAD', 'Market weight (spread)');
  fitW(games.filter(g => g.mktTotal != null).map(g => ({ x: g.rawTotal - g.mktTotal, y: g.actualTotal - g.mktTotal })), 'W_MARKET_TOTAL', 'Market weight (total)');
  fitW(props.filter(p => p.mktMean != null && p.projRaw != null && p.actual != null).map(p => ({ x: p.projRaw - p.mktMean, y: p.actual - p.mktMean })), 'PROP_W_MARKET', 'Market weight (props)');

  // 2) prop shrink per stat: (outcome - fair) ~ s * (rawProb - fair)
  STATS.forEach(st => {
    const rows = props.filter(p => p.stat === st && p.result !== 'PUSH' && p.pOverRaw != null && p.fairOver != null); nUsed['SHRINK.' + st] = rows.length;
    if (!gate(rows.length, LIMITS.SHRINK, 'Prop shrink ' + st)) return;
    const o = origin(rows.map(p => ({ x: p.pOverRaw - p.fairOver, y: ((p.result === 'WIN') === (p.side === 'OVER') ? 1 : 0) - p.fairOver })));
    if (!o) return; const pst = posterior(o.b, o.se, DEFAULTS.SHRINK[st], LIMITS.SHRINK.tau);
    cal.SHRINK[st] = move('SHRINK', null, cal.SHRINK[st], pst, rows.length, { key: 'SHRINK.' + st, est: Math.round(o.b * 1000) / 1000, se: Math.round(o.se * 1000) / 1000 });
  });

  // 3) win-probability Platt on the raw scenario-mixture probability
  const wp = games.filter(g => g.actualMargin !== 0 && g.pHomeRaw != null).map(g => ({ z: logit(g.pHomeRaw), y: g.actualMargin > 0 ? 1 : 0 })); nUsed.PLATT = wp.length;
  if (gate(wp.length, LIMITS.PLATT_A, 'Win-probability calibration')) { const f = logisticFit(wp);
    if (f) { cal.PLATT_A = move('PLATT_A', null, cal.PLATT_A, posterior(f.A, f.seA, DEFAULTS.PLATT_A, LIMITS.PLATT_A.tau), wp.length, { est: Math.round(f.A * 1000) / 1000, se: Math.round(f.seA * 1000) / 1000 });
             cal.PLATT_B = move('PLATT_B', null, cal.PLATT_B, posterior(f.B, f.seB, DEFAULTS.PLATT_B, LIMITS.PLATT_B.tau), wp.length, { est: Math.round(f.B * 1000) / 1000, se: Math.round(f.seB * 1000) / 1000 }); } }

  // 4) scoring spreads: RMS residual of the published (blended) number, scaled back to a 100-possession game
  const lg = E.CONFIG.LEAGUE.pace, scaleOf = g => Math.sqrt((g.poss || lg) / lg);
  const sdFit = (key, rows, label) => { nUsed[key] = rows.length; if (!gate(rows.length, LIMITS[key], label)) return; const sd = Math.sqrt(mean(rows.map(x => x * x)));
    cal[key] = move(key, null, cal[key], posterior(sd, sd / Math.sqrt(2 * rows.length), DEFAULTS[key], LIMITS[key].tau), rows.length, { est: Math.round(sd * 100) / 100 }); };
  sdFit('MARGIN_SD', games.map(g => (g.actualMargin - g.margin) / scaleOf(g)), 'Margin spread');
  sdFit('TOTAL_SD', games.map(g => (g.actualTotal - g.total) / scaleOf(g)), 'Total spread');

  const changed = changes.length > 0;
  return { cal, changes, notes, n: nUsed, changed };
}

// ── summary ─────────────────────────────────────────────────────────────────
function newBucket() { return { w: 0, l: 0, p: 0, u: 0, n: 0 }; }
function addTo(b, rec) {
  if (rec.result === 'VOID' || !rec.result) return; b.n++;
  if (rec.result === 'WIN') { b.w++; b.u += unitsNum(rec.units) * payout(rec.price); } else if (rec.result === 'LOSS') { b.l++; b.u -= unitsNum(rec.units); } else b.p++;
}
function clvOf(rec) { // points/units the market moved toward our side by close (positive = we beat the close)
  if (rec.t === 'prop' && rec.closeLine != null) return rec.side === 'OVER' ? rec.closeLine - rec.line : rec.line - rec.closeLine;
  return null;
}
function summarize(records, calFile, calLog, now) {
  const props = records.filter(r => r.t === 'prop'), games = records.filter(r => r.t === 'game');
  const picks = props.filter(r => r.pick && r.result && r.result !== 'VOID'), S = { generated: now.toISOString(), format: 'nba-summary-1', model: VERSION };
  S.counts = { propsGraded: props.filter(r => r.result && r.result !== 'VOID').length, picksGraded: picks.length, gamesGraded: games.filter(g => g.actualMargin != null).length };
  S.through = records.length ? records.map(r => r.date).sort().pop() : null; S.since = records.length ? records.map(r => r.date).sort()[0] : null;
  const group = (rows, keyFn) => { const m = {}; rows.forEach(r => { const k = keyFn(r); if (k == null) return; addTo(m[k] = m[k] || newBucket(), r); }); return m; };
  const tot = newBucket(); picks.forEach(r => addTo(tot, r));
  const band = e => e < 5 ? '<5' : e < 8 ? '5-8' : e < 12 ? '8-12' : e < 18 ? '12-18' : '18+';
  S.record = { overall: tot, byTier: group(picks, r => r.tier), byStat: group(picks, r => r.stat), bySide: group(picks, r => r.side), byEdge: group(picks, r => band(r.edge || 0)), byBook: group(picks, r => r.book) };
  const last30 = picks.filter(r => dateDiff(now.toISOString(), r.date) <= 30), l30 = newBucket(); last30.forEach(r => addTo(l30, r)); S.record.last30 = l30;
  const gb = { ats: newBucket(), ou: newBucket() }; games.forEach(g => { [['spreadResult', 'ats'], ['totalResult', 'ou']].forEach(([k, b]) => { if (g[k] === 'WIN') gb[b].w++; else if (g[k] === 'LOSS') gb[b].l++; else if (g[k] === 'PUSH') gb[b].p++; }); });
  S.record.games = gb;
  const daily = {}; picks.forEach(r => addTo(daily[r.date] = daily[r.date] || newBucket(), r)); S.daily = Object.keys(daily).sort().slice(-60).map(d => Object.assign({ date: d }, daily[d]));
  // reliability of the stated win probability
  const bins = []; for (let lo = 0.45; lo < 0.9; lo += 0.05) bins.push({ lo, hi: lo + 0.05, n: 0, pred: 0, hit: 0 });
  picks.filter(r => r.result !== 'PUSH' && r.prob != null).forEach(r => { const b = bins.filter(x => r.prob >= x.lo && r.prob < x.hi)[0]; if (b) { b.n++; b.pred += r.prob; b.hit += r.result === 'WIN' ? 1 : 0; } });
  S.reliability = bins.filter(b => b.n > 0).map(b => ({ range: Math.round(b.lo * 100) + '-' + Math.round(b.hi * 100) + '%', n: b.n, predicted: r3(b.pred / b.n), actual: r3(b.hit / b.n) }));
  // game accuracy
  const gg = games.filter(g => g.actualMargin != null);
  S.gameModel = { n: gg.length, maeMargin: gg.length ? r3(mean(gg.map(g => Math.abs(g.actualMargin - g.margin)))) : null, maeMarginRaw: gg.length ? r3(mean(gg.map(g => Math.abs(g.actualMargin - g.rawMargin)))) : null,
    maeTotal: gg.length ? r3(mean(gg.map(g => Math.abs(g.actualTotal - g.total)))) : null, maeTotalRaw: gg.length ? r3(mean(gg.map(g => Math.abs(g.actualTotal - g.rawTotal)))) : null,
    mktMaeMargin: r3(mean(gg.filter(g => g.mktSpread != null).map(g => Math.abs(g.actualMargin + g.mktSpread)))), mktMaeTotal: r3(mean(gg.filter(g => g.mktTotal != null).map(g => Math.abs(g.actualTotal - g.mktTotal)))) };
  // closing-line value
  const clvRows = picks.map(clvOf).filter(x => x != null), clvG = [];
  games.forEach(g => { if (g.closeSpread != null && g.mktSpread != null && g.spread) clvG.push(g.spread.pickHome ? g.closeSpread - g.mktSpread : g.mktSpread - g.closeSpread);
    if (g.closeTotal != null && g.mktTotal != null && g.totalPick) clvG.push(g.totalPick.over ? g.closeTotal - g.mktTotal : g.mktTotal - g.closeTotal); });
  const clvSum = a => ({ n: a.length, pctBeat: a.length ? r3(a.filter(x => x > 0).length / a.length) : null, pctSame: a.length ? r3(a.filter(x => x === 0).length / a.length) : null, avg: a.length ? r3(mean(a)) : null });
  S.clv = { props: clvSum(clvRows), games: clvSum(clvG) };
  // calibration epochs (before/after each automatic change)
  const ep = {}; picks.forEach(r => { const k = r.calv || 0; const e = ep[k] = ep[k] || { calv: k, b: newBucket(), brier: 0, clv: [] }; addTo(e.b, r); if (r.result !== 'PUSH' && r.prob != null) e.brier += Math.pow(r.prob - (r.result === 'WIN' ? 1 : 0), 2); const c = clvOf(r); if (c != null) e.clv.push(c); });
  S.epochs = Object.keys(ep).map(k => { const e = ep[k], d = e.b.w + e.b.l; return { calv: +k, since: ((calLog || []).filter(c => c.version === +k)[0] || {}).date || null, n: e.b.n, record: e.b.w + '-' + e.b.l + '-' + e.b.p, winPct: d ? r3(e.b.w / d) : null, units: r3(e.b.u), brier: d ? r3(e.brier / d) : null, avgClv: e.clv.length ? r3(mean(e.clv)) : null }; }).sort((a, b) => a.calv - b.calv);
  // plain-language flags
  const flags = [];
  S.reliability.forEach(b => { if (b.n >= 25 && Math.abs(b.predicted - b.actual) >= 0.07) flags.push('Picks the model rated ' + b.range + ' won ' + Math.round(b.actual * 100) + '% (' + b.n + ' picks): ' + (b.predicted > b.actual ? 'overconfident' : 'underconfident') + '.'); });
  Object.keys(S.record.byStat).forEach(k => { const b = S.record.byStat[k], d = b.w + b.l; if (d >= 40 && b.u / d < -0.15) flags.push(k + ' props are losing (' + b.w + '-' + b.l + ', ' + r3(b.u) + 'U over ' + d + ' picks).'); });
  if (S.clv.props.n >= 60 && S.clv.props.avg < -0.1) flags.push('Prop picks are not beating the closing line (avg ' + S.clv.props.avg + '): the model is not finding value the market has not already priced.');
  if (S.gameModel.n >= 40 && S.gameModel.mktMaeMargin != null && S.gameModel.maeMargin > S.gameModel.mktMaeMargin + 0.3) flags.push('The published margin is less accurate than the market line (' + S.gameModel.maeMargin + ' vs ' + S.gameModel.mktMaeMargin + ' pts).');
  S.flags = flags;
  S.calibration = { version: calFile.version, updated: calFile.updated, current: calFile.cal, defaults: DEFAULTS, fit: calFile.fit || {} };
  S.changeLog = (calLog || []).slice(-30);
  return S;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i]; else o._.push(argv[i]); } return o; }
function loadState(dir) { return { pending: readJson(path.join(dir, 'pending.json'), { records: [] }).records, closeGames: readJson(path.join(dir, 'close_games.json'), []), closeProps: readJson(path.join(dir, 'close_props.json'), []) }; }

function cmdGrade(o) {
  const data = readJson(o.data, null); if (!data) throw new Error('No data file ' + o.data);
  const st = loadState(o.state), r = grade(data, st.pending, st, o.now);
  appendResults(o.repo, r.graded); writeJson(path.join(o.state, 'pending.json'), { records: r.keep });
  console.log('graded ' + r.graded.length + ' (props ' + r.graded.filter(x => x.t === 'prop').length + ', games ' + r.graded.filter(x => x.t === 'game').length + '), still pending ' + r.keep.length);
  return r;
}
function cmdRefit(o) {
  const calFile = loadCal(o.repo), recs = loadResults(o.repo), out = refit(recs, calFile, o.now), logF = path.join(o.repo, 'nba_calibration_log.json'), log = readJson(logF, []);
  const nf = Object.assign({}, calFile, { cal: out.cal, fit: { updated: o.now.toISOString(), n: out.n, notes: out.notes }, limits: LIMITS, format: 'nba-calibration-1' });
  if (out.changed) { nf.version = (calFile.version || 0) + 1; nf.updated = o.now.toISOString(); log.push({ version: nf.version, date: o.now.toISOString().slice(0, 10), changes: out.changes, n: out.n }); writeJson(logF, log, true); }
  writeJson(path.join(o.repo, 'nba_calibration.json'), nf, true);
  console.log(out.changed ? 'calibration v' + nf.version + ': ' + out.changes.map(c => c.key + ' ' + c.from + '->' + c.to).join(', ') : 'calibration unchanged' + (out.notes.length ? ' (' + out.notes.length + ' gated)' : ''));
  return out;
}
function cmdSummary(o) {
  const calFile = loadCal(o.repo), log = readJson(path.join(o.repo, 'nba_calibration_log.json'), []), S = summarize(loadResults(o.repo), calFile, log, o.now);
  S.files = resultFiles(o.repo); writeJson(path.join(o.repo, 'nba_summary.json'), S, true); console.log('summary: ' + S.counts.picksGraded + ' graded picks, ' + S.counts.gamesGraded + ' games'); return S;
}
function cmdPredict(o) {
  const data = readJson(o.data, null); if (!data) throw new Error('No data file ' + o.data);
  const calFile = loadCal(o.repo), recs = predict(data, calFile, o.now), st = loadState(o.state), have = {}; st.pending.forEach(r => { have[r.id] = 1; });
  const add = recs.filter(r => !have[r.id]); writeJson(path.join(o.state, 'pending.json'), { records: st.pending.concat(add) });
  console.log('predicted ' + add.length + ' new records (' + add.filter(r => r.t === 'game').length + ' games, ' + add.filter(r => r.pick).length + ' picks, ' + add.filter(r => r.t === 'prop' && !r.pick).length + ' fit samples) for calibration v' + (calFile.version || 0));
}
function main() {
  const a = args(process.argv.slice(2)), cmd = a._[0];
  const o = { repo: a.repo || '.', state: a.state || path.join(a.repo || '.', 'state'), now: a.now ? new Date(a.now) : new Date() }; o.data = a.data || path.join(o.repo, 'nba_model_data.json');
  if (cmd === 'predict') cmdPredict(o); else if (cmd === 'grade') cmdGrade(o); else if (cmd === 'refit') cmdRefit(o); else if (cmd === 'summary') cmdSummary(o);
  else if (cmd === 'daily') { cmdGrade(o); cmdRefit(o); cmdSummary(o); cmdPredict(o); }
  else { console.log('usage: node nba_auto.js predict|grade|refit|summary|daily [--repo DIR] [--state DIR] [--data FILE] [--now ISO]'); process.exit(cmd ? 1 : 0); }
}
if (require.main === module) { try { main(); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); } }
module.exports = { predict, grade, refit, summarize, origin, posterior, logisticFit, newCalFile, LIMITS, DEFAULTS, appendResults, loadResults, clvOf, VERSION };
