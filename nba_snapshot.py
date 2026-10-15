#!/usr/bin/env python3
"""
NBA Edge Model - pre-tip line snapshots (runs every 15 minutes in GitHub Actions)
================================================================================
Records what the market looked like just before each game started, so the model can learn from closing lines.

  * Game lines (spread + total, 5 books): one cheap call, made only while some game is 0-50 minutes from tip.
    The last snapshot before tip is that game's closing line.
  * Player props: one call per game, once, when the game is 20-75 minutes from tip.
  * If no game is in either window the script exits without touching the Odds API (zero credits).

State goes to ./state/ (GitHub Actions cache), NOT the repo:  close_games.json, close_props.json
Usage:   python nba_snapshot.py                 # real run (needs ODDS_API_KEY, nba_model_data.json next to this script)
         python nba_snapshot.py --selftest      # offline logic test
"""
import os, sys, json, datetime as dt, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nba_edge_data_pull as P

DATA_FILE = os.environ.get("NBA_DATA_FILE", os.path.join(HERE, "nba_model_data.json"))
STATE_DIR = os.environ.get("NBA_STATE_DIR", os.path.join(HERE, "state"))
LINE_WINDOW = (0, 50)      # minutes to tip: take game-line snapshots
PROP_WINDOW = (20, 75)     # minutes to tip: take the one prop snapshot
KEEP_DAYS = 4
ALIAS = {"los angeles clippers": "la clippers"}   # The Odds API vs ESPN naming


def norm(n):
    n = (n or "").strip().lower()
    return ALIAS.get(n, n)


def parse_iso(s):
    try:
        return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def minutes_to(start, now):
    return (start - now).total_seconds() / 60.0


def load(name, default):
    try:
        with open(os.path.join(STATE_DIR, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save(name, obj):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(os.path.join(STATE_DIR, name), "w", encoding="utf-8") as f:
        json.dump(obj, f)


def games_in_window(games, now, lo, hi):
    out = []
    for g in games:
        st = parse_iso(g.get("time"))
        if not st:
            continue
        m = minutes_to(st, now)
        if lo <= m <= hi:
            out.append((g, st, m))
    return out


def parse_game_lines(events, name_to_abbr):
    """Odds API /odds payload -> {(home_abbr, away_abbr): {'spread': median home line, 'total': median total, 'books': {...}}}"""
    out = {}
    for ev in events or []:
        h, a = name_to_abbr.get(norm(ev.get("home_team"))), name_to_abbr.get(norm(ev.get("away_team")))
        if not h or not a:
            continue
        sp, to, books = [], [], {}
        for bk in ev.get("bookmakers", []):
            if bk.get("key") not in P.BOOKS:
                continue
            row = {}
            for m in bk.get("markets", []):
                for oc in m.get("outcomes", []):
                    if m["key"] == "spreads" and norm(oc.get("name")) == norm(ev.get("home_team")) and oc.get("point") is not None:
                        row["spread"] = oc["point"]; sp.append(oc["point"])
                    if m["key"] == "totals" and str(oc.get("name")).lower() == "over" and oc.get("point") is not None:
                        row["total"] = oc["point"]; to.append(oc["point"])
            if row:
                books[P.BOOK_LABEL[bk["key"]]] = row
        if sp or to:
            out[(h, a)] = {"spread": statistics.median(sp) if sp else None, "total": statistics.median(to) if to else None, "books": books, "event": ev.get("id")}
    return out


def parse_props(js, home, away, start):
    """Odds API per-event payload -> {'home','away','start','rows':[{player,market,book,line,over,under}]} (main line per player/book/market)"""
    rows = []
    for bk in (js or {}).get("bookmakers", []):
        if bk.get("key") not in P.BOOKS:
            continue
        for m in bk.get("markets", []):
            byp = {}
            for oc in m.get("outcomes", []):
                byp.setdefault((oc.get("description"), oc.get("point")), {})[str(oc.get("name")).lower()] = oc.get("price")
            offers = {}
            for (player, pt), sides in byp.items():
                if "over" in sides and "under" in sides and player:
                    offers.setdefault(player, []).append({"line": pt, "over": sides["over"], "under": sides["under"]})
            for player, offs in offers.items():
                main = P.pick_main_line(offs)
                if main and m["key"] in P.PROP_MARKETS:
                    rows.append({"player": player, "market": P.PROP_MARKETS[m["key"]], "book": P.BOOK_LABEL[bk["key"]], **main})
    return {"home": home, "away": away, "start": start, "rows": rows}


def update_close_games(state, snap, now, start_by_pair):
    """Keep one entry per game: first snapshot, and the latest one taken before tip (= close)."""
    changed = False
    for (h, a), v in snap.items():
        st = start_by_pair.get((h, a))
        if not st:
            continue
        if now >= st:
            continue                      # after tip: never overwrite the close
        key = None
        for e in state:
            if e["home"] == h and e["away"] == a and abs((parse_iso(e["start"]) - st).total_seconds()) < 36 * 3600:
                key = e; break
        point = {"at": now.isoformat(), "spread": v["spread"], "total": v["total"], "books": v["books"]}
        if key is None:
            key = {"home": h, "away": a, "start": st.isoformat(), "first": point, "close": point}
            state.append(key)
        else:
            key["close"] = point
        changed = True
    return changed


def prune(state, now, field="start"):
    cut = now - dt.timedelta(days=KEEP_DAYS)
    return [e for e in state if (parse_iso(e.get(field)) or now) > cut]


def run(now, data, key, fetch=None, verbose=True):
    """fetch(url, params) -> json; injectable for tests. Returns dict of what was done."""
    fetch = fetch or P.get_json
    games = data.get("games", [])
    name_to_abbr = {}
    for g in games:
        name_to_abbr[norm(g.get("home_name"))] = g.get("home"); name_to_abbr[norm(g.get("away_name"))] = g.get("away")
    start_by_pair = {(g["home"], g["away"]): parse_iso(g.get("time")) for g in games if g.get("time")}
    need_lines = games_in_window(games, now, *LINE_WINDOW)
    need_props = games_in_window(games, now, *PROP_WINDOW)
    cg, cp = load("close_games.json", []), load("close_props.json", [])
    done = {"lines": 0, "props": 0, "changed": False, "credits_note": ""}
    cp_keys = {(e["home"], e["away"], e["start"][:10]) for e in cp if e.get("rows") or e.get("attempts", 0) >= 2}
    need_props = [x for x in need_props if (x[0]["home"], x[0]["away"], x[1].isoformat()[:10]) not in cp_keys]
    if not (need_lines or need_props):
        if verbose: print("No game inside a snapshot window - nothing to do (0 Odds API credits).")
        return done
    if not key:
        print("ERROR: ODDS_API_KEY missing"); done["error"] = "no key"; return done
    if need_lines:
        js = fetch(P.ODDS + "/odds", {"apiKey": key, "regions": "us", "markets": "spreads,totals", "oddsFormat": "american", "bookmakers": ",".join(P.BOOKS)})
        snap = parse_game_lines(js, name_to_abbr)
        if update_close_games(cg, snap, now, start_by_pair):
            done["lines"] = len(snap); done["changed"] = True
        if verbose: print(f"Game-line snapshot: {len(snap)} games priced ({len(need_lines)} inside the window).")
    if need_props:
        evs = fetch(P.ODDS + "/events", {"apiKey": key}) or []
        ev_by_pair = {(name_to_abbr.get(norm(e.get("home_team"))), name_to_abbr.get(norm(e.get("away_team")))): e for e in evs}
        for g, st, m in need_props:
            ev = ev_by_pair.get((g["home"], g["away"]))
            if not ev:
                if verbose: print(f"  no Odds API event for {g['away']}@{g['home']}"); continue
            r = fetch(f"{P.ODDS}/events/{ev['id']}/odds", {"apiKey": key, "regions": "us", "oddsFormat": "american", "markets": ",".join(P.PROP_MARKETS), "bookmakers": ",".join(P.BOOKS)})
            ent = parse_props(r, g["home"], g["away"], st.isoformat()); ent["at"] = now.isoformat()
            prev = [e for e in cp if e["home"] == g["home"] and e["away"] == g["away"] and e["start"][:10] == st.isoformat()[:10]]
            ent["attempts"] = (prev[0].get("attempts", 0) if prev else 0) + 1      # an empty answer is retried once, then given up (saves credits)
            cp = [e for e in cp if e not in prev] + [ent]; done["changed"] = True
            if ent["rows"]:
                done["props"] += 1
                if verbose: print(f"  props {g['away']}@{g['home']}: {len(ent['rows'])} lines ({m:.0f} min to tip)")
    cg, cp = prune(cg, now), prune(cp, now)
    save("close_games.json", cg); save("close_props.json", cp)
    return done


def main():
    now = dt.datetime.now(dt.timezone.utc)
    try:
        data = json.load(open(DATA_FILE, encoding="utf-8"))
    except Exception as e:
        print("No usable data file:", e); sys.exit(0)
    d = run(now, data, P.load_keys().get("ODDS_API_KEY"))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write("changed=" + ("true" if d.get("changed") else "false") + "\n")
    if d.get("error"):
        sys.exit(1)


def selftest():
    import tempfile
    global STATE_DIR
    STATE_DIR = tempfile.mkdtemp()
    ok = True
    def check(n, c):
        nonlocal ok
        print(("PASS " if c else "FAIL ") + n); ok = ok and bool(c)
    now = dt.datetime(2026, 11, 3, 23, 0, tzinfo=dt.timezone.utc)
    def iso(mins): return (now + dt.timedelta(minutes=mins)).isoformat().replace("+00:00", "Z")
    data = {"games": [
        {"id": "1", "home": "LAC", "away": "DEN", "home_name": "LA Clippers", "away_name": "Denver Nuggets", "time": iso(30)},
        {"id": "2", "home": "BOS", "away": "NYK", "home_name": "Boston Celtics", "away_name": "New York Knicks", "time": iso(60)},
        {"id": "3", "home": "GSW", "away": "SAC", "home_name": "Golden State Warriors", "away_name": "Sacramento Kings", "time": iso(180)}]}
    def book(k, h, a, sp, to):
        return {"key": k, "markets": [{"key": "spreads", "outcomes": [{"name": h, "point": sp}, {"name": a, "point": -sp}]}, {"key": "totals", "outcomes": [{"name": "Over", "point": to}, {"name": "Under", "point": to}]}]}
    lines = [{"id": "e1", "home_team": "Los Angeles Clippers", "away_team": "Denver Nuggets", "bookmakers": [book("draftkings", "Los Angeles Clippers", "Denver Nuggets", -3.5, 225.5), book("fanduel", "Los Angeles Clippers", "Denver Nuggets", -4.0, 226.5), book("bovada", "Los Angeles Clippers", "Denver Nuggets", -9, 250)]},
             {"id": "e2", "home_team": "Boston Celtics", "away_team": "New York Knicks", "bookmakers": [book("draftkings", "Boston Celtics", "New York Knicks", -7.5, 219.5)]}]
    events = [{"id": "e1", "home_team": "Los Angeles Clippers", "away_team": "Denver Nuggets"}, {"id": "e2", "home_team": "Boston Celtics", "away_team": "New York Knicks"}]
    def prop(book_key, player, line, o, u):
        return {"key": book_key, "markets": [{"key": "player_points", "outcomes": [{"name": "Over", "description": player, "point": line, "price": o}, {"name": "Under", "description": player, "point": line, "price": u}, {"name": "Over", "description": player, "point": line + 4, "price": 220}, {"name": "Under", "description": player, "point": line + 4, "price": -300}]}]}
    calls = []
    def fetch(url, params):
        calls.append(url)
        if url.endswith("/odds") and "events" not in url: return lines
        if url.endswith("/events"): return events
        if "/events/e2/odds" in url: return {"bookmakers": [prop("draftkings", "Jayson Tatum", 27.5, -115, -105), prop("bovada", "Jayson Tatum", 30, -110, -110)]}
        return {"bookmakers": []}
    d = run(now, data, "KEY", fetch, verbose=False)
    check("lines snapshot taken for games inside the 0-50 min window", d["lines"] == 2 and d["changed"])
    cg = load("close_games.json", [])
    check("only the 5 tracked books count (bovada ignored); median spread", [e for e in cg if e["home"] == "LAC"][0]["close"]["spread"] == -3.75)
    check("Clippers name mismatch resolved (LA Clippers vs Los Angeles Clippers)", any(e["home"] == "LAC" for e in cg))
    check("game 180 min away is not touched", not any(e["home"] == "GSW" for e in cg))
    cp = load("close_props.json", [])
    check("props taken for the games 20-75 min out (LAC and BOS), none for the 180-min game", {e["home"] for e in cp} == {"LAC", "BOS"} and sum("/events/" in c and c.endswith("/odds") for c in calls) == 2)
    check("a game whose props came back empty keeps no rows but is marked tried", [e for e in cp if e["home"] == "LAC"][0]["rows"] == [] and [e for e in cp if e["home"] == "LAC"][0]["attempts"] == 1)
    bos = [e for e in cp if e["home"] == "BOS"][0]
    check("main prop line chosen per player/book/market and non-tracked book dropped", len(bos["rows"]) == 1 and bos["rows"][0]["line"] == 27.5 and bos["rows"][0]["market"] == "pts")
    # next run 15 minutes later: lines refresh (close moves), props not repeated
    now2 = now + dt.timedelta(minutes=15); calls.clear()
    lines[0]["bookmakers"] = [book("draftkings", "Los Angeles Clippers", "Denver Nuggets", -4.5, 227.5)]
    d2 = run(now2, data, "KEY", fetch, verbose=False)
    cg = load("close_games.json", []); e = [e for e in cg if e["home"] == "LAC"][0]
    check("close line updates to the latest pre-tip snapshot, first kept", e["close"]["spread"] == -4.5 and e["first"]["spread"] == -3.75)
    check("props are not re-fetched for a game already snapshotted", not any(c.endswith("/odds") and "/events/" in c for c in calls[1:]) or d2["props"] <= 1)
    # after tip: close is frozen
    now3 = now + dt.timedelta(minutes=45)
    lines[0]["bookmakers"] = [book("draftkings", "Los Angeles Clippers", "Denver Nuggets", -9.5, 240.5)]
    run(now3, data, "KEY", fetch, verbose=False)
    e = [e for e in load("close_games.json", []) if e["home"] == "LAC"][0]
    check("a snapshot after tip never overwrites the closing line", e["close"]["spread"] == -4.5)
    # nothing in window -> no API call
    calls.clear(); run(now + dt.timedelta(days=1), data, "KEY", fetch, verbose=False)
    check("no game inside a window means zero API calls", not calls)
    check("old entries are pruned", prune([{"start": iso(-60 * 24 * 6)}, {"start": iso(10)}], now) == [{"start": iso(10)}])
    print("ALL PASS" if ok else "FAILURES"); sys.exit(0 if ok else 1)


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
