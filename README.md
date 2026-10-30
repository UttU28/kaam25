# Kaam25

Drive-test ticket desk for team N071: start, end, close and share LM tickets
(TechInsights, ActixOne, WhatsApp) from one place.

## Run it

Double-click **`runWeb.bat`**. It opens http://127.0.0.1:5000 in your browser
(or the next free port, which it prints). Keep that window open while you work.

Only run one of the web app and the desktop app at a time. Both talk to the Chrome
extension on port 47821.

## Pages

| Page | What it does |
|---|---|
| **Today** | The day's cloud ticket, counts, every ticket touched today, with quick End / Close buttons |
| **Start Ticket** | Cloud start (creates the real TechInsights ticket, once a day) or Local start (`LM_N_MMDDYYYY`, no ticket). Import the day's plan (Excel/CSV, only your team's rows), pick from "To start" |
| **End Ticket** | Find + verify the ticket (cloud) or skip it (local), copy GridSummary, upload EQ3/EQ6, report with Save / Copy / WhatsApp / Done |
| **Close Ticket** | Run the 3 TechInsights close steps for a PASSED cloud ticket |
| **Records** | Search and filter everything, edit status / grids / remarks, share, move to today, delete |
| **Settings** | What `.env` is set to, file locations, Chrome extension connection |

`Ctrl+K` finds any WO, grid key, Ticket ID or EQ Job ID. `Ctrl+Enter` on End Ticket copies the report.

## Folders

```
kaam/             core: records (ticketStore), sheet import, Chrome bridge, TechInsights /
                  ActixOne / WhatsApp / Apeksha automation, and the Start/End/Close workflows
web/              the web app: server.py (Flask API), jobs.py (background runs), static/ (UI)
desktop/app.py    the older desktop window (runDesktop.bat)
chromeExtension/  the Kaam25 Helper extension Chrome loads (don't move this folder)
maps/             route-map HTML files
.env              all settings and paths
tickets.json      your records (deleted ones: tickets.deleted.json)
backups/          older copies of tickets.json
```

## Setup on a new PC

```
python -m venv venv
venv\Scripts\pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in your values. Then load `chromeExtension` in Chrome
(chrome://extensions → Developer mode → Load unpacked).

`.env`, `tickets*.json`, `backups/`, `maps/` and the debug log hold your own data and are
kept out of git (see `.gitignore`).
