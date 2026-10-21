/* NBA Edge Model v1.2 - projection engine (pure functions, no DOM).
 * Input: window.NBA_DATA produced by nba_edge_data_pull.py. Every constant lives in CONFIG so tuning is visible.
 * Missing inputs fall back to league averages / the simpler v1 path instead of throwing.
 * v1.2 adds: market blend, probability shrink + Platt hook, minutes model, availability scenarios, preseason roster prior,
 * 3-signal total ensemble, fuller rest/travel, opponent-adjusted form, DvP, empirical + NB/Poisson/normal distributions,
 * trend-agreement check, heteroscedastic SDs. Calibration constants are DEFAULTS until the Backtest tab fits them.        */
(function (root) {
  'use strict';

  var CONFIG = {
    LEAGUE: { fg3pct: 0.365, pace: 99.5, ortg: 114.5, drtg: 114.5, ppg: 114.5, fp36: 33, repl_fp36: 27 },
    HCA: 2.4,
    REST: { B2B: 2.0, IN4: 1.0, DAY: 0.35, DAY_CAP: 2, TRAVEL: 0.30, TRAVEL_FREE: 1200 }, // pts; travel = pts per 1000 mi beyond TRAVEL_FREE
    FORM_W: 0.15,             // v1 fallback: weight on (last-5 ppg - season ppg)
    FORM_STRENGTH_W: 0.35,    // weight on (EW strength - season strength) when adjusted strength is available
    MARGIN_COMPRESS: 0.92,
    MARGIN_SD: 12.0, TOTAL_SD: 18.0,
    OFF_W: 0.40, DEF_W: 0.60,
    ROSTER: { K: 2.0, W_MAX: 0.5, HALF_GAMES: 15 },      // preseason prior: pull toward roster-value implied net rating, fades with games
    TOTAL_ENS: { poss: 0.45, eppg: 0.35, l5: 0.20 },
    AVAIL: { IMPACT_C: 0.35, OFF_SHARE: 0.60, CAP: 9, MIN_MPG: 15, P_OUT: { out: 1.0, doubtful: 0.85, questionable: 0.45, 'day-to-day': 0.25, probable: 0.08 }, SURE_AT: 0.85, MAX_UNCERTAIN: 2 },
    INJ_STATUS_W: { out: 1.0, doubtful: 0.9, questionable: 0.5, 'day-to-day': 0.3, probable: 0.1 }, // legacy injuryPoints()
    INJ_PTS_LOST: 0.55, INJ_MIN_MPG: 15,
    CAL: {
      W_MARKET_SPREAD: 0.85, W_MARKET_TOTAL: 0.90,       // share of the final number taken from the market when a line exists
      PLATT_A: 1.0, PLATT_B: 0.0,                         // win-prob logistic recalibration (identity until fitted)
      PROP_W_MARKET: 0.35,                                // share of the market's implied mean blended into a prop projection
      F: { FG3_K: 300, FG3_RECENT: 1.0, TANK: 0.08, MOVE_W: 0 }, // extra factors: 3P% regression (attempts-equivalent of league average), share of recent-form weight kept for threes, late-season bench lift on non-contenders, line-movement weight (0 until a fit says otherwise)
      W_PROP: { pts: 0.88, reb: 0.75, ast: 0.80, pra: 0.92, fg3m: 0.50, stl: 0.55, blk: 0.45 }, // per-stat share of the market's mean blended into a projection (overrides PROP_W_MARKET)
      OVER_B: 0.0,                                        // logit shift applied to the OVER probability (negative = fewer/lower-rated overs)
      MIN_EV: 0.02,                                       // a prop pick must clear this expected value (per 1U, after the real price) or it is SKIP
      SHRINK: { pts: 0.45, reb: 0.45, ast: 0.45, pra: 0.45, fg3m: 0.42, stl: 0.36, blk: 0.36 } // prob shrink toward fair price (v1.5: fitted on the 2025-26 backtest)
    },
    PROP: {
      RECENT_W: 0.30, MIN_GAMES: 8, MIN_MPG: 15, PACE_EXP: 0.80,
      DEF_EXP: { pts: 0.60, reb: 0.15, ast: 0.35, fg3m: 0.40, stl: 0.0, blk: 0.0, pra: 0.45 },
      DVP_W: 0.65,                                        // exponent on the position multiplier when DvP is available
      B2B_MULT: 0.97,
      BLOWOUT_START: 10, BLOWOUT_SLOPE: 0.012, BLOWOUT_FLOOR: 0.90, BLOWOUT_MIN_MPG: 28,
      USAGE_ABSORB: { pts: 0.35, ast: 0.30, reb: 0.20, fg3m: 0.30, stl: 0.0, blk: 0.0 },
      MIN: { L5_W: 0.40, B2B_STARTER: 1.2, STARTER_MPG: 28, BLOW_RATE: 0.35, BLOW_MAX: 6, BENCH_GAIN: 0.5, ABSORB_CAP: 4, FLOOR: 8, CEIL: 42 },
      LOG_MIN: 5,                                         // rows needed before the minutes/empirical path is used
      EMP_W: 0.5,                                         // weight of empirical (vs parametric) probability
      DIST: { pts: 'normal', reb: 'nb', ast: 'nb', pra: 'normal', fg3m: 'nb', stl: 'poisson', blk: 'poisson' },
      TREND_MARGIN: 0.0
    },
    TIERS: [
      { name: 'ELITE', min: 12, units: '3U' }, { name: 'STRONG', min: 8, units: '2U' },
      { name: 'MED', min: 5, units: '1U' }, { name: 'LEAN', min: 2.5, units: '0.5U' }
    ]
  };

  // ── math helpers ──────────────────────────────────────────────────────────
  function erf(x) {
    var s = x < 0 ? -1 : 1; x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function phi(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  function poissonCdf(k, lambda) {
    if (k < 0) return 0; var sum = 0, term = Math.exp(-lambda);
    for (var i = 0; i <= k; i++) { sum += term; term *= lambda / (i + 1); }
    return Math.min(1, sum);
  }
  function nbCdf(k, mean, variance) { // P(X <= k); falls back to Poisson when not over-dispersed
    if (k < 0) return 0; mean = Math.max(mean, 0.05);
    if (!(variance > mean * 1.02)) return poissonCdf(k, mean);
    var r = mean * mean / (variance - mean), p = r / (r + mean), pmf = Math.pow(p, r), sum = pmf;
    for (var i = 0; i < k; i++) { pmf *= (i + r) / (i + 1) * (1 - p); sum += pmf; }
    return Math.min(1, sum);
  }
  function logit(p) { p = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(p / (1 - p)); }
  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
  function n(x, d) { return (x === null || x === undefined || isNaN(x)) ? d : +x; }
  function impliedProb(american) {
    if (american === null || american === undefined || isNaN(american) || Math.abs(american) < 100) return null;
    return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
  }
  function payout(american) { return american > 0 ? american / 100 : 100 / -american; }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function sdOf(a) { if (a.length < 3) return null; var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1)); }
  function median(a) { if (!a.length) return null; a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; }

  // calibration hook: Backtest tab fits these and calls setCalibration
  function setCalibration(cal) {
    if (!cal) return;
    var C = CONFIG.CAL;
    ['W_MARKET_SPREAD', 'W_MARKET_TOTAL', 'PLATT_A', 'PLATT_B', 'PROP_W_MARKET', 'OVER_B', 'MIN_EV'].forEach(function (k) { if (cal[k] != null && !isNaN(cal[k])) C[k] = +cal[k]; });
    if (cal.F) { C.F = C.F || {}; Object.keys(cal.F).forEach(function (k) { if (!isNaN(cal.F[k])) C.F[k] = +cal.F[k]; }); }
    if (cal.W_PROP) { C.W_PROP = {}; Object.keys(cal.W_PROP).forEach(function (k) { if (!isNaN(cal.W_PROP[k])) C.W_PROP[k] = +cal.W_PROP[k]; }); }
    if (cal.SHRINK) Object.keys(cal.SHRINK).forEach(function (k) { if (!isNaN(cal.SHRINK[k])) C.SHRINK[k] = +cal.SHRINK[k]; });
    if (cal.MARGIN_SD && !isNaN(cal.MARGIN_SD)) CONFIG.MARGIN_SD = +cal.MARGIN_SD;
    if (cal.TOTAL_SD && !isNaN(cal.TOTAL_SD)) CONFIG.TOTAL_SD = +cal.TOTAL_SD;
  }
  function getCalibration() { var C = CONFIG.CAL; return JSON.parse(JSON.stringify({ W_MARKET_SPREAD: C.W_MARKET_SPREAD, W_MARKET_TOTAL: C.W_MARKET_TOTAL, PLATT_A: C.PLATT_A, PLATT_B: C.PLATT_B, PROP_W_MARKET: C.PROP_W_MARKET, OVER_B: C.OVER_B, MIN_EV: C.MIN_EV, W_PROP: C.W_PROP, F: C.F, SHRINK: C.SHRINK, MARGIN_SD: CONFIG.MARGIN_SD, TOTAL_SD: CONFIG.TOTAL_SD })); }
  function platt(p) { var C = CONFIG.CAL; return (C.PLATT_A === 1 && C.PLATT_B === 0) ? p : sigmoid(C.PLATT_A * logit(p) + C.PLATT_B); }

  // ── team view ─────────────────────────────────────────────────────────────
  function teamView(m) {
    m = m || {}; var L = CONFIG.LEAGUE;
    return {
      pace: n(m.pace, L.pace), ortg: n(m.ortg, L.ortg), drtg: n(m.drtg, L.drtg), ppg: n(m.ppg, L.ppg),
      l5ppg: n(m.l5ppg, null), gp: n(m.gp, 0), hasData: m.ortg != null && m.drtg != null,
      sSeason: n(m.strength_season, null), sForm: n(m.strength_form, null), rv: n(m.roster_value, null)
    };
  }

  // ── availability ──────────────────────────────────────────────────────────
  function fp36(s) {
    var m = n(s && s.min, 0); if (m <= 0) return null;
    return (n(s.pts, 0) + 1.2 * n(s.reb, 0) + 1.5 * n(s.ast, 0) + 3 * n(s.stl, 0) + 3 * n(s.blk, 0) - n(s.to, 0)) / m * 36;
  }
  function playerImpact(p) { // points of margin the team loses when this player sits (over a replacement-level player)
    var A = CONFIG.AVAIL, L = CONFIG.LEAGUE, s = p.stats || {}, f = fp36(s);
    if (f == null || n(s.min, 0) < A.MIN_MPG) return 0;
    return Math.min(A.CAP, Math.max(0, A.IMPACT_C * (f - L.repl_fp36) * n(s.min, 0) / 36));
  }
  function pOutFor(status) {
    var st = String(status || '').toLowerCase(), best = 0, P = CONFIG.AVAIL.P_OUT;
    Object.keys(P).forEach(function (k) { if (st.indexOf(k) >= 0) best = Math.max(best, P[k]); });
    return best;
  }
  /* injuryReport -> { lost (expected impact pts), sure (impact of near-certain absences), unc:[{name,pOut,impact}], list:[...] }
   * The two most impactful *uncertain* players become scenario branches; smaller ones are folded in as expected values.   */
  function injuryReport(team, players, injuries) {
    var A = CONFIG.AVAIL, by = {}; (injuries || []).forEach(function (i) { if (i.name) by[i.name.toLowerCase()] = i; });
    var list = [];
    (players || []).forEach(function (p) {
      if (p.team !== team || !p.stats) return;
      var inj = by[(p.name || '').toLowerCase()]; if (!inj) return;
      var po = pOutFor(inj.status), imp = playerImpact(p);
      if (!po || n(p.stats.min, 0) < A.MIN_MPG) return;
      list.push({ name: p.name, status: inj.status, weight: po, impact: imp, pts: imp * po, stats: p.stats, pOut: po });
    });
    var sure = 0, unc = [], exp = 0, lost = 0;
    var uncertain = list.filter(function (x) { return x.pOut < A.SURE_AT; }).sort(function (a, b) { return b.impact * Math.min(b.pOut, 1 - b.pOut + 0.01) - a.impact * Math.min(a.pOut, 1 - a.pOut + 0.01); });
    list.forEach(function (x) { if (x.pOut >= A.SURE_AT) sure += x.impact * x.pOut; });
    uncertain.forEach(function (x, i) { if (i < A.MAX_UNCERTAIN) unc.push({ name: x.name, pOut: x.pOut, impact: x.impact }); else exp += x.impact * x.pOut; });
    lost = sure + exp; unc.forEach(function (u) { lost += u.impact * u.pOut; });
    return { lost: lost, sure: sure + exp, unc: unc, list: list };
  }
  // legacy v1 helper kept so older callers/tests keep working (expected scoring lost)
  function injuryPoints(team, players, injuries) {
    var by = {}; (injuries || []).forEach(function (i) { if (i.name) by[i.name.toLowerCase()] = i; });
    var lost = 0, list = [];
    (players || []).forEach(function (p) {
      if (p.team !== team || !p.stats) return;
      var inj = by[(p.name || '').toLowerCase()]; if (!inj) return;
      var st = String(inj.status || '').toLowerCase(), w = 0;
      Object.keys(CONFIG.INJ_STATUS_W).forEach(function (k) { if (st.indexOf(k) >= 0) w = Math.max(w, CONFIG.INJ_STATUS_W[k]); });
      if (!w || n(p.stats.min, 0) < CONFIG.INJ_MIN_MPG) return;
      var pts = n(p.stats.pts, 0) * CONFIG.INJ_PTS_LOST * w; lost += pts; list.push({ name: p.name, status: inj.status, weight: w, pts: pts });
    });
    return { lost: lost, list: list };
  }
  function scenarios(rep) { // enumerate absent/present combos of uncertain players -> [{p, impact}]
    var out = [{ p: 1, impact: rep ? rep.sure : 0 }];
    ((rep && rep.unc) || []).forEach(function (u) {
      var next = [];
      out.forEach(function (s) {
        next.push({ p: s.p * u.pOut, impact: s.impact + u.impact });
        next.push({ p: s.p * (1 - u.pOut), impact: s.impact });
      });
      out = next;
    });
    return out;
  }

  // ── game projection ───────────────────────────────────────────────────────
  function restPts(prefix, ctx) { // points a team loses to schedule fatigue (positive = worse)
    var R = CONFIG.REST, pts = 0, parts = {};
    if (ctx[prefix + 'B2B']) { pts += R.B2B; parts.b2b = R.B2B; }
    else if (ctx[prefix + 'Rest'] != null) { var d = Math.min(R.DAY_CAP, Math.max(0, n(ctx[prefix + 'Rest'], 1) - 1)); pts -= R.DAY * d; if (d) parts.rest = -R.DAY * d; }
    if (ctx[prefix + 'In4']) { pts += R.IN4; parts.in4 = R.IN4; }
    var tr = n(ctx[prefix + 'Travel'], 0);
    if (tr > R.TRAVEL_FREE) { var tp = (tr - R.TRAVEL_FREE) / 1000 * R.TRAVEL; pts += tp; parts.travel = tp; }
    return { pts: pts, parts: parts };
  }

  /* projectGame(homeMetrics, awayMetrics, ctx)
   * ctx: homeB2B/awayB2B, homeRest/awayRest, homeIn4/awayIn4, homeTravel/awayTravel,
   *      homeInjPts/awayInjPts (sure loss), homeInj/awayInj (injuryReport results -> scenario mixing),
   *      leagueRV, spread (HOME line, -5.5 = home favoured), total                                      */
  function projectGame(hm, am, ctx) {
    ctx = ctx || {}; var C = CONFIG, H = teamView(hm), A = teamView(am), parts = {};
    // preseason / early-season roster prior: pull net rating toward roster-implied level, fading with games played
    function prior(T, who) {
      if (T.rv == null || ctx.leagueRV == null) return 0;
      var w = C.ROSTER.W_MAX * C.ROSTER.HALF_GAMES / (C.ROSTER.HALF_GAMES + T.gp);
      var d = w * (C.ROSTER.K * (T.rv - ctx.leagueRV) - (T.ortg - T.drtg));
      T.ortg += d / 2; T.drtg -= d / 2; parts['prior_' + who] = d; return d;
    }
    prior(H, 'home'); prior(A, 'away');
    var poss = (H.pace + A.pace) / 2;
    var hBase = (H.ortg * C.OFF_W + A.drtg * C.DEF_W) * poss / 100;
    var aBase = (A.ortg * C.OFF_W + H.drtg * C.DEF_W) * poss / 100;
    // form: opponent-adjusted when available, else raw last-5 scoring
    // own = change to the team's own points, opp = change to the opponent's points
    function formOf(T) {
      if (T.sForm != null && T.sSeason != null) { var f = (T.sForm - T.sSeason) * C.FORM_STRENGTH_W; return { own: f / 2, opp: -f / 2, net: f }; }
      var d = T.l5ppg != null ? (T.l5ppg - T.ppg) * C.FORM_W : 0; return { own: d, opp: 0, net: d };
    }
    var fH = formOf(H), fA = formOf(A);
    var rH = restPts('home', ctx), rA = restPts('away', ctx);
    parts.form = { home: fH.net, away: fA.net }; parts.rest = { home: rH.parts, away: rA.parts };
    // availability scenarios
    var hS = scenarios(ctx.homeInj || { sure: n(ctx.homeInjPts, 0), unc: [] }), aS = scenarios(ctx.awayInj || { sure: n(ctx.awayInjPts, 0), unc: [] });
    if (!ctx.homeInj && ctx.homeInjPts != null) hS = [{ p: 1, impact: n(ctx.homeInjPts, 0) }];
    if (!ctx.awayInj && ctx.awayInjPts != null) aS = [{ p: 1, impact: n(ctx.awayInjPts, 0) }];
    var sharedOff = (ctx.homeInj || ctx.awayInj) ? C.AVAIL.OFF_SHARE : 1;  // v2 impacts are margin points split across both ends; v1 callers pass scoring pts
    var HCAv = C.HCA;
    function core(hLoss, aLoss) { // -> {margin(uncompressed, incl HCA), total}
      var hOwn = hLoss * sharedOff, hDef = hLoss * (1 - sharedOff), aOwn = aLoss * sharedOff, aDef = aLoss * (1 - sharedOff);
      var hp = hBase + fH.own + fA.opp - hOwn + aDef - rH.pts, ap = aBase + fA.own + fH.opp - aOwn + hDef - rA.pts;
      return { hp: hp, ap: ap };
    }
    var exM = 0, exT = 0, exH = 0, exA = 0, scen = [];
    hS.forEach(function (hs) { aS.forEach(function (as) {
      var c = core(hs.impact, as.impact), p = hs.p * as.p;
      var m = (c.hp - c.ap + HCAv) * C.MARGIN_COMPRESS; scen.push({ p: p, margin: m });
      exM += p * m; exH += p * c.hp; exA += p * c.ap;
    }); });
    var modelTotalPoss = exH + exA;
    // total: 3-signal ensemble (possession model, scoring averages, last-5 scoring), each shifted by the availability/rest adjustments
    var shift = modelTotalPoss - (hBase + aBase) - (fH.own + fH.opp + fA.own + fA.opp);
    var T = C.TOTAL_ENS, total;
    var sigEppg = (H.ppg + A.ppg) + shift, sigL5 = (n(H.l5ppg, H.ppg) + n(A.l5ppg, A.ppg)) + shift;
    var haveSignals = hm && am && hm.ppg != null && am.ppg != null;
    total = haveSignals ? T.poss * modelTotalPoss + T.eppg * sigEppg + T.l5 * sigL5 : modelTotalPoss;
    var rawMargin = exM, rawTotal = total, margin = exM;
    var sdM = C.MARGIN_SD * Math.sqrt(poss / C.LEAGUE.pace), sdT = C.TOTAL_SD * Math.sqrt(poss / C.LEAGUE.pace);
    var out = { poss: poss, rawMargin: rawMargin, rawTotal: rawTotal, parts: parts, sdMargin: sdM, sdTotal: sdT, scenarios: scen.length,
                dataQuality: (H.hasData && A.hasData) ? 'full' : 'league-average fallback' };
    var hasSp = ctx.spread != null && !isNaN(ctx.spread), hasTo = ctx.total != null && !isNaN(ctx.total);
    if (hasSp) { var mm = -ctx.spread; margin = mm + (1 - C.CAL.W_MARKET_SPREAD) * (rawMargin - mm); }
    if (hasTo) total = ctx.total + (1 - C.CAL.W_MARKET_TOTAL) * (rawTotal - ctx.total);
    out.margin = margin; out.total = total;
    out.homePts = total / 2 + margin / 2; out.awayPts = total / 2 - margin / 2;
    // win probability: scenario mixture (shifted by the market blend), then Platt hook
    var shiftM = margin - rawMargin, pw = 0;
    scen.forEach(function (s) { pw += s.p * phi((s.margin + shiftM) / sdM); });
    out.pHomeRaw = pw; out.pHome = platt(pw);
    if (hasSp) { var e = margin + ctx.spread; out.spread = { line: ctx.spread, edge: e, rawEdge: rawMargin + ctx.spread, pickHome: e >= 0, pCover: phi(Math.abs(e) / sdM) }; }
    if (hasTo) { var et = total - ctx.total; out.totalMkt = { line: ctx.total, edge: et, rawEdge: rawTotal - ctx.total, pickOver: et >= 0, pHit: phi(Math.abs(et) / sdT) }; }
    return out;
  }

  // ── player prop projection ────────────────────────────────────────────────
  var STAT_KEYS = { pts: 'pts', reb: 'reb', ast: 'ast', fg3m: 'fg3m', stl: 'stl', blk: 'blk', pra: 'pra' };
  var STAT_COL = { pts: 2, reb: 3, ast: 4, stl: 5, blk: 6, fg3m: 7, min: 1 };

  function statBase(p, stat) {
    var s = p.stats || {}, k = STAT_KEYS[stat]; if (!k) return null;
    var season = s[k], recent = s[k + '_l10'];
    if (season == null) return null;
    var w = CONFIG.PROP.RECENT_W;
    return recent == null ? season : (1 - w) * season + w * recent;
  }
  function statSd(p, stat, m) {
    var s = p.stats || {};
    if (stat === 'pra') return Math.sqrt(Math.pow(n(s.sd_pts, 6), 2) + Math.pow(n(s.sd_reb, 3), 2) + Math.pow(n(s.sd_ast, 2.5), 2)) * 1.12;
    if (s['sd_' + stat] != null) return Math.max(s['sd_' + stat], 0.5);
    return Math.max(Math.sqrt(Math.max(m, 0.3)), 0.5);
  }
  function rowStat(r, stat) { return stat === 'pra' ? r[2] + r[3] + r[4] : r[STAT_COL[stat]]; }
  function logRows(p) { // usable rows (played >= 8 min), oldest -> newest
    return (p.log || []).filter(function (r) { return r && r[1] >= 8; });
  }
  function posGroup(pos) { var s = String(pos || '').toUpperCase().split(/[-\/]/)[0]; return { PG: 'G', SG: 'G', G: 'G', GF: 'G', SF: 'F', PF: 'F', F: 'F', FC: 'C', C: 'C' }[s] || 'F'; }

  function projectMinutes(p, rows, g) {
    var M = CONFIG.PROP.MIN, s = p.stats || {}, season = n(s.min, 0), l5 = rows.slice(-5).map(function (r) { return r[1]; });
    var base = l5.length >= 3 ? (1 - M.L5_W) * season + M.L5_W * mean(l5) : season, adj = {};
    var starter = season >= M.STARTER_MPG;
    if (g.teamB2B && starter) { base -= M.B2B_STARTER; adj.b2b = -M.B2B_STARTER; }
    var mg = Math.abs(n(g.margin, 0));
    if (mg > CONFIG.PROP.BLOWOUT_START) {
      var loss = Math.min(M.BLOW_MAX, M.BLOW_RATE * (mg - CONFIG.PROP.BLOWOUT_START));
      if (starter) { base -= loss * Math.min(1, season / 36); adj.blowout = -loss * Math.min(1, season / 36); }
      else if (season >= 8 && season < 22) { base += loss * M.BENCH_GAIN * 0.5; adj.blowout = loss * M.BENCH_GAIN * 0.5; }
    }
    if (g.absent && g.absent.length && g.rotationTotals && n(g.rotationTotals.min, 0) > 0) {
      var lostMin = 0; g.absent.forEach(function (a) { lostMin += n(a.stats && a.stats.min, 0) * n(a.weight, 1); });
      var gain = Math.min(M.ABSORB_CAP, lostMin * season / g.rotationTotals.min);
      if (gain > 0.05) { base += gain; adj.teammates = gain; }
    }
    return { min: Math.min(M.CEIL, Math.max(M.FLOOR, base)), adj: adj };
  }

  /* projectProp(player, stat, game) -> {proj, sd, base, adj, minutes?, samples?}
   * game: { oppMetrics, teamMetrics, gamePoss, margin, teamB2B, absent:[{name,stats,weight}], rotationTotals, oppDvp, minMpg }
   * Uses the per-minute x projected-minutes path when the player log is present, else the v1 per-game path.            */
  function projectProp(p, stat, g) {
    var P = CONFIG.PROP, s = p.stats;
    if (!s || n(s.gp, 0) + n(s.gp_prior, 0) < P.MIN_GAMES || n(s.min, 0) < (g.minMpg != null ? g.minMpg : P.MIN_MPG)) return null;
    var base = statBase(p, stat); if (base == null) return null;
    var rows = logRows(p), useLog = rows.length >= P.LOG_MIN && n(s.min, 0) > 0;
    var adj = {}, v = base, mins = null, samples = null;
    var tm = teamView(g.teamMetrics), opp = teamView(g.oppMetrics);
    if (useLog) {
      var mp = projectMinutes(p, rows, g); mins = mp.min; adj.minutes = mp.adj;
      var FT = CONFIG.CAL.F || {};
      if (FT.TANK > 0 && g.motiv && g.motiv.rem <= 25 && g.motiv.wp < 0.38 && n(s.min, 0) >= 8 && n(s.min, 0) < 22) { var lift = 1 + FT.TANK * (25 - g.motiv.rem) / 25; mins = Math.min(CONFIG.PROP.MIN.CEIL, mins * lift); adj.tank = lift; }
      var key = STAT_KEYS[stat];
      var seasonRate = n(s[key], 0) / s.min, l10 = rows.slice(-10);
      var l10min = l10.reduce(function (a, r) { return a + r[1]; }, 0), l10val = l10.reduce(function (a, r) { return a + rowStat(r, stat); }, 0);
      var FX = CONFIG.CAL.F || {}, ratio3 = 1;
      if (stat === 'fg3m' && FX.FG3_K > 0 && n(s.fg3a, 0) > 0.5) {   // regress the make rate toward the league 3P%, keep the attempt volume
        var att = n(s.fg3a, 0) * (n(s.gp, 0) + 0.5 * n(s.gp_prior, 0)), pct = n(s.fg3m, 0) / s.fg3a, regp = (att * pct + FX.FG3_K * CONFIG.LEAGUE.fg3pct) / (att + FX.FG3_K);
        ratio3 = regp / Math.max(pct, 0.05); seasonRate = seasonRate * ratio3; adj.fg3reg = ratio3;
      }
      var rate = (l10min > 0 && stat !== 'pra') ? (1 - P.RECENT_W * (stat === 'fg3m' ? FX.FG3_RECENT : 1)) * seasonRate + P.RECENT_W * (stat === 'fg3m' ? FX.FG3_RECENT : 1) * (l10val / l10min) : (stat === 'pra' && l10min > 0 ? (1 - P.RECENT_W) * seasonRate + P.RECENT_W * (l10val / l10min) : seasonRate);
      v = rate * mins; base = v;
      samples = rows.map(function (r) { return rowStat(r, stat) / r[1] * mins * ratio3; });
    }
    if (g.gamePoss && tm.pace) { adj.pace = Math.pow(g.gamePoss / tm.pace, P.PACE_EXP); v *= adj.pace; if (samples) samples = samples.map(function (x) { return x * adj.pace; }); }
    // opponent: position-specific DvP where available (composite stats multiply the parts), else team defensive rating
    var dv = null;
    if (g.oppDvp && useLog) {
      var grp = g.oppDvp[posGroup(p.pos)];
      if (grp) {
        if (stat === 'pra') { var a = grp.pts, b = grp.reb, c = grp.ast; if (a != null && b != null && c != null) { var wts = [n(s.pts, 0), n(s.reb, 0), n(s.ast, 0)], ws = wts[0] + wts[1] + wts[2]; dv = ws > 0 ? (a * wts[0] + b * wts[1] + c * wts[2]) / ws : 1; } }
        else if (grp[stat] != null) dv = grp[stat];
      }
    }
    var de = P.DEF_EXP[stat];
    if (dv != null) { adj.dvp = Math.pow(dv, P.DVP_W); v *= adj.dvp; if (samples) samples = samples.map(function (x) { return x * adj.dvp; }); }
    else if (de) { adj.def = Math.pow(opp.drtg / CONFIG.LEAGUE.drtg, de); v *= adj.def; if (samples) samples = samples.map(function (x) { return x * adj.def; }); }
    if (!useLog) {
      if (g.teamB2B) { adj.b2b = P.B2B_MULT; v *= adj.b2b; }
      var mg = Math.abs(n(g.margin, 0));
      if (n(s.min, 0) >= P.BLOWOUT_MIN_MPG && mg > P.BLOWOUT_START) { adj.blowout = Math.max(P.BLOWOUT_FLOOR, 1 - P.BLOWOUT_SLOPE * (mg - P.BLOWOUT_START)); v *= adj.blowout; }
    }
    // teammates out: role-aware — a player takes a share of the missing production proportional to his share of that stat
    var uk = stat === 'pra' ? 'pts' : stat, absorb = P.USAGE_ABSORB[uk];
    if (absorb && g.absent && g.absent.length && g.rotationTotals) {
      var lostTot = 0; g.absent.forEach(function (a) { lostTot += n(a.stats && a.stats[uk], 0) * a.weight; });
      var tot = n(g.rotationTotals[uk], 0);
      if (tot > 0 && lostTot > 0) {
        var share = n(s[uk], 0) / tot, bump = lostTot * absorb * share * (useLog ? 0.7 : 1);   // minutes model already carries part of the absorption
        adj.usage = bump; var add = (stat === 'pra') ? bump * 1.4 : bump; v += add; if (samples) samples = samples.map(function (x) { return x + add; });
      }
    }
    var sd = statSd(p, stat, v);
    if (samples && samples.length >= P.LOG_MIN) { var es = sdOf(samples); if (es != null) sd = Math.max(0.5, 0.5 * sd + 0.5 * es); }
    if (mins != null && s.min > 0) sd *= Math.sqrt(mins / s.min);       // heteroscedastic: fewer minutes -> less variance
    var out = { proj: v, sd: sd, base: base, adj: adj };
    if (mins != null) out.minutes = mins; if (samples) out.samples = samples;
    return out;
  }

  /* P(X > line). parametric: normal / NB / Poisson by stat; empirical: kernel over minute-normalised log samples;
   * blended EMP_W when samples exist. Integer lines treat a push as a loss for the over (X > line).               */
  function propProbOver(proj, sd, line, stat, opts) {
    var P = CONFIG.PROP, kind = P.DIST[stat] || 'normal', k = Math.floor(line), pPar;
    proj = Math.max(proj, 0.05); sd = Math.max(sd, 0.5);
    if (kind === 'poisson') pPar = 1 - poissonCdf(k, proj);
    else if (kind === 'nb') pPar = 1 - nbCdf(k, proj, sd * sd);
    else pPar = 1 - phi((k + 0.5 - proj) / sd);
    var samples = opts && opts.samples;
    if (samples && samples.length >= P.LOG_MIN) {
      var h = Math.max(0.35 * sd, 0.4), pe = mean(samples.map(function (x) { return 1 - phi((k + 0.5 - x) / h); }));
      // re-centre empirical on the projection so it supplies shape, not level
      var shift = proj - mean(samples); pe = mean(samples.map(function (x) { return 1 - phi((k + 0.5 - (x + shift)) / h); }));
      return P.EMP_W * pe + (1 - P.EMP_W) * pPar;
    }
    return pPar;
  }

  function tierFor(edgePts) {
    for (var i = 0; i < CONFIG.TIERS.length; i++) if (edgePts >= CONFIG.TIERS[i].min) return CONFIG.TIERS[i];
    return null;
  }
  function tierDown(t) { if (!t) return null; var i = CONFIG.TIERS.indexOf(t); return i + 1 < CONFIG.TIERS.length ? CONFIG.TIERS[i + 1] : null; }

  function phiInv(p) { var lo = -6, hi = 6; p = Math.min(Math.max(p, 1e-6), 1 - 1e-6); for (var i = 0; i < 40; i++) { var m = (lo + hi) / 2; if (phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
  function marketMean(offers, stat, sd) {
    var vals = [];
    (offers || []).forEach(function (o) {
      var bo = impliedProb(o.over), bu = impliedProb(o.under); if (bo == null || bu == null) return;
      var fo = bo / (bo + bu), s = Math.max(sd || Math.sqrt(Math.max(o.line, 1)), 0.5);
      vals.push(Math.floor(o.line) + 0.5 + s * phiInv(fo));
    });
    return vals.length ? median(vals) : null;
  }

  /* evaluate one book line -> best side with edge vs the no-vig fair price.
   * mktMean (optional): consensus market mean for this player/stat; the projection is blended toward it and the win
   * probability is shrunk toward the fair price by CAL.SHRINK[stat].                                              */
  function evaluateProp(p, stat, game, offer, mktMean) {
    var pr = projectProp(p, stat, game); if (!pr) return null;
    var C = CONFIG.CAL, beO = impliedProb(offer.over), beU = impliedProb(offer.under);
    if (beO == null || beU == null) return null;
    var vig = beO + beU, fairO = beO / vig, fairU = beU / vig;
    var proj = pr.proj, raw = pr.proj, move = (offer.open != null && !isNaN(offer.open)) ? offer.line - offer.open : null;
    if (mktMean != null && !isNaN(mktMean)) { var wm = (C.W_PROP && C.W_PROP[stat] != null) ? C.W_PROP[stat] : C.PROP_W_MARKET; proj = (1 - wm) * proj + wm * mktMean; }
    if (move != null && C.F && C.F.MOVE_W) proj += C.F.MOVE_W * move;   // line movement since the early snapshot (fitted weight; 0 = ignore)
    var pOverRaw = propProbOver(proj, pr.sd, offer.line, stat, { samples: pr.samples });
    var sh = n(C.SHRINK[stat], 0.75);
    var pOver = fairO + sh * (pOverRaw - fairO);
    if (C.OVER_B) pOver = sigmoid(logit(pOver) + C.OVER_B);
    var pUnder = 1 - pOver;
    var eO = (pOver - fairO) * 100, eU = (pUnder - fairU) * 100;
    var over = eO >= eU, edge = over ? eO : eU, prob = over ? pOver : pUnder, price = over ? offer.over : offer.under;
    var t = tierFor(edge), trend = null, flag = null;
    if (t && C.MIN_EV > 0 && prob * payout(price) - (1 - prob) < C.MIN_EV) t = null;   // not worth the juice
    // trend agreement: tier drops one level when the last-10 average sits on the wrong side of the line
    var l10 = null, rows = logRows(p).slice(-10);
    if (rows.length >= 5) l10 = mean(rows.map(function (r) { return rowStat(r, stat); })); else if (p.stats && p.stats[stat + '_l10'] != null) l10 = p.stats[stat + '_l10'];
    if (l10 != null) {
      trend = l10; var disagree = over ? l10 < offer.line - CONFIG.PROP.TREND_MARGIN : l10 > offer.line + CONFIG.PROP.TREND_MARGIN;
      if (disagree && t) { flag = 'trend-disagree'; t = tierDown(t); }
    }
    var rawProb = (over ? propProbOver(raw, pr.sd, offer.line, stat, { samples: pr.samples }) : 1 - propProbOver(raw, pr.sd, offer.line, stat, { samples: pr.samples }));
    return { player: p.name, team: p.team, stat: stat, book: offer.book, line: offer.line, side: over ? 'OVER' : 'UNDER',
             price: price, proj: proj, projRaw: raw, sd: pr.sd, minutes: pr.minutes != null ? pr.minutes : null, prob: prob, probRaw: rawProb, fair: over ? fairO : fairU,
             edge: edge, ev: prob * payout(price) - (1 - prob), tier: t ? t.name : 'SKIP', units: t ? t.units : '0U',
             move: move, trend: trend, flag: flag, mktMean: mktMean != null ? mktMean : null, adj: pr.adj };
  }

  // ── whole-slate driver ────────────────────────────────────────────────────
  function indexData(data) {
    var teams = {}; (data.teams || []).forEach(function (t) { teams[t.abbr] = t; });
    var metrics = {}, dvp = {}; Object.keys(data.team_stats || {}).forEach(function (k) { var ts = data.team_stats[k] || {}; metrics[k] = ts.metrics || {}; dvp[k] = ts.dvp || null; });
    var byTeam = {}; (data.players || []).forEach(function (p) { (byTeam[p.team] = byTeam[p.team] || []).push(p); });
    return { teams: teams, metrics: metrics, dvp: dvp, byTeam: byTeam, leagueRV: data.meta && data.meta.league_roster_value != null ? data.meta.league_roster_value : null };
  }
  function byTeamList(idx, abbr) { return idx.byTeam[abbr] || []; }

  function findGameLine(data, g) {
    var rows = (data.odds && data.odds.game_lines) || [];
    var nm = function (x) { x = String(x || '').toLowerCase(); return x === 'los angeles clippers' ? 'la clippers' : x; };   // ESPN says LA Clippers, The Odds API says Los Angeles Clippers
    var hn = nm(g.home_name), an = nm(g.away_name);
    var sp = [], to = [];
    rows.forEach(function (r) {
      if (nm(r.home) !== hn || nm(r.away) !== an) return;
      if (r.spreads_home != null) sp.push(r.spreads_home); if (r.totals_over != null) to.push(r.totals_over);
    });
    if (!sp.length && !to.length) return null;
    return { spread: median(sp), total: median(to), books: rows.length };
  }

  function gameContext(data, idx, g) {
    var inj = data.injuries || [];
    var hI = injuryReport(g.home, byTeamList(idx, g.home), inj), aI = injuryReport(g.away, byTeamList(idx, g.away), inj);
    var line = findGameLine(data, g);
    var proj = projectGame(idx.metrics[g.home], idx.metrics[g.away], {
      homeB2B: g.home_b2b, awayB2B: g.away_b2b, homeRest: g.home_rest, awayRest: g.away_rest, homeIn4: g['home_3in4'], awayIn4: g['away_3in4'],
      homeTravel: g.home_travel, awayTravel: g.away_travel, homeInj: hI, awayInj: aI, leagueRV: idx.leagueRV,
      spread: line ? line.spread : null, total: line ? line.total : null });
    return { game: g, proj: proj, homeInj: hI, awayInj: aI, line: line };
  }

  function rotationTotals(players, absentNames) {
    var tot = { pts: 0, reb: 0, ast: 0, fg3m: 0, min: 0 };
    players.forEach(function (p) {
      if (!p.stats || n(p.stats.min, 0) < CONFIG.PROP.MIN_MPG || absentNames[(p.name || '').toLowerCase()]) return;
      Object.keys(tot).forEach(function (k) { tot[k] += n(p.stats[k], 0); });
    });
    return tot;
  }

  function motivOf(m) { m = m || {}; var gp = n(m.wins, 0) + n(m.losses, 0); return gp >= 20 ? { rem: 82 - gp, wp: n(m.wins, 0) / gp } : null; }
  function buildSideContexts(data) {
    var idx = indexData(data), out = [];
    (data.games || []).forEach(function (g) {
      var ctx = gameContext(data, idx, g);
      [['home', 'away'], ['away', 'home']].forEach(function (sides) {
        var tAbbr = g[sides[0]], oAbbr = g[sides[1]];
        var inj = sides[0] === 'home' ? ctx.homeInj : ctx.awayInj;
        var absentNames = {}, absent = [];
        inj.list.forEach(function (i) { if (i.pOut >= CONFIG.AVAIL.SURE_AT) absentNames[i.name.toLowerCase()] = 1; });
        var roster = byTeamList(idx, tAbbr);
        inj.list.forEach(function (i) { absent.push({ name: i.name, stats: i.stats, weight: i.pOut }); });
        out.push({ game: g, gctx: ctx, team: tAbbr, opp: oAbbr, roster: roster, absentNames: absentNames,
          gameCtx: { oppMetrics: idx.metrics[oAbbr], teamMetrics: idx.metrics[tAbbr], oppDvp: idx.dvp[oAbbr], gamePoss: ctx.proj.poss, margin: ctx.proj.margin,
                     teamB2B: sides[0] === 'home' ? g.home_b2b : g.away_b2b, motiv: motivOf(idx.metrics[tAbbr]), absent: absent, rotationTotals: rotationTotals(roster, absentNames) } });
      });
    });
    return { idx: idx, sides: out };
  }

  function evaluateSlate(data) {
    var built = buildSideContexts(data), out = { games: [], props: [] }, seen = {};
    var propsByKey = {};
    ((data.odds && data.odds.props) || []).forEach(function (o) { var k = (o.player || '').toLowerCase() + '|' + o.market; (propsByKey[k] = propsByKey[k] || []).push(o); });
    built.sides.forEach(function (sd) {
      if (!seen[sd.game.id]) { seen[sd.game.id] = 1; out.games.push(sd.gctx); }
      sd.roster.forEach(function (p) {
        if (sd.absentNames[(p.name || '').toLowerCase()]) return;
        Object.keys(STAT_KEYS).forEach(function (stat) {
          var offers = propsByKey[(p.name || '').toLowerCase() + '|' + stat] || []; if (!offers.length) return;
          var mm = marketMean(offers, stat, statSd(p, stat, offers[0].line));
          offers.forEach(function (o) {
            var ev = evaluateProp(p, stat, sd.gameCtx, o, mm); if (ev) { ev.gameId = sd.game.id; ev.opp = sd.opp; out.props.push(ev); }
          });
        });
      });
    });
    out.props.sort(function (a, b) { return b.edge - a.edge; });
    return out;
  }

  root.NBAEngine = { CONFIG: CONFIG, phi: phi, poissonCdf: poissonCdf, nbCdf: nbCdf, impliedProb: impliedProb, projectGame: projectGame, injuryPoints: injuryPoints,
    injuryReport: injuryReport, playerImpact: playerImpact, scenarios: scenarios, projectMinutes: projectMinutes, projectProp: projectProp, propProbOver: propProbOver,
    evaluateProp: evaluateProp, evaluateSlate: evaluateSlate, indexData: indexData, tierFor: tierFor, findGameLine: findGameLine, buildSideContexts: buildSideContexts,
    marketMean: marketMean, setCalibration: setCalibration, getCalibration: getCalibration, platt: platt, logRows: logRows, rowStat: rowStat, posGroup: posGroup };
  if (typeof module !== 'undefined') module.exports = root.NBAEngine;
})(typeof window !== 'undefined' ? window : globalThis);
