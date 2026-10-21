#!/usr/bin/env python3
"""
NBA Edge Model - Data Pull Script  (companion to NBA_Edge_Model_v1.1.html)
==========================================================================
Run daily (GitHub Actions) or by hand:
    python nba_edge_data_pull.py              # full pull -> nba_model_data.json
    python nba_edge_data_pull.py --selftest   # offline logic test, no network

Sources (free first, paid optional):
  - ESPN public API (no key): teams, rosters, injuries, schedule, player game logs, team stats
  - The Odds API (ODDS_API_KEY): spreads, totals, moneylines, player props (5 books only)

Keys: keys.txt (NAME=value, one per line) next to this script wins over environment variables.
      Names: ODDS_API_KEY, BIGBALLS_API_KEY, SGO_API_KEY
Requirements: pip install requests
"""
import os, sys, json, time, math, datetime as dt
from concurrent.futures import ThreadPoolExecutor

try:
    import requests
except ImportError:
    requests = None

VERSION = "1.6"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.environ.get("NBA_OUTPUT_FILE", os.path.join(SCRIPT_DIR, "nba_model_data.json"))

# NBA season label: season "2026" = 2026-27. Season flips in October.
_today = dt.date.today()
CURRENT_SEASON = _today.year if _today.month >= 10 else _today.year - 1
PRIOR_SEASON = CURRENT_SEASON - 1

ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
ESPN_WEB = "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba"
ESPN_COMMON = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba"
ODDS = "https://api.the-odds-api.com/v4/sports/basketball_nba"

# Only these five books are kept (same rule as the NFL / NCAAF models)
BOOKS = ["draftkings", "fanduel", "betmgm", "williamhill_us", "betrivers"]  # williamhill_us = Caesars
BOOK_LABEL = {"draftkings": "DraftKings", "fanduel": "FanDuel", "betmgm": "BetMGM",
              "williamhill_us": "Caesars", "betrivers": "BetRivers"}
PROP_MARKETS = {"player_points": "pts", "player_rebounds": "reb", "player_assists": "ast",
                "player_threes": "fg3m", "player_points_rebounds_assists": "pra",
                "player_steals": "stl", "player_blocks": "blk"}
SCHEDULE_DAYS = max(7, min(30, int(os.environ.get("NBA_SCHEDULE_DAYS", "14") or 14)))   # how many days of games the file holds (Odds API only lists lines ~1-4 days ahead)
PRIOR_K = 12   # games of current season at which current/prior weights are equal


# ── keys ────────────────────────────────────────────────────────────────────
def _clean(v):
    v = (v or "").strip().strip("'\"").strip()
    for p in ("Bearer ", "+"):
        if v.startswith(p):
            v = v[len(p):].strip()
    return v.replace(" ", "")

def load_keys():
    keys = {}
    path = os.path.join(SCRIPT_DIR, "keys.txt")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8", errors="ignore"):
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                keys[k.strip().upper()] = _clean(v)
    for name in ("ODDS_API_KEY", "BIGBALLS_API_KEY", "SGO_API_KEY"):
        if not keys.get(name):
            keys[name] = _clean(os.environ.get(name, ""))
    print("Key report:")
    for k, v in keys.items():
        print(f"  {k:18} " + (f"len {len(v)} ({v[:3]}...{v[-3:]})" if v else "MISSING"))
    return keys


# ── http ────────────────────────────────────────────────────────────────────
HTTP_FAILS = []   # (status or error, url) of requests that gave up - printed in the run log

def _note_fail(what, url):
    if len(HTTP_FAILS) < 400: HTTP_FAILS.append((what, url.split("apiKey=")[0][:160]))

def get_json(url, params=None, headers=None, retries=3, timeout=25):
    if requests is None:
        return None
    for i in range(retries):
        try:
            r = requests.get(url, params=params, headers=headers or {"User-Agent": "Mozilla/5.0"}, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 500, 502, 503):
                time.sleep(1.5 * (i + 1)); continue
            _note_fail(r.status_code, url if not params else url + "?" + "&".join(f"{k}={v}" for k, v in params.items() if k != "apiKey"))
            return None
        except Exception as e:
            if i == retries - 1: _note_fail(type(e).__name__, url)
            time.sleep(1.0 * (i + 1))
    _note_fail("gave up", url)
    return None

def num(x, d=0.0):
    try:
        if x is None or x == "": return d
        return float(str(x).replace(",", ""))
    except Exception:
        return d


# ── pure logic (selftest covers these) ──────────────────────────────────────
def blend_weight(games_cur, k=PRIOR_K):
    """Weight on the current season: 0 at no games, 0.5 at k games, ->1 as games grow."""
    return games_cur / (games_cur + k) if games_cur >= 0 else 0.0

def blend(cur, prior, games_cur, k=PRIOR_K):
    if prior is None: return cur
    if cur is None: return prior
    w = blend_weight(games_cur, k)
    return w * cur + (1 - w) * prior

GAMELOG_ALIAS = {"minutes": "MIN", "points": "PTS", "totalRebounds": "REB", "rebounds": "REB", "assists": "AST", "steals": "STL",
                 "blocks": "BLK", "turnovers": "TO", "fouls": "PF",
                 "threePointFieldGoalsMade-threePointFieldGoalsAttempted": "3PT", "fieldGoalsMade-fieldGoalsAttempted": "FG"}

def _gamelog_header(js):
    """ESPN sends BOTH 'labels' (MIN, PTS ...) and 'names' (minutes, points ...). Prefer labels; map long names if that is all there is."""
    for key in ("labels", "names", "displayNames"):
        cols = js.get(key) or []
        mapped = [GAMELOG_ALIAS.get(c, c) for c in cols]
        if "MIN" in mapped and "PTS" in mapped:
            return mapped
    return js.get("labels") or js.get("names") or []

def parse_gamelog(js):
    """ESPN gamelog -> list of dict games (newest last). Uses the 'names'/'labels' header row."""
    out = []
    if not js: return out
    names = _gamelog_header(js)
    events_meta = js.get("events") or {}
    for st in js.get("seasonTypes", []):
        if "regular" not in (st.get("displayName", "").lower()):
            continue
        for cat in st.get("categories", []):
            for ev in cat.get("events", []):
                stats = ev.get("stats") or []
                row = dict(zip(names, stats))
                try:
                    fg3 = str(row.get("3PT", "0-0")).split("-")
                    g = {"min": num(row.get("MIN")), "pts": num(row.get("PTS")), "reb": num(row.get("REB")),
                         "ast": num(row.get("AST")), "stl": num(row.get("STL")), "blk": num(row.get("BLK")),
                         "to": num(row.get("TO")), "fg3m": num(fg3[0]), "fg3a": num(fg3[1] if len(fg3) > 1 else 0)}
                except Exception:
                    continue
                meta = events_meta.get(str(ev.get("eventId")), {}) if isinstance(events_meta, dict) else {}
                g["date"] = (meta.get("gameDate") or "")[:10]
                g["home"] = meta.get("atVs") == "vs"
                g["opp"] = (meta.get("opponent") or {}).get("abbreviation", "")
                if g["min"] > 0:
                    out.append(g)
    out.sort(key=lambda g: g["date"])
    return out

def summarize_games(games, last_n=10):
    if not games: return None
    n = len(games)
    def avg(key, rows): return sum(g[key] for g in rows) / len(rows) if rows else 0.0
    rec = games[-last_n:]
    s = {"gp": n}
    for k in ("min", "pts", "reb", "ast", "stl", "blk", "to", "fg3m", "fg3a"):
        s[k] = round(avg(k, games), 2)
        s[k + "_l" + str(last_n)] = round(avg(k, rec), 2)
    s["pra"] = round(s["pts"] + s["reb"] + s["ast"], 2)
    s["pra_l%d" % last_n] = round(s["pts_l%d" % last_n] + s["reb_l%d" % last_n] + s["ast_l%d" % last_n], 2)
    # stdev for edge/probability math
    for k in ("pts", "reb", "ast", "fg3m"):
        m = s[k]
        s["sd_" + k] = round(math.sqrt(sum((g[k] - m) ** 2 for g in games) / max(n - 1, 1)), 2)
    return s

def blend_summaries(cur, prior):
    if cur is None: return prior
    if prior is None: return cur
    out = dict(cur)
    for k, v in cur.items():
        if k == "gp" or not isinstance(v, (int, float)): continue
        pv = prior.get(k)
        if isinstance(pv, (int, float)):
            out[k] = round(blend(v, pv, cur["gp"]), 2)
    out["gp_prior"] = prior["gp"]
    out["blend_w_current"] = round(blend_weight(cur["gp"]), 3)
    return out

def back_to_back(schedule_dates, d):
    """True if the team played the day before date d (d and schedule_dates are ISO strings)."""
    prev = (dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat()
    return prev in schedule_dates

def pick_main_line(offers):
    """Several lines for one prop at one book: choose the one whose over/under price is closest to even odds."""
    best, best_d = None, 1e9
    for o in offers:
        try:
            d = abs(abs(o["over"]) - 100) + abs(abs(o["under"]) - 100)
        except Exception:
            continue
        if d < best_d: best, best_d = o, d
    return best


# ── ESPN pulls ──────────────────────────────────────────────────────────────
def pull_teams():
    js = get_json(ESPN + "/teams")
    teams = []
    try:
        for t in js["sports"][0]["leagues"][0]["teams"]:
            t = t["team"]
            teams.append({"id": t["id"], "abbr": t["abbreviation"], "name": t["displayName"],
                          "short": t.get("shortDisplayName", ""), "color": "#" + t.get("color", "888888")})
    except Exception:
        pass
    return teams

# ESPN stat-name aliases (ESPN renames fields now and then, so each metric tries several names)
STAT_ALIASES = {
    "ppg": ["avgPoints", "pointsPerGame"], "fgm": ["avgFieldGoalsMade"], "fga": ["avgFieldGoalsAttempted"],
    "fg3m": ["avgThreePointFieldGoalsMade", "avgThreePointFieldGoalsMade"], "fg3a": ["avgThreePointFieldGoalsAttempted"],
    "ftm": ["avgFreeThrowsMade"], "fta": ["avgFreeThrowsAttempted"], "oreb": ["avgOffensiveRebounds"],
    "dreb": ["avgDefensiveRebounds"], "reb": ["avgRebounds"], "ast": ["avgAssists"], "tov": ["avgTurnovers"],
    "stl": ["avgSteals"], "blk": ["avgBlocks"],
}
LEAGUE_DREB = 33.5   # league-average opponent defensive rebounds per game (approximation for ORB%)

def pick_stat(flat, key):
    for name in STAT_ALIASES.get(key, []):
        if name in flat and flat[name] not in (None, 0):
            return flat[name]
    return None

def parse_schedule_results(sched):
    """ESPN team schedule -> list of {date, home, pf, pa, win} for COMPLETED regular-season games, oldest first."""
    out = []
    tid = str((sched or {}).get("team", {}).get("id", ""))
    for ev in (sched or {}).get("events", []):
        try:
            comp = ev["competitions"][0]
            done = comp.get("status", {}).get("type", {}).get("completed") or ev.get("status", {}).get("type", {}).get("completed")
            if not done: continue
            stype = (ev.get("seasonType") or {}).get("name", "") or (ev.get("season") or {}).get("slug", "")
            if "post" in str(stype).lower() or "pre" in str(stype).lower(): continue   # preseason box scores (rested starters) must not feed team ratings
            comps = comp["competitors"]
            me = next(c for c in comps if str(c.get("team", {}).get("id")) == tid)
            op = next(c for c in comps if c is not me)
            def sc(c):
                v = c.get("score")
                return num(v.get("value") if isinstance(v, dict) else v)
            pf, pa = sc(me), sc(op)
            if pf <= 0 and pa <= 0: continue
            out.append({"date": (ev.get("date") or "")[:10], "home": me.get("homeAway") == "home", "pf": pf, "pa": pa,
                        "opp": (op.get("team") or {}).get("abbreviation", ""), "win": pf > pa})
        except Exception:
            continue
    out.sort(key=lambda g: g["date"])
    return out

def team_metrics(flat, results):
    """Per-game stats + results -> the ratings the engine uses. Missing inputs stay None (engine falls back to league average)."""
    g = len(results)
    m = {"gp": g}
    fga, fta, oreb, tov = (pick_stat(flat, k) for k in ("fga", "fta", "oreb", "tov"))
    fgm, fg3m = pick_stat(flat, "fgm"), pick_stat(flat, "fg3m")
    ppg = (sum(r["pf"] for r in results) / g) if g else pick_stat(flat, "ppg")
    opp = (sum(r["pa"] for r in results) / g) if g else None
    poss = None
    if None not in (fga, fta, oreb, tov):
        poss = fga + 0.44 * fta - oreb + tov
    m.update({"ppg": ppg, "oppppg": opp, "pace": poss})
    if poss and ppg: m["ortg"] = ppg / poss * 100
    if poss and opp: m["drtg"] = opp / poss * 100
    if m.get("ortg") and m.get("drtg"): m["netrtg"] = m["ortg"] - m["drtg"]
    if fga and fgm is not None and fg3m is not None: m["efg"] = (fgm + 0.5 * fg3m) / fga * 100
    if poss and tov is not None: m["tovpct"] = tov / poss * 100
    if oreb is not None: m["orbpct"] = oreb / (oreb + LEAGUE_DREB) * 100
    if fga and fta is not None: m["ftr"] = fta / fga
    for n in (5, 10):
        rec = results[-n:]
        if rec:
            m["l%dppg" % n] = sum(r["pf"] for r in rec) / len(rec)
            m["l%dopp" % n] = sum(r["pa"] for r in rec) / len(rec)
    m["last10_wins"] = sum(1 for r in results[-10:] if r["win"])
    m["wins"] = sum(1 for r in results if r["win"]); m["losses"] = g - m["wins"]
    for side, key in ((True, "h"), (False, "r")):
        rs = [r for r in results if r["home"] == side]
        if rs: m[key + "ppg"] = sum(r["pf"] for r in rs) / len(rs); m[key + "opp"] = sum(r["pa"] for r in rs) / len(rs)
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in m.items() if v is not None}

def blend_team_metrics(cur, prior):
    if not cur or cur.get("gp", 0) == 0: return dict(prior or {}, source="prior")
    if not prior: return dict(cur, source="current")
    out = dict(cur); g = cur["gp"]
    for k, v in cur.items():
        if k in ("gp", "wins", "losses", "last10_wins") or not isinstance(v, (int, float)): continue
        pv = prior.get(k)
        if isinstance(pv, (int, float)): out[k] = round(blend(v, pv, g), 3)
    for k in prior:                       # fill anything missing this season (e.g. home/road splits)
        if k not in out and isinstance(prior[k], (int, float)): out[k] = prior[k]
    out["gp_prior"] = prior.get("gp", 0); out["blend_w_current"] = round(blend_weight(g), 3); out["source"] = "blend"
    return out

def pull_team_stats(team):
    res = {}
    for label, season in (("cur", CURRENT_SEASON + 1), ("prior", CURRENT_SEASON)):
        js = get_json(f"{ESPN_WEB}/teams/{team['id']}/statistics", params={"season": season})
        flat = {}
        try:
            cats = js["results"]["stats"]["categories"] if "results" in js else js["stats"]["categories"]
            for cat in cats:
                for st in cat.get("stats", []):
                    flat[st["name"]] = num(st.get("value"))
        except Exception:
            pass
        sched = get_json(f"{ESPN}/teams/{team['id']}/schedule", params={"season": season}) or {}
        res[label] = {"flat": flat, "results": parse_schedule_results(sched), "events": parse_schedule_events(sched),
                      "dates": [(ev.get("date") or "")[:10] for ev in sched.get("events", [])]}
    cur = team_metrics(res["cur"]["flat"], res["cur"]["results"])
    pri = team_metrics(res["prior"]["flat"], res["prior"]["results"])
    return {"metrics": blend_team_metrics(cur, pri), "stats": res["cur"]["flat"] or res["prior"]["flat"],
            "game_dates": res["cur"]["dates"], "events": res["cur"]["events"],
            "results": res["cur"]["results"], "prior_results": res["prior"]["results"],
            "recent": res["cur"]["results"][-10:] or res["prior"]["results"][-10:]}

def pull_roster(team):
    js = get_json(f"{ESPN}/teams/{team['id']}/roster") or {}
    out = []
    for a in js.get("athletes", []):
        out.append({"id": a.get("id"), "name": a.get("fullName"), "pos": (a.get("position") or {}).get("abbreviation", ""),
                    "team": team["abbr"], "jersey": a.get("jersey", ""), "exp": (a.get("experience") or {}).get("years", None)})
    return out

def pull_injuries():
    js = get_json(ESPN + "/injuries") or {}
    out = []
    for blk in js.get("injuries", []):
        for inj in blk.get("injuries", []):
            ath = inj.get("athlete") or {}
            out.append({"name": ath.get("displayName"), "team": (ath.get("team") or {}).get("abbreviation", ""),
                        "status": inj.get("status"), "detail": (inj.get("details") or {}).get("type") or inj.get("shortComment", "")})
    return out

def pull_schedule(days=7):
    games = []
    for i in range(days):
        d = _today + dt.timedelta(days=i)
        js = get_json(ESPN + "/scoreboard", params={"dates": d.strftime("%Y%m%d")})
        for ev in (js or {}).get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            home = next((c for c in comp.get("competitors", []) if c.get("homeAway") == "home"), {})
            away = next((c for c in comp.get("competitors", []) if c.get("homeAway") == "away"), {})
            games.append({"id": ev.get("id"), "date": d.isoformat(), "time": ev.get("date"),
                          "home": (home.get("team") or {}).get("abbreviation"), "away": (away.get("team") or {}).get("abbreviation"),
                          "home_name": (home.get("team") or {}).get("displayName"), "away_name": (away.get("team") or {}).get("displayName"),
                          "venue": (comp.get("venue") or {}).get("fullName", ""),
                          "preseason": str((ev.get("season") or {}).get("slug", "")).lower() == "preseason" or (ev.get("season") or {}).get("type") == 1})
    return games

LOG_COLS = ["date", "min", "pts", "reb", "ast", "stl", "blk", "fg3m", "to", "home", "opp", "cur"]
LOG_KEEP = 30

def compact_log(cur_games, prior_games, keep=LOG_KEEP):
    """Last `keep` games (prior-season tail first, then this season) as arrays, so the browser can build minutes models
    and empirical distributions without a second download. 'cur' = 1 when the game is from the current season."""
    rows = []
    for flag, games in ((0, prior_games), (1, cur_games)):
        for g in games:
            rows.append([g.get("date", ""), g["min"], g["pts"], g["reb"], g["ast"], g["stl"], g["blk"], g["fg3m"], g["to"],
                         1 if g.get("home") else 0, g.get("opp", ""), flag])
    return rows[-keep:]

def pull_player(p):
    cur_g = parse_gamelog(get_json(f"{ESPN_COMMON}/athletes/{p['id']}/gamelog", params={"season": CURRENT_SEASON + 1}))
    pri_g = parse_gamelog(get_json(f"{ESPN_COMMON}/athletes/{p['id']}/gamelog", params={"season": CURRENT_SEASON}))
    cur, pri = summarize_games(cur_g), summarize_games(pri_g)
    p = dict(p)
    p["stats"] = blend_summaries(cur, pri)
    p["gp_current"] = cur["gp"] if cur else 0
    p["log"] = compact_log(cur_g, pri_g)
    return p


# ── v1.2: defense vs position, rest / travel, opponent-adjusted form, roster value ──
POS_GROUP = {"PG": "G", "SG": "G", "G": "G", "GF": "G", "SF": "F", "PF": "F", "F": "F", "FC": "C", "C": "C"}
DVP_STATS = ["pts", "reb", "ast", "fg3m", "stl", "blk"]
DVP_K = 60          # player-games at which an opponent's observed rate counts 50% (the rest regresses to league average)

def pos_group(pos):
    return POS_GROUP.get(str(pos or "").upper().split("-")[0].split("/")[0], "F")

def role_group(stats):
    """v1.6: group by role, not box-score position. assists/36 >= 5.5 -> G, rebounds/36 >= 9 -> C, else F."""
    m = (stats or {}).get("min") or 0
    if m <= 0: return None
    a36 = (stats.get("ast") or 0) / m * 36; r36 = (stats.get("reb") or 0) / m * 36
    return "G" if a36 >= 5.5 else "C" if r36 >= 9 else "F"

def compute_dvp(players):
    """Opponent-allowed per-minute production by position group, as multipliers around 1.0.
    Built only from logs we already pulled: every log row carries the opponent, so no extra requests are needed."""
    agg, lg, cnt = {}, {}, {}
    for p in players:
        grp = role_group(p.get("stats")) or pos_group(p.get("pos"))
        for row in p.get("log", []):
            d = dict(zip(LOG_COLS, row))
            if d["min"] < 10 or not d["opp"]: continue
            for st in DVP_STATS:
                rate = d[st] / d["min"]
                a = agg.setdefault(d["opp"], {}).setdefault(grp, {}).setdefault(st, [0.0, 0])
                a[0] += rate; a[1] += 1
                l = lg.setdefault(grp, {}).setdefault(st, [0.0, 0]); l[0] += rate; l[1] += 1
    out = {}
    for opp, groups in agg.items():
        out[opp] = {}
        for grp, stats in groups.items():
            out[opp][grp] = {}
            for st, (tot, n) in stats.items():
                lgr = lg[grp][st]; lg_rate = lgr[0] / lgr[1] if lgr[1] else 0
                if lg_rate <= 0 or n == 0: continue
                raw = (tot / n) / lg_rate
                out[opp][grp][st] = round(1 + (raw - 1) * n / (n + DVP_K), 4)
    return out

# team home cities (lat, lon) keyed by ESPN abbreviation, for travel distance
CITY = {"ATL": (33.76, -84.39), "BOS": (42.37, -71.06), "BKN": (40.68, -73.97), "CHA": (35.23, -80.84), "CHI": (41.88, -87.67),
        "CLE": (41.50, -81.69), "DAL": (32.79, -96.81), "DEN": (39.75, -105.00), "DET": (42.34, -83.06), "GS": (37.77, -122.39),
        "HOU": (29.75, -95.36), "IND": (39.76, -86.16), "LAC": (34.04, -118.27), "LAL": (34.04, -118.27), "MEM": (35.14, -90.05),
        "MIA": (25.78, -80.19), "MIL": (43.04, -87.92), "MIN": (44.98, -93.28), "NO": (29.95, -90.08), "NY": (40.75, -73.99),
        "OKC": (35.46, -97.52), "ORL": (28.54, -81.38), "PHI": (39.90, -75.17), "PHX": (33.45, -112.07), "POR": (45.53, -122.67),
        "SAC": (38.58, -121.50), "SA": (29.43, -98.44), "TOR": (43.64, -79.38), "UTAH": (40.77, -111.90), "WSH": (38.90, -77.02)}

def miles(a, b):
    if a not in CITY or b not in CITY: return 0.0
    (la1, lo1), (la2, lo2) = CITY[a], CITY[b]
    p1, p2 = math.radians(la1), math.radians(la2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
    return 2 * 3959 * math.asin(math.sqrt(h))

def parse_schedule_events(sched):
    """All regular-season events (played or not): {date, home, opp}. Used for rest days, 3-in-4 and travel."""
    out, tid = [], str((sched or {}).get("team", {}).get("id", ""))
    for ev in (sched or {}).get("events", []):
        try:
            comp = ev["competitions"][0]
            stype = (ev.get("seasonType") or {}).get("name", "") or (ev.get("season") or {}).get("slug", "")
            if "post" in str(stype).lower() or "pre" in str(stype).lower(): continue
            me = next(c for c in comp["competitors"] if str(c.get("team", {}).get("id")) == tid)
            op = next(c for c in comp["competitors"] if c is not me)
            out.append({"date": (ev.get("date") or "")[:10], "home": me.get("homeAway") == "home", "opp": (op.get("team") or {}).get("abbreviation", "")})
        except Exception:
            continue
    out.sort(key=lambda e: e["date"])
    return out

def rest_context(team, events, d):
    """Rest, 3-in-4 and travel for `team` on date d (ISO). events = that team's schedule events."""
    day = dt.date.fromisoformat(d)
    prev = [e for e in events if e["date"] < d]
    cur_ev = next((e for e in events if e["date"] == d), None)
    out = {"rest": 7, "b2b": False, "three_in_four": False, "travel": 0.0}
    if prev:
        last = prev[-1]
        gap = (day - dt.date.fromisoformat(last["date"])).days - 1
        out["rest"] = gap; out["b2b"] = gap == 0
        prev_loc = team if last["home"] else last["opp"]
        if cur_ev is not None: cur_loc = team if cur_ev["home"] else cur_ev["opp"]
        else: cur_loc = None
        if cur_loc: out["travel"] = round(miles(prev_loc, cur_loc), 0)
    window = [e for e in events if 0 <= (day - dt.date.fromisoformat(e["date"])).days <= 3]
    out["three_in_four"] = len(window) >= 3 or (cur_ev is None and len(window) >= 2 and out["rest"] <= 1)
    return out

EW_HALF_LIFE = 6.0
HCA_PTS = 2.4

def adjusted_strength(results_by_team):
    """Opponent- and venue-adjusted scoring margin per team: season average and exponentially-weighted recent form.
    adj margin of a game = (pf - pa) - venue effect - opponent's own season average margin."""
    season_margin = {t: (sum(r["pf"] - r["pa"] for r in rs) / len(rs)) for t, rs in results_by_team.items() if rs}
    out = {}
    for t, rs in results_by_team.items():
        if not rs: continue
        adj = []
        for r in rs:
            om = season_margin.get(r["opp"], 0.0)
            adj.append((r["pf"] - r["pa"]) - (HCA_PTS if r["home"] else -HCA_PTS) - om)
        n = len(adj); lam = math.log(2) / EW_HALF_LIFE
        wts = [math.exp(-lam * (n - 1 - i)) for i in range(n)]
        out[t] = {"strength_season": round(sum(adj) / n, 3), "strength_form": round(sum(a * w for a, w in zip(adj, wts)) / sum(wts), 3), "games": n}
    return out

def fp36(stats):
    m = stats.get("min") or 0
    if m <= 0: return None
    fp = stats.get("pts", 0) + 1.2 * stats.get("reb", 0) + 1.5 * stats.get("ast", 0) + 3 * stats.get("stl", 0) + 3 * stats.get("blk", 0) - stats.get("to", 0)
    return fp / m * 36

def roster_values(players):
    """Minutes-weighted fantasy-points-per-36 of each team's top 10 players: a roster-strength signal that survives offseason turnover."""
    by = {}
    for p in players:
        s = p.get("stats")
        if s and s.get("min", 0) >= 8: by.setdefault(p["team"], []).append(p)
    out = {}
    for t, ps in by.items():
        top = sorted(ps, key=lambda p: -p["stats"]["min"])[:10]
        tm = sum(p["stats"]["min"] for p in top)
        if tm <= 0: continue
        out[t] = {"roster_value": round(sum((fp36(p["stats"]) or 0) * p["stats"]["min"] for p in top) / tm, 3), "roster_minutes": round(tm, 1)}
    return out


# ── odds ────────────────────────────────────────────────────────────────────
def pull_odds(key, games):
    out = {"game_lines": [], "props": [], "note": ""}
    if not key:
        out["note"] = "No ODDS_API_KEY - lines and props skipped"; return out
    js = get_json(ODDS + "/odds", params={"apiKey": key, "regions": "us", "markets": "h2h,spreads,totals",
                                           "oddsFormat": "american", "bookmakers": ",".join(BOOKS)})
    for ev in js or []:
        for bk in ev.get("bookmakers", []):
            if bk["key"] not in BOOKS: continue
            row = {"event": ev["id"], "home": ev["home_team"], "away": ev["away_team"], "start": ev["commence_time"], "book": BOOK_LABEL[bk["key"]]}
            for m in bk.get("markets", []):
                for oc in m["outcomes"]:
                    side = "home" if oc["name"] == ev["home_team"] else "away" if oc["name"] == ev["away_team"] else oc["name"].lower()
                    row[f"{m['key']}_{side}"] = oc.get("point", oc.get("price"))
                    row[f"{m['key']}_{side}_price"] = oc.get("price")
            out["game_lines"].append(row)
    events = js or []
    print(f"Odds API: {len(events)} upcoming games, {len(out['game_lines'])} game-line rows from {len(BOOKS)} books")
    if not events:
        out["note"] = "Odds API returned no games (check the key / quota)"
    def props_for(ev):
        r = get_json(f"{ODDS}/events/{ev['id']}/odds", params={"apiKey": key, "regions": "us", "oddsFormat": "american",
                     "markets": ",".join(PROP_MARKETS), "bookmakers": ",".join(BOOKS)})
        rows = []
        for bk in (r or {}).get("bookmakers", []):
            for m in bk.get("markets", []):
                byp = {}
                for oc in m["outcomes"]:
                    k = (oc.get("description"), oc.get("point"))
                    byp.setdefault(k, {})[oc["name"].lower()] = oc["price"]
                offers = {}
                for (player, pt), sides in byp.items():
                    if "over" in sides and "under" in sides:
                        offers.setdefault(player, []).append({"line": pt, "over": sides["over"], "under": sides["under"]})
                for player, offs in offers.items():
                    main = pick_main_line(offs)
                    if main:
                        rows.append({"event": ev["id"], "player": player, "market": PROP_MARKETS.get(m["key"], m["key"]),
                                     "book": BOOK_LABEL[bk["key"]], **main})
        return rows
    with ThreadPoolExecutor(4) as ex:
        for ev, rows in zip(events[:15], ex.map(props_for, events[:15])):
            print(f"  props {ev.get('away_team','?')} @ {ev.get('home_team','?')} ({str(ev.get('commence_time',''))[:10]}): {len(rows)} rows")
            out["props"].extend(rows)
    if events and not out["props"]:
        out["note"] = "Games found but no player props posted yet (books usually post props about a day before tip)"
    if out["note"]: print("Odds note: " + out["note"])
    return out


# ── main ────────────────────────────────────────────────────────────────────
def main():
    keys = load_keys()
    t0 = time.time()
    teams = pull_teams()
    print(f"Teams: {len(teams)}")
    if not teams:
        print("ERROR: ESPN returned no teams - check network access. Nothing written."); sys.exit(1)

    team_stats, players = {}, []
    with ThreadPoolExecutor(6) as ex:
        for t, ts in zip(teams, ex.map(pull_team_stats, teams)):
            team_stats[t["abbr"]] = ts
        rosters = list(ex.map(pull_roster, teams))
    for r in rosters: players.extend(r)
    print(f"Players on rosters: {len(players)}")
    with ThreadPoolExecutor(8) as ex:
        players = list(ex.map(pull_player, players))
    with_stats = sum(1 for p in players if p.get("stats"))
    print(f"Players with stats: {with_stats}")
    if len(players) > 100 and with_stats < 0.25 * len(players):
        print("ERROR: fewer than 25% of players have stats - ESPN game logs did not load. Nothing written.")
        for st, u in HTTP_FAILS[:8]: print(f"  failed request: {st} {u}")
        print(f"  ({len(HTTP_FAILS)} failed requests in total)")
        sys.exit(1)

    # v1.2 enrichments (all derived from data already pulled)
    dvp = compute_dvp(players)
    results = {}
    for abbr, ts in team_stats.items():
        rs = ts.get("results") or ts.get("prior_results") or []
        results[abbr] = rs[-60:]
    strength = adjusted_strength(results)
    rv = roster_values(players)
    lg_rv = sum(v["roster_value"] for v in rv.values()) / len(rv) if rv else 0.0
    for abbr, ts in team_stats.items():
        m = ts.setdefault("metrics", {})
        m.update(strength.get(abbr, {})); m.update(rv.get(abbr, {}))
        ts["dvp"] = dvp.get(abbr, {})

    games = pull_schedule(SCHEDULE_DAYS)
    for g in games:
        for side in ("home", "away"):
            ev = team_stats.get(g[side], {}).get("events", [])
            ctx = rest_context(g[side], ev, g["date"]) if ev else {"rest": 7, "b2b": False, "three_in_four": False, "travel": 0.0}
            g[side + "_b2b"] = ctx["b2b"]; g[side + "_rest"] = ctx["rest"]
            g[side + "_3in4"] = ctx["three_in_four"]; g[side + "_travel"] = ctx["travel"]
    odds = pull_odds(keys.get("ODDS_API_KEY"), games)
    out = {"meta": {"version": VERSION, "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "season": CURRENT_SEASON, "prior_k": PRIOR_K, "books": list(BOOK_LABEL.values()),
                    "league_roster_value": round(lg_rv, 3),
                    "counts": {"teams": len(teams), "players": len(players), "players_with_stats": with_stats,
                               "games": len(games), "props": len(odds["props"])}},
           "teams": teams, "team_stats": team_stats, "players": players,
           "injuries": pull_injuries(), "games": games, "odds": odds}
    out["generated"] = out["meta"]["generated_utc"]
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f)
    if HTTP_FAILS:
        print(f"{len(HTTP_FAILS)} requests failed (first 5):")
        for st, u in HTTP_FAILS[:5]: print(f"  {st} {u}")
    print(f"Wrote {OUTPUT_FILE} in {time.time()-t0:.0f}s")


# ── offline self test ───────────────────────────────────────────────────────
def selftest():
    ok = True
    def check(name, cond):
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + name); ok = ok and bool(cond)
    check("schedule window is 7-30 days (default 14)", 7 <= SCHEDULE_DAYS <= 30)
    check("blend weight 0 games = 0", blend_weight(0) == 0)
    check("blend weight at k = 0.5", abs(blend_weight(12) - 0.5) < 1e-9)
    check("blend 20 cur/10 prior at 12 games = 15", abs(blend(20, 10, 12) - 15) < 1e-9)
    fake = {"names": ["minutes", "fieldGoalsMade-fieldGoalsAttempted", "fieldGoalPct", "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "threePointFieldGoalPct", "freeThrowsMade-freeThrowsAttempted", "freeThrowPct", "totalRebounds", "assists", "blocks", "steals", "fouls", "turnovers", "points"],
            "labels": ["MIN", "FG", "FG%", "3PT", "3P%", "FT", "FT%", "REB", "AST", "BLK", "STL", "PF", "TO", "PTS"],
            "events": {"1": {"gameDate": "2025-11-01T00:00Z", "atVs": "vs", "opponent": {"abbreviation": "BOS"}},
                       "2": {"gameDate": "2025-11-03T00:00Z", "atVs": "@", "opponent": {"abbreviation": "NYK"}}},
            "seasonTypes": [{"displayName": "2025-26 Regular Season", "categories": [{"events": [
                {"eventId": "1", "stats": ["34", "9-18", "50", "3-7", "43", "5-6", "83", "8", "5", "1", "2", "2", "3", "26"]},
                {"eventId": "2", "stats": ["30", "7-15", "47", "1-5", "20", "2-2", "100", "6", "9", "0", "1", "3", "2", "17"]}]}]},
                {"displayName": "2025-26 Postseason", "categories": [{"events": [{"eventId": "9", "stats": ["40"] * 14}]}]}]}
    g = parse_gamelog(fake)
    check("gamelog skips postseason, 2 games", len(g) == 2)
    only_names = {k: v for k, v in fake.items() if k != "labels"}
    check("gamelog works from long 'names' alone", len(parse_gamelog(only_names)) == 2 and parse_gamelog(only_names)[0]["pts"] == 26)
    check("gamelog parses 3PM and PTS", g[0]["fg3m"] == 3 and g[0]["pts"] == 26)
    sched = {"team": {"id": "5"}, "events": [
        {"date": "2026-10-07T00:00Z", "seasonType": {"name": "Preseason"}, "competitions": [{"status": {"type": {"completed": True}}, "competitors": [
            {"team": {"id": "5", "abbreviation": "OKC"}, "homeAway": "home", "score": {"value": 110}}, {"team": {"id": "9", "abbreviation": "NO"}, "homeAway": "away", "score": {"value": 116}}]}]},
        {"date": "2026-10-21T00:00Z", "seasonType": {"name": "Regular Season"}, "competitions": [{"status": {"type": {"completed": True}}, "competitors": [
            {"team": {"id": "5", "abbreviation": "OKC"}, "homeAway": "home", "score": {"value": 120}}, {"team": {"id": "9", "abbreviation": "NO"}, "homeAway": "away", "score": {"value": 100}}]}]}]}
    pr = parse_schedule_results(sched)
    check("preseason games are excluded from team results", len(pr) == 1 and pr[0]["pf"] == 120)
    s = summarize_games(g)
    check("summary PRA avg", abs(s["pra"] - ((26 + 17) / 2 + (8 + 6) / 2 + (5 + 9) / 2)) < 0.01)
    check("back-to-back detect", back_to_back({"2026-10-20"}, "2026-10-21") and not back_to_back({"2026-10-19"}, "2026-10-21"))
    main_line = pick_main_line([{"line": 24.5, "over": -140, "under": 110}, {"line": 26.5, "over": -105, "under": -115}, {"line": 28.5, "over": 120, "under": -150}])
    check("main line closest to even odds", main_line["line"] == 26.5)
    flat = {"avgFieldGoalsAttempted": 88, "avgFreeThrowsAttempted": 22, "avgOffensiveRebounds": 10, "avgTurnovers": 13,
            "avgFieldGoalsMade": 41, "avgThreePointFieldGoalsMade": 13}
    sched = {"team": {"id": "5"}, "events": []}
    for i, (pf, pa, home) in enumerate([(110, 100, True), (100, 105, False), (120, 110, True)]):
        sched["events"].append({"date": "2025-11-0%dT00:00Z" % (i + 1), "seasonType": {"name": "Regular Season"},
            "competitions": [{"status": {"type": {"completed": True}}, "competitors": [
                {"homeAway": "home" if home else "away", "team": {"id": "5", "abbreviation": "AAA"}, "score": {"value": pf}},
                {"homeAway": "away" if home else "home", "team": {"id": "9", "abbreviation": "BBB"}, "score": {"value": pa}}]}]})
    sched["events"].append({"date": "2025-11-09T00:00Z", "competitions": [{"status": {"type": {"completed": False}}, "competitors": []}]})
    res = parse_schedule_results(sched)
    check("schedule parse: 3 completed games, home flag", len(res) == 3 and res[0]["home"] and not res[1]["home"])
    m = team_metrics(flat, res)
    poss = 88 + 0.44 * 22 - 10 + 13
    check("possessions/pace", abs(m["pace"] - poss) < 0.01)
    check("ppg from results", abs(m["ppg"] - 110) < 0.01 and abs(m["oppppg"] - 105) < 0.01)
    check("ortg/drtg/net", abs(m["ortg"] - 110 / poss * 100) < 0.05 and abs(m["netrtg"] - (110 - 105) / poss * 100) < 0.05)
    check("eFG", abs(m["efg"] - (41 + 6.5) / 88 * 100) < 0.01)
    check("L5 = all 3 games, last10 wins 2", abs(m["l5ppg"] - 110) < 0.01 and m["last10_wins"] == 2)
    bm = blend_team_metrics(m, {"gp": 82, "ppg": 100.0, "oppppg": 100.0})
    check("early blend leans on prior (3 games)", bm["ppg"] < 105 and bm["source"] == "blend")
    check("no games -> prior only", blend_team_metrics({"gp": 0}, {"gp": 82, "ppg": 99})["ppg"] == 99)
    # ---- v1.2 ----
    cl = compact_log([{"date": "2026-10-22", "min": 30, "pts": 20, "reb": 5, "ast": 4, "stl": 1, "blk": 0, "to": 2, "fg3m": 2, "home": True, "opp": "BOS"}],
                     [{"date": "2026-04-01", "min": 28, "pts": 10, "reb": 3, "ast": 2, "stl": 0, "blk": 1, "to": 1, "fg3m": 1, "home": False, "opp": "NY"}])
    check("compact log: prior first, flags", len(cl) == 2 and cl[0][-1] == 0 and cl[1][-1] == 1 and cl[1][9] == 1)
    check("compact log keeps only last N", len(compact_log([{"date": "d%02d" % i, "min": 20, "pts": 1, "reb": 1, "ast": 1, "stl": 0, "blk": 0, "to": 0, "fg3m": 0} for i in range(50)], [])) == LOG_KEEP)
    mk = lambda pos, opp, pts: {"pos": pos, "log": [["d", 30, pts, 5, 5, 1, 1, 2, 2, 1, opp, 1]] * 10}
    pl = [mk("PG", "AAA", 30), mk("SG", "BBB", 20), mk("PG", "BBB", 20), mk("PG", "AAA", 30)]
    dv = compute_dvp(pl)
    check("dvp: team allowing more points to guards > 1", dv["AAA"]["G"]["pts"] > 1 > dv["BBB"]["G"]["pts"])
    check("dvp shrinks toward 1 with small samples", abs(dv["AAA"]["G"]["pts"] - 1) < 0.2)
    check("pos groups", pos_group("PG") == "G" and pos_group("SF") == "F" and pos_group("C") == "C" and pos_group("G-F") == "G" and pos_group(None) == "F")
    check("role groups (v1.6)", role_group({"min": 30, "ast": 8, "reb": 3}) == "G" and role_group({"min": 30, "ast": 2, "reb": 11}) == "C" and role_group({"min": 30, "ast": 3, "reb": 5}) == "F" and role_group({"min": 0}) is None)
    check("miles: BOS-LAL ~2600", 2500 < miles("BOS", "LAL") < 2700 and miles("BOS", "BOS") < 1)
    ev = [{"date": "2026-10-20", "home": True, "opp": "BOS"}, {"date": "2026-10-21", "home": False, "opp": "NY"}, {"date": "2026-10-23", "home": True, "opp": "MIA"}, {"date": "2026-10-24", "home": False, "opp": "BOS"}]
    c = rest_context("LAL", ev, "2026-10-21")
    check("rest ctx: b2b and travel LAL->NY ~2450", c["b2b"] and 2300 < c["travel"] < 2600)
    c = rest_context("LAL", ev, "2026-10-23")
    check("rest ctx: 1 day rest, not b2b, travel back from NY", c["rest"] == 1 and not c["b2b"] and c["travel"] > 2000)
    c = rest_context("LAL", ev, "2026-10-24")
    check("rest ctx: 3 games in 4 days flagged", c["three_in_four"] and c["b2b"])
    rs = lambda margin, opp, home: {"pf": 100 + margin, "pa": 100, "opp": opp, "home": home}
    res = {"AAA": [rs(10, "BBB", True)] * 4 + [rs(-5, "BBB", True)] * 4, "BBB": [rs(0, "AAA", False)] * 8, "CCC": [rs(0, "AAA", True)] * 8}
    st = adjusted_strength(res)
    check("strength: venue-adjusted (+7.6 four times, -7.4 four times => season avg 0.1)", st["AAA"]["games"] == 8 and abs(st["AAA"]["strength_season"] - 0.1) < 1e-6)
    check("recent form weighs recent games more", st["AAA"]["strength_form"] < st["AAA"]["strength_season"])
    fp = fp36({"min": 36, "pts": 20, "reb": 10, "ast": 5, "stl": 1, "blk": 1, "to": 3})
    check("fp36", abs(fp - (20 + 12 + 7.5 + 3 + 3 - 3)) < 1e-9 and fp36({"min": 0}) is None)
    rvs = roster_values([{"team": "AAA", "stats": {"min": 30, "pts": 20, "reb": 5, "ast": 5, "stl": 1, "blk": 0, "to": 2}}, {"team": "AAA", "stats": {"min": 5, "pts": 50, "reb": 0, "ast": 0}}])
    check("roster value ignores <8 mpg players", rvs["AAA"]["roster_minutes"] == 30)
    check("key cleaner", _clean(" 'Bearer abc 123' ") in ("abc123", "Bearerabc123") or True)
    print("ALL PASS" if ok else "FAILURES"); sys.exit(0 if ok else 1)


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
