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
