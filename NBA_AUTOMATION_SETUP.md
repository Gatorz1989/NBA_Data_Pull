# NBA Edge – GitHub automation setup (about 10 minutes, once)

**What it does:** every day the repo pulls fresh data, grades last night's picks, refits the model's calibration (including the market blend weights, with guardrails), and publishes it. Your NBA_Edge_Model_v1.1.html reads it from GitHub, so the model runs the same on any device. Every 15 minutes in the evening a light job records closing lines so the model can measure closing-line value (CLV).

## Steps
1. Create a **public** repo named `NBA_Data_Pull` (or any name) on your GitHub account.
2. Upload everything in this folder to the repo root, keeping the `.github/workflows/` folder: `nba_engine.js`, `nba_auto.js`, `nba_snapshot.py`, `nba_edge_data_pull.py`, `.gitignore`, the two workflow files.
3. Repo **Settings > Secrets and variables > Actions > New repository secret**: name `ODDS_API_KEY`, value = your Odds API key. (Never put the key in a file.)
4. Repo **Settings > Actions > General > Workflow permissions**: choose **Read and write permissions**, Save.
5. **Actions** tab > "NBA daily" > **Run workflow**. After ~2 minutes the repo gains `nba_model_data.json`, `nba_calibration.json`, `nba_summary.json`.
6. In the model, Data tab, enter the repo as `YourUser/NBA_Data_Pull`. The Backtest tab then shows "automatic - repo".

## What is public and what is private
- Public in the repo: calibration, change log, summary, graded results (written only after games finish), data file.
- Private: today's picks and the closing-line snapshots wait in the GitHub Actions cache (not committed) until games are final.

## Schedule
- Daily job: 15:00 UTC (10-11 am ET). Grades -> refits -> summary -> logs today's picks privately.
- Snapshot job: every 15 min, 12-midnight ET window. Game lines only when a game is within 50 min of tip, props once per game 20-75 min before tip. With no game in a window it makes **zero** Odds API calls.

## Guardrails on automatic changes
No setting moves until 10 graded days exist; each setting needs its own minimum sample; each run moves a setting by a small capped step, inside fixed min/max limits; fits are anchored to factory defaults. Pin your own values on the Backtest tab any time to override; the Adjustment Pack exports everything for review.

## Odds API credits
Daily pull plus snapshots: roughly 1 call per game window for lines and 1 per game for props, a few dozen credits on a full slate. Check the quota on your Odds API dashboard after the first week.

## Music (optional)
The `music/` folder holds the intro-video song and a `music.json` list. Upload the folder to the repo root. In the model's Export tab the cloud music list reads it (address `https://raw.githubusercontent.com/Gatorz1989/NBA_Data_Pull/main/music/`). Add more MP3s there any time and add them to `music.json`.

## Full-season backtest data (optional, new in v1.4)
The Backtest tab can replay whole seasons (2024-25, 2025-26) with real historical lines. The pulled data lives in the browser that pulled it.
To use it from any device (and keep it safe), do this once per season:
1. In the model: Backtest tab > pick the season > run steps 1 and 2 > **Options & data files > Save data file (.json.gz)**.
2. In your GitHub repo create a folder named `backtest` and upload the file (`NBA_BT_Data_2025-26.json.gz`) into it.
3. Any browser can then press **Load from repo (backtest/)** for 0 credits.
The file is a few MB. It is not used by the daily workflows.

## Schedule window (pull script v1.4)
The pull script now fetches 14 days of schedule by default. Set the `NBA_SCHEDULE_DAYS` environment variable (7-30) in the workflow to change it.

## v1.5 model settings
The engine's built-in settings are now the fitted v1.5 values (heavier market weights, per-market weights for props, a 2% minimum expected value, three-point % regression, a small late-season bench lift). The daily refit starts from these. If your repo has an `nba_calibration.json` from earlier, delete it once so the refit restarts from the v1.5 values. Replace `nba_engine.js` and `nba_auto.js` in the repo with the new copies.

## v1.6 model settings
The engine's built-in settings changed again: market weights x1.1 (capped at 0.97), last-5 minutes weight 0.20, defense-vs-position grouped by player role (playmaker / big / other) instead of the box-score position, and assists at shrink 0.30 / market weight 0.90 (almost no assist picks). Replace **all three** files in the repo: `nba_engine.js`, `nba_auto.js` and `nba_edge_data_pull.py` (the pull script now builds the defense-vs-position table by role, so the data file and the engine agree). Delete any old `nba_calibration.json` once so the daily refit restarts from the v1.6 values. The Unders-only and market-off switches live in the browser (Backtest tab) and are not part of the repo files.
