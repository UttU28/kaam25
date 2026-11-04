# Kaam25: 13 Bhai gaadi chalayega

Drive-test ticket desk: start, test, end, close and share LM tickets (TechInsights, ActixOne,
WhatsApp, TEMS, the test phones) from one web page.

## 1. Install Python

Get **Python 3.10+** from https://www.python.org/downloads/ and tick **"Add python.exe to PATH"**
in the installer.

## 2. Run it

**Easy way:** double-click **`runWeb.bat`**. That's it.
The first time it sets itself up and opens `.env` in Notepad - fill in your values, save,
and double-click `runWeb.bat` again. The app opens at http://127.0.0.1:5000.
Keep its window open while you work; close it to stop.

**Or in a terminal** (in this folder):

```bash
python -m venv venv
```

```bash
venv\Scripts\activate
```

```bash
pip install -r requirements.txt
```

```bash
copy .env.example .env
```

```bash
python -m web.server
```

Fill in `.env` before the last command. After that, change settings on the app's **Settings**
page (it saves `.env` and restarts the app).

## 3. Chrome extension (once)

`chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the
`chromeExtension` folder. It updates itself when the app's files change.

In that Chrome: be signed in to TechInsights, ActixOne and **WhatsApp Web**, and have
**TEMS Paragon** open at http://localhost:8080 on testing days.

## 4. The pages

| Page | What it does |
|---|---|
| **Start Ticket** | Import the day's plan (Excel / CSV - a plan with grid keys but no WO names gets names made from Grouping + date), start a WO as cloud or local, then TEMS Reserve + Open and back to Live Testing. |
| **Live Testing** | The WO you're driving, the TEMS map live, each phone's live RSRP / SINR / Band / BW / PCI, Set up desk, **Start ticket** (presses play on TEMS Control), Full test / Airplane / Speed test with a pop-up per step. |
| **End Ticket** | Ticket check, GridSummary copy, EQ uploads, report, then WhatsApp: the summary group, then "&lt;WO&gt; - Done" in the WO group. **End N Tickets** does every ready WO: all uploads, then the shares one by one, then one "- Done" message. A WO shows here once TEMS made its GridSummary. |
| **Close Ticket** | The TechInsights close steps for a PASSED ticket. |
| **Maps** | Today's (or tomorrow's) WOs on the map with the shortest route; the order you set is the order Start lists them. |
| **Sheets** | Today's tables for Excel; **Send to WO group** sends the done list to WhatsApp. |
| **Records** | Everything saved. Tick pending WOs to **Move to today**, or (all already today's) **Move to tomorrow** to plan the next day tonight. |

In every WO box: the copy icon copies the preview (WO / Grid Key / Location), the **QR icon** shows
the WO's Google Maps link (`https://www.google.com/maps?q=<lat>,<lon>`) as a QR code - scan it with
a phone to open the spot, even with little or no internet - with the link, **Copy link** and the
lat / long. With **Settings → Web pages → Use Apeksha** on (off by default), the QR icon posts that
link to Apeksha instead. The arrow opens the day's list.

## 5. Your own test phones (TMO 1 / TMO 2)

Live Testing drives two Samsung phones over USB. Each phone has its own serial, so set yours once:

1. **Vysor** on the PC (it brings `adb`). On each phone: Settings → About phone → Software
   information → tap **Build number** 7 times → Developer options → **USB debugging** on.
2. Plug the phones in by USB and tap **Allow** (tick *Always allow from this computer*).
3. Get the serials: open Vysor (it lists them) or run `adb devices`.
4. In the app: **Settings → Phones → Test phones**:
   `TMO 1=<serial of phone 1>,TMO 2=<serial of phone 2>` → Save. The names must match the
   phone names in Vysor (rename them in Vysor if needed). The first one goes on the left.
5. On each phone: a home-screen shortcut to **speedtest.net** named **Speedtest** (Chrome → ⋮ →
   Add to Home screen), and a swipe lock or none (a PIN can't be unlocked from the PC).
6. **Live Testing → Set up desk**: unlocks the phones, opens Service Mode (*#0011#) on top and
   Speedtest below at 70:30, opens them in Vysor and places Chrome left, phones right. Each phone
   card should show its network and live numbers.

Split size, airplane seconds, the Speedtest icon name and a custom adb are in **Settings → Phones**.

## Notes

- Settings live in `.env` (see `.env.example`); the Settings page edits it for you.
- The app only reads from TEMS (map and state). It clicks in TEMS only when you ask: Start's
  Reserve + Open, and Live Testing's **Start ticket** (play, only when TEMS shows it ready).
- Open the app on a tablet on the same WiFi at `http://<this PC's IP>:5000` (Settings → Open on WiFi).
- Your records (`tickets.json`), `backups/`, `maps/` and logs stay on your PC - they're not in git.
