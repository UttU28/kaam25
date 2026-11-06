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
| **Today** | The day at a glance, and **Import plan**: drop the day's Excel / CSV (a plan with grid keys but no WO names gets names made from Grouping + date). Every WO is then looked up in TEMS Cloud (the project scrolled to the end, plus Assign) and marked In TEMS / On Assign / Not in TEMS; a plan's G23d that TEMS has as G23e is renamed to TEMS's spelling (everything else - number, date - must match). The WOs TEMS doesn't have: Copy for Excel or Download Excel, for the coordinators. **Check TEMS** runs it again. |
| **Start Ticket** | Start a WO as cloud or local, then TEMS Reserve + Open and back to Live Testing. First it reads which WO TEMS has active (what Control / Map show): a different one -> a pop-up ("X isn't running - Y is"), Cancel or make the ticket and leave TEMS; the same one -> no Reserve / Open, straight to Live Testing. Start Stationary does the same check (a different WO active: the pop-up, nothing pressed). The **To start** list is in today's map order: drag ⋮⋮ to reorder it - saved as today's "Your order" on Maps too (and Sheets follows it). |
| **Live Testing** | The WO you're driving, the TEMS map live, each phone's live RSRP / SINR / Band / BW / PCI, Set up desk, **Start Stationary** (reopens the phones, opens the WO from Assign if needed, presses play; turns into **Start Mobility** with a beep once stationary is done, then Submit / Discard / Suspend when TEMS finishes). A **test pop-up** follows the run - stationary (stay put), mobility (move: beep), results (Submit / Suspend / Discard on the pop-up) - with progress and a timer, and during stationary and mobility the TEMS map live in a box, zoomed to the grid (drag / pinch / zoom it by touch or mouse; Zoom to grid frames it again); hide it to a small pill. It reads the run from TEMS itself, so after an app restart mid-test it shows where you are. **Submit** = suspend, the TEMS picture, open the WO again and press play (warnings get OK), then TEMS's Results: if Submit / Discard / Suspend aren't there it reloads TEMS and looks again until they are, then presses **Submit**. The pop-up shows each step as it goes, then "Submitted in TEMS", with the result form (total / attempted / skipped / status / remarks, saved on the WO as you change it, like End Ticket) and a Close button once it's done. If a step fails it says which one and why (and whether the picture was saved), and asks whether you finished it in TEMS yourself: **Yes** marks it submitted so you can move on. **Discard / Suspend** = the WO gets tested again. Any of the three ends the run: Live Testing shows a short note instead of a test (also after a restart) until Start Stationary begins a new run. **Hotspot** = airplane toggle on both phones at the same time (that also turns the old hotspot off); once the first is back online it waits 2s more, then turns the hotspot on on the best of the phones back by then (a phone slow to load the network is left out). Full test / Airplane / Speed test with a pop-up per step - TMO 1 and TMO 2 run side by side (e.g. Airplane on one, Speed test on the other), each with its own log; Set up desk, Close phones, Hotspot and Test All use both phones, so they wait for those and the rest waits for them. **Test All** = airplane toggle on both phones at the same time, then the speed tests one phone after the other (NR first). |
| **End Ticket** | Ticket check, GridSummary copy, EQ uploads, report, the **TEMS picture** (required: from Live Testing's Submit, or click / drag / paste one in), then WhatsApp: the renamed CSV + the picture with the report as caption in the summary group, then "&lt;WO&gt; - Done" in the WO group. **End N Tickets** does every ready WO: all uploads, then the shares in one WhatsApp run (the group opened once, the WOs back to back - about 3-4 s each; each saved as shared the moment it's out; one already in the chat isn't sent again; a preview holding leftover files is discarded, never sent), then one "- Done" message. Keep Chrome visible while it shares - Chrome slows down a covered window. A WO shows here once TEMS made its GridSummary. |
| **Close Ticket** | The TechInsights close steps for a cloud ticket (PASSED, SKIPPED or FAILED), once its End is finished. **Close N Tickets** closes every ready one in turn; one that stops isn't marked closed and the run goes on with the next. |

**Bulk runs and problems:** End Tickets and Close Tickets save where each WO stopped (Ticket ID, GridSummary, EQ3, EQ6, WhatsApp, or a close step) and why. A WO is marked ended only when every End step worked (the share too), and closed only when all 3 close steps are done; one that stopped isn't shared or closed. Both pages list them under **Needs redo** - Redo one, or Redo all, or **Do later**: off the list and the bulk runs, tagged End later / Close later in Records (filter **Do later**), where **End now** / **Close now** brings it back and opens the page with it.
| **Maps** | Today's (or tomorrow's) WOs on the map with the shortest route; the order you set is the order Start lists them. |
| **Sheets** | Today's tables for Excel; **Send to WO group** sends the done list to WhatsApp. A WO moves to Coordinator data (done) once it's ended - or as soon as Submit went through in TEMS and you pressed Close on Live Testing's Submit pop-up, before End Ticket's uploads. |
| **Records** | Everything saved. Tick pending WOs to **Move to today**, or (all already today's) **Move to tomorrow** to plan the next day tonight. |
| **Connection** | A QR code of this PC's address on the WiFi it's on (`http://<IPv4>:<port>`): scan it with a phone or tablet on the same WiFi to open the app. Copy link, other addresses if the PC has more than one; a new WiFi shows its new address by itself. |
| **Settings** | Every `.env` value (saved, then the app restarts) and **Theme**: Classic, Retro (phosphor terminal) or Aurora (glass under northern lights) - all dark, changes at once, remembered per browser. |

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
4. In the app: **Settings → Phones**: paste phone 1's serial into **TMO 1 serial** and phone 2's
   into **TMO 2 serial** → Save. The phones must be named TMO 1 / TMO 2 in Vysor (rename them
   there if needed). TMO 1 goes on the left.
5. On each phone: a home-screen shortcut to **speedtest.net** named **Speedtest** (Chrome → ⋮ →
   Add to Home screen), and a swipe lock or none (a PIN can't be unlocked from the PC).
6. **Live Testing → Set up desk**: unlocks the phones, opens Service Mode (*#0011#) on top and
   Speedtest below at 70:30, opens them in Vysor and places Chrome left, phones right. Each phone
   card should show its network and live numbers.

Split size, airplane seconds, the Speedtest icon name and a custom adb are in **Settings → Phones**.

## Notes

- Settings live in `.env` (see `.env.example`); the Settings page edits it for you.
- The app only reads from TEMS (map and state). It clicks in TEMS only when you ask: Start's
  Reserve + Open, and Live Testing's **Start Stationary** and Submit / Discard / Suspend (play, only when TEMS shows it ready).
  When play can't be pressed because TEMS says it's offline / not connected to TEMS Cloud (its
  status text, or "please log in" / "session expired"), it goes to Cloud, logs in (Chrome's saved
  password), comes back to Control and presses play once TEMS has the WO ready.
  The same TEMS Cloud login check runs wherever a step needs Cloud: starting a ticket (always first),
  a WO missing on Assign or its Open greyed out (Start Stationary, Submit's picture and re-open), and
  pressing Submit on Results - logged out -> logs in and tries that step once more.
- Open the app on a tablet on the same WiFi at `http://<this PC's IP>:5000` (Settings → Open on WiFi).
- Your records (`tickets.json`), `backups/`, `maps/`, `pictures/` (one TEMS picture per WO, its path saved on the WO) and logs stay on your PC - they're not in git.
- **Teams button** (top of every page, left of the search): opens your Teams link in a new tab - set it in **Settings → Web pages → Teams link** (`TEAMS_URL`); empty hides it.
