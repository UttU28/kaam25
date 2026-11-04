"""Kaam25 web app: a JSON API over kaam/ plus the single-page UI in web/static.

Run:  runWeb.bat   (or: venv\\Scripts\\python -m web.server)
Opens on http://127.0.0.1:5000 (or the next free port). Also reachable from the same WiFi at http://<this PC's IP>:<port> while LAN_ACCESS is on (default).
"""

import os
import socket
import sys
import tempfile
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path

projectDir = Path(__file__).resolve().parent.parent
if str(projectDir) not in sys.path:
    sys.path.insert(0, str(projectDir))  # so "python web/server.py" works too

from flask import Flask, jsonify, request, send_from_directory  # noqa: E402

from kaam import config, envSettings, workflows  # noqa: E402
from kaam.chromeBridge import ChromeBridgeError, bridgeStatus, openInChrome, startBridge, stopAll  # noqa: E402
from kaam.gridSummary import buildFolderName, showInExplorer  # noqa: E402
from kaam.sheetImport import SheetImportError  # noqa: E402
from kaam.temsParagon import actions as temsActions, runTems  # noqa: E402
from kaam.ticketLookup import currentDriveShift  # noqa: E402
from kaam.ticketStore import (TicketStoreError, cloudStartToday, deleteNotStarted, deleteRecord, fileStamp,  # noqa: E402
                              getRecord, isLocalStart, localTicketId, markDone, moveToToday, nextLocalNumber, notStartedRecords,
                              openTicketsToday, renameWo, searchRecords, woKey)
from kaam.workflows import WorkflowError  # noqa: E402

from web.jobs import getJob, listJobs, startJob  # noqa: E402

staticDir = Path(__file__).resolve().parent / "static"
bootedAt = datetime.now().isoformat(timespec="seconds") + f".{os.getpid()}"
app = Flask(__name__, static_folder=None)
app.json.ensure_ascii = False
app.json.sort_keys = False
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # sheets only


# ---------- helpers ----------
def fail(message, status=400):
    return jsonify({"error": str(message)}), status


@app.errorhandler(Exception)
def onError(error):
    if hasattr(error, "code") and hasattr(error, "description"):  # werkzeug HTTP errors (404...)
        return fail(error.description, error.code)
    if isinstance(error, (WorkflowError, ChromeBridgeError, SheetImportError, TicketStoreError)):
        return fail(error)  # an expected "can't do that" - shown to you as is
    app.logger.exception(error)
    return fail(str(error) or error.__class__.__name__, 500)


def body():
    return request.get_json(silent=True) or {}


def parseTime(isoText):
    try:
        return datetime.fromisoformat(isoText)
    except (TypeError, ValueError):
        return None


def recordDay(record):
    """The day a ticket belongs to: completed, else started, else created. "Move to today" can
    push it later (never earlier)."""
    day = None
    for key in ("endedAt", "startedAt", "createdAt", "updatedAt"):
        day = parseTime(record.get(key))
        if day:
            break
    moved = parseTime(record.get("movedToDayAt"))
    if moved and (not day or moved > day):
        day = moved
    return day.isoformat(timespec="seconds") if day else None


def progressOf(record):
    if record.get("closedAt"):
        return "closed"
    if record.get("endedAt"):
        return "completed"
    if record.get("startedAt"):
        return "inProgress"
    if record.get("importedAt"):
        return "notStarted"
    return "other"


def summary(record):
    """A record as the lists need it (no history / report text)."""
    lat, lon = workflows.latLong(record)
    return {
        "key": woKey(record.get("wo")), "wo": record.get("wo"), "cluster": record.get("cluster"),
        "ticketId": record.get("ticketId"), "startType": record.get("startType"),
        "gridKey": record.get("gridKey"), "gridCount": record.get("gridCount"),
        "eq3": record.get("eq3"), "eq6": record.get("eq6"), "status": record.get("status"),
        "progress": progressOf(record), "day": recordDay(record),
        "startedAt": record.get("startedAt"), "endedAt": record.get("endedAt"),
        "closedAt": record.get("closedAt"), "importedAt": record.get("importedAt"),
        "updatedAt": record.get("updatedAt"), "whatsappSentAt": record.get("whatsappSentAt"),
        "hasLocation": bool(lat and lon), "readyToClose": workflows.isReadyToClose(record),
    }


def detail(record):
    """Everything a page shows for one record."""
    lat, lon = workflows.latLong(record)
    data = {key: value for key, value in record.items() if key not in ("history", "eqTabTokens")}
    data.update(summary(record))
    data.update({
        "lat": lat, "long": lon, "location": f"{lat}, {lon}" if lat or lon else "",
        "isLocal": isLocalStart(record),
        # TEMS has made the WO's result file (GridSummary): it's done driving
        "resultReady": bool(record.get("startedAt")) and readyToEnd(record),
        "report": workflows.reportFromRecord(record) if record.get("startedAt")
        else workflows.formatLocationPreview(record.get("wo", ""), record),
        "reportFields": workflows.reportFieldsFromRecord(record),
        "locationPreview": workflows.formatLocationPreview(record.get("wo", ""), record),
        "folderName": record.get("folderName") or buildFolderName(record.get("wo", "")),
        "close": workflows.closeState(record),
        "history": list(reversed(record.get("history") or [])),
        "previousTickets": record.get("previousTickets") or [],
    })
    return data


def requireRecord(wo):
    record = getRecord(wo)
    if not record:
        raise WorkflowError("Not in Records.")
    return record


# ---------- pages ----------
@app.get("/")
def index():
    response = send_from_directory(staticDir, "index.html")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/static/<path:path>")
def static(path):
    response = send_from_directory(staticDir, path)
    response.headers["Cache-Control"] = "no-cache"
    return response


# ---------- state ----------
@app.get("/api/state")
def state():
    records = searchRecords("")
    today = datetime.now().date().isoformat()
    cloud = cloudStartToday()
    # Tickets of today (started / ended / moved here); imported-but-not-started ones are under "To start".
    todays = [r for r in records if (recordDay(r) or "").startswith(today) and r.get("startedAt")]
    openToday = openTicketsToday()
    pmFrom = datetime.combine(datetime.now().date(), config.driveShiftPmFrom)
    return jsonify({
        "now": datetime.now().isoformat(timespec="seconds"),
        "bootedAt": bootedAt,  # changes after a restart (Settings waits for it)
        # Changes whenever tickets.json does (from any page, tab or Chrome job): pages refresh on it.
        "dataVersion": "-".join(map(str, fileStamp() or ())) + "|" + datetime.now().date().isoformat(),
        "employeeId": config.employeeId,
        "shift": currentDriveShift(), "pmFrom": pmFrom.strftime("%I:%M %p").lstrip("0"),
        "cloudStart": summary(cloud) if cloud else None,
        "nextLocalId": localTicketId(nextLocalNumber()),
        "counts": {
            "today": len(todays),
            "open": sum(1 for r in openToday if readyToEnd(r)),      # End Ticket: result is ready
            "driving": sum(1 for r in openToday if not readyToEnd(r)),  # Live Testing: still driving
            "completedToday": sum(1 for r in todays if r.get("endedAt")),
            "toStart": len(notStartedRecords()),
            "readyToClose": sum(1 for r in records if workflows.isReadyToClose(r)),
            "whatsappPending": sum(1 for r in todays if r.get("endedAt") and not r.get("whatsappSentAt")
                                   and r.get("startType") != "manual"),
            "total": len(records),
        },
        "today": [summary(r) for r in sorted(todays, key=lambda r: r.get("startedAt") or r.get("updatedAt") or "")],
        "bridge": bridgeStatus(),
        "jobs": [job for job in listJobs() if job["state"] == "running"],
    })


def woDate(wo):
    """The drive date written in a WO name (..._103026_... = Oct 30 2026), or None."""
    import re
    match = re.search(r"_(\d{2})(\d{2})(\d{2})_", str(wo or ""))
    if not match:
        return None
    try:
        return datetime(2000 + int(match.group(3)), int(match.group(1)), int(match.group(2))).date()
    except ValueError:
        return None


routeOrderFile = Path(config.appDir) / "maps" / "routeOrders.json"  # your hand-made stop orders, per day
routeOrderLock = threading.Lock()


def readRouteOrders():
    import json
    try:
        return json.loads(routeOrderFile.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def wosForDay(dayText, records=None):
    """A day's WOs, as the Maps and Sheets pages show them: {key: (record, category)}.
    Driven that day (started or ended then): completed / doing. The rest of that day's list
    (Records' day, plus Start's To start list today): pending today, missed on a past day."""
    isToday = dayText == datetime.now().date().isoformat()
    records = searchRecords("") if records is None else records
    picked = {}
    for record in records:
        started = (record.get("startedAt") or "").startswith(dayText)
        ended = (record.get("endedAt") or "").startswith(dayText)
        if started or ended:
            picked[woKey(record.get("wo"))] = (record, "completed" if record.get("endedAt") else "doing")
    for record in records:  # the day's list, as in Records (imported / moved / created that day)
        key = woKey(record.get("wo"))
        if key not in picked and not record.get("startedAt") and (recordDay(record) or "").startswith(dayText):
            picked[key] = (record, "pending" if isToday else "missed")
    if isToday:  # plus everything on Start's To start list (imported or moved to today)
        for record in notStartedRecords():
            picked.setdefault(woKey(record.get("wo")), (record, "pending"))
    return picked


@app.get("/api/sheets")
def sheetRows():
    """Today's WOs for the Sheets page: WO, grid key, long, lat (as saved, in the right order).
    Same WOs as today's map. Order: driven ones first (in the order you drove them), then the rest
    exactly as Start's To start list shows them - which follows the order picked on Maps."""
    picked = wosForDay(datetime.now().date().isoformat())
    driven = sorted((r for r, category in picked.values() if category in ("completed", "doing")),
                    key=lambda r: r.get("startedAt") or r.get("endedAt") or "")
    startOrder, _ = inMapOrder(notStartedRecords())
    ordered, seen = [], set()
    for record in driven + startOrder + [r for r, _ in picked.values()]:
        key = woKey(record.get("wo"))
        if key in picked and key not in seen:
            seen.add(key)
            ordered.append(picked[key])
    rows = []
    for record, category in ordered:
        lat, lon = workflows.latLong(record)
        rows.append({"wo": record.get("wo") or "", "gridKey": record.get("gridKey") or "",
                     "long": lon, "lat": lat, "category": category})
    return jsonify({"date": datetime.now().date().isoformat(), "rows": rows})


@app.get("/api/map")
def mapPoints():
    """One day's WOs with coordinates for the Maps page (?date=YYYY-MM-DD, default today).
    Driven that day (started or ended then): completed / doing - their start (else end) time is the
    order you drove them in. The rest of that day's list (Records' day, plus Start's To start list
    today) is pending today, missed on a past day."""
    today = datetime.now().date()
    dayText = request.args.get("date") or today.isoformat()
    try:
        day = datetime.fromisoformat(dayText).date()
    except ValueError:
        return fail("That's not a date.")
    dayText = day.isoformat()
    isToday = day == today
    records = searchRecords("")
    days = {today.isoformat()}
    for record in records:
        for field in ("startedAt", "endedAt"):
            if len(record.get(field) or "") >= 10:
                days.add(record[field][:10])
    picked = wosForDay(dayText, records)

    points, noLocation = [], []
    for record, category in picked.values():
        lat, lon = workflows.latLong(record)
        try:
            lat, lon = float(lat), float(lon)
        except (TypeError, ValueError):
            noLocation.append(record.get("wo"))
            continue
        woDay = woDate(record.get("wo"))
        points.append({**summary(record), "lat": lat, "lon": lon, "category": category,
                       "woDate": woDay.isoformat() if woDay else None,
                       "drivenAt": record.get("startedAt") or record.get("endedAt")})
    with routeOrderLock:
        saved = readRouteOrders().get(dayText)
    return jsonify({"date": dayText, "isToday": isToday, "dates": sorted(days, reverse=True),
                    "points": points, "noLocation": noLocation, "savedOrder": saved})


@app.post("/api/map/order")
def mapOrderSave():
    """Save your own order of the stops still to drive on a day ({date, keys}); keys empty = back to
    the shortest order."""
    import json
    data = body()
    dayText = str(data.get("date") or "")
    try:
        datetime.fromisoformat(dayText)
    except ValueError:
        return fail("That's not a date.")
    keys = [str(key) for key in (data.get("keys") or []) if key]
    with routeOrderLock:
        orders = readRouteOrders()
        if keys:
            orders[dayText] = keys
        else:
            orders.pop(dayText, None)
        orders = {d: orders[d] for d in sorted(orders, reverse=True)[:60]}  # keep the last 60 days
        routeOrderFile.parent.mkdir(parents=True, exist_ok=True)
        temp = routeOrderFile.with_suffix(".tmp")
        temp.write_text(json.dumps(orders, indent=1), encoding="utf-8")
        os.replace(temp, routeOrderFile)
    return jsonify({"ok": True, "savedOrder": keys or None})


routeSequenceFile = Path(config.appDir) / "maps" / "routeSequence.json"  # the map's stop order, per day


def readRouteSequences():
    import json
    try:
        return json.loads(routeSequenceFile.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


@app.post("/api/map/sequence")
def mapSequenceSave():
    """The Maps page sends today's stops still to drive, in its order (shortest or yours): Start
    Ticket lists its WOs in this order."""
    import json
    data = body()
    dayText = str(data.get("date") or "")
    if dayText != datetime.now().date().isoformat():
        return jsonify({"ok": False})
    keys = [str(key) for key in (data.get("keys") or []) if key]
    with routeOrderLock:
        sequences = readRouteSequences()
        sequences[dayText] = keys
        sequences = {d: sequences[d] for d in sorted(sequences, reverse=True)[:14]}
        routeSequenceFile.parent.mkdir(parents=True, exist_ok=True)
        temp = routeSequenceFile.with_suffix(".tmp")
        temp.write_text(json.dumps(sequences, indent=1), encoding="utf-8")
        os.replace(temp, routeSequenceFile)
    return jsonify({"ok": True})


def inMapOrder(records):
    """Start's list in today's map order. WOs the map hasn't placed yet (just moved to today or
    imported) go in where they add the least straight-line distance; ones without a location last."""
    import math
    today = datetime.now().date().isoformat()
    with routeOrderLock:
        order = readRouteSequences().get(today) or readRouteOrders().get(today) or []
    if not order:
        return records, 0
    byKey = {woKey(r.get("wo")): r for r in records}
    route = [byKey[k] for k in order if k in byKey]
    placed = set(order)
    rest = [r for r in records if woKey(r.get("wo")) not in placed]

    def spot(record):
        lat, lon = workflows.latLong(record)
        try:
            return float(lat), float(lon)
        except (TypeError, ValueError):
            return None

    def far(a, b):
        (la1, lo1), (la2, lo2) = a, b
        x = math.radians(lo2 - lo1) * math.cos(math.radians((la1 + la2) / 2))
        return math.hypot(x, math.radians(la2 - la1))

    noSpot = []
    for record in rest:
        here = spot(record)
        spots = [spot(r) for r in route]
        if here is None or not route or None in spots:
            (noSpot if here is None else route).append(record)
            continue
        best, bestCost = len(route), far(spots[-1], here)
        for i in range(len(route)):
            cost = far(here, spots[i]) - (far(spots[i - 1], spots[i]) if i else 0) + (far(spots[i - 1], here) if i else 0)
            if cost < bestCost:
                best, bestCost = i, cost
        route.insert(best, record)
    return route + noSpot, len(route)


@app.get("/api/settings")
def settings():
    return jsonify({
        "employeeId": config.employeeId, "region": config.defaultRegion, "market": config.defaultMarket,
        "logsPreviousDay": config.defaultLogsUploadedPreviousDay,
        "pmFrom": config.driveShiftPmFrom.strftime("%H:%M"), "defaultSubmit": config.defaultSubmit,
        "defaults": {"total": config.defaultTotalGrids, "attempted": config.defaultAttempted,
                     "skipped": config.defaultSkipped, "status": config.defaultStatus},
        "statusOptions": workflows.statusOptions, "equipments": config.equipments,
        "folderNamePrefix": config.folderNamePrefix, "whatsappGroup": config.whatsappGroup,
        "whatsappWoGroup": config.whatsappWoGroup,
        "whatsappSend": config.whatsappSend, "whatsappRetries": config.whatsappRetries,
        "whatsappAutoShare": config.whatsappAutoShare,
        "temsTestMode": config.temsTestMode, "temsProject": config.temsProject, "temsAssignWo": config.temsAssignWo,
        "actixSubmit": config.actixSubmit, "closeTabsWhenDone": config.closeTabsWhenDone,
        "paths": {"Tickets file": str(config.ticketStoreFile), "Drive logs": str(config.logRootDir),
                  "Work order output": str(config.workOrderOutputDir), "Debug log": str(config.debugLogPath),
                  "Settings (.env)": str(config.envPath)},
        "urls": {"TechInsights": config.ticketsUrl, "ActixOne": config.actixUploadUrl, "TEMS Paragon": config.temsUrl, "TEMS project": config.temsProject,
                 "Apeksha": config.apekshaUrl},
        "bridge": bridgeStatus(),
    })


@app.get("/api/settings/env")
def settingsEnv():
    """Every .env setting with its current value, type and help, for the Settings form."""
    return jsonify({"fields": envSettings.describe(), "envPath": str(config.envPath),
                    "history": envSettings.readHistory()})


@app.post("/api/settings/env")
def settingsEnvSave():
    """Save changed settings into .env (nothing is written if any value is wrong)."""
    try:
        return jsonify(envSettings.save(body().get("changes") or {}))
    except envSettings.SettingsError as error:
        return fail(str(error))


@app.post("/api/restart")
def restart():
    """Restart the app so new .env values take effect. Started from runWeb.bat: it exits with
    code 75 and the launcher starts it again in the same window. Started by hand: it starts a
    new copy of itself, then exits."""
    viaLauncher = os.environ.get("KAAM_LAUNCHER") == "1"

    def later():
        stopAll()
        if not viaLauncher:
            import subprocess
            flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
            subprocess.Popen([sys.executable, "-m", "web.server", "--after-restart"],
                             cwd=str(config.appDir), creationflags=flags)
        os._exit(75 if viaLauncher else 0)

    threading.Timer(0.6, later).start()
    return jsonify({"restarting": True, "bootedAt": bootedAt})


@app.post("/api/quit")
def quitApp():
    """Stop this copy of the app. A new copy started in a terminal calls this to take over."""
    def later():
        stopAll()
        print("Another copy of Kaam25 took over - stopping this one.")
        os._exit(0)

    threading.Timer(0.4, later).start()
    return jsonify({"quitting": True, "pid": os.getpid()})


@app.get("/api/resolve")
def resolve():
    """WO box lookup: a WO, grid key or Ticket ID -> the WO and its record."""
    raw = request.args.get("q", "")
    wo, record, matchedBy = workflows.resolveWorkOrder(raw)
    return jsonify({"wo": wo, "matchedBy": matchedBy, "record": detail(record) if record else None,
                    "folderName": buildFolderName(wo) if wo else "",
                    "locationPreview": workflows.formatLocationPreview(wo, record)})


# ---------- records ----------
@app.get("/api/records")
def records():
    found = searchRecords(request.args.get("q", ""))
    found.sort(key=lambda r: recordDay(r) or "", reverse=True)
    return jsonify([summary(r) for r in found[:400]])


@app.get("/api/records/<path:wo>")
def recordDetail(wo):
    return jsonify(detail(requireRecord(wo)))


@app.patch("/api/records/<path:wo>")
def recordUpdate(wo):
    data = body()
    source = "End" if data.get("source") == "End" else "Records"
    record = workflows.updateStatus(wo, data.get("total", ""), data.get("attempted", ""), data.get("skipped", ""),
                                    data.get("status", ""), data.get("remarks", ""), source=source)
    return jsonify(detail(record))


@app.delete("/api/records/<path:wo>")
def recordDelete(wo):
    if not deleteRecord(wo):
        return fail("It was already gone.", 404)
    return jsonify({"ok": True, "message": f"Deleted {wo}. A copy is kept in "
                                          f"{config.ticketStoreFile.stem}.deleted.json."})


@app.post("/api/records/moveToday")
def recordsMoveToday():
    wos = body().get("wos") or []
    moved = moveToToday(wos)
    return jsonify({"moved": moved})


@app.post("/api/records/bulk")
def recordsBulk():
    """Records' ticked not-started WOs: {"action": "delete" | "done", "wos": [...]}. Started ones are skipped."""
    data = body()
    wos = data.get("wos") or []
    if data.get("action") == "delete":
        return jsonify({"count": deleteNotStarted(wos)})
    if data.get("action") == "done":
        return jsonify({"count": markDone(wos)})
    return fail("Unknown action.")


@app.post("/api/records/rename")
def recordsRename():
    """Correct a WO's name (Start's "WO not in TEMS" popup). Not in Records yet: nothing to rename."""
    data = body()
    oldWo = workflows.cleanWorkOrder(data.get("oldWo", ""))
    newWo = workflows.cleanWorkOrder(data.get("newWo", ""))
    if not newWo:
        return fail("Enter the corrected WO.")
    try:
        record = renameWo(oldWo, newWo)
    except TicketStoreError as error:
        return fail(str(error))
    return jsonify({"wo": newWo, "renamed": record is not None, "record": detail(record) if record else None})


@app.post("/api/records/<path:wo>/openFile")
def recordOpenFile(wo):
    record = getRecord(wo) or {}
    try:
        opened = showInExplorer(workflows.cleanWorkOrder(wo), record.get("gridSummaryPath"))
    except Exception as error:
        return fail(f"Couldn't open the file: {error}")
    return jsonify({"opened": str(opened)})


@app.post("/api/records/<path:wo>/location")
def recordSendLocation(wo):
    return jsonify({"message": workflows.sendLocation(wo)})


# ---------- start ----------
@app.get("/api/start/waiting")
def startWaiting():
    records, stops = inMapOrder(notStartedRecords())
    return jsonify([{**summary(r), "mapStop": n + 1 if n < stops else None} for n, r in enumerate(records)])


@app.post("/api/start")
def start():
    data = body()
    wo = workflows.cleanWorkOrder(data.get("wo", ""))
    if not wo:
        return fail("Enter a WO first.")
    if data.get("mode") == "local":
        return jsonify({"done": True, **workflows.startLocalWo(wo)})
    submit = bool(data.get("submit", config.defaultSubmit))
    force = bool(data.get("force"))
    shift = currentDriveShift()  # decided now, at ticket creation
    if force and data.get("existingTicketId"):
        workflows.chooseNewTicket(wo, data["existingTicketId"])

    def work(job):
        result = workflows.startCloud(wo, submit=submit, shift=shift, force=force, progress=job.progress)
        if result.get("ticketId"):
            job.post("ticket", result["ticketId"])
        return result

    job = startJob("start", wo, f"Start {wo}", work)
    return jsonify({"done": False, "job": job.toJson()})


@app.post("/api/start/useExisting")
def startUseExisting():
    data = body()
    wo, ticketId = workflows.cleanWorkOrder(data.get("wo", "")), (data.get("ticketId") or "").strip()
    if not (wo and ticketId):
        return fail("WO and Ticket ID are needed.")
    return jsonify({"summary": workflows.useExistingTicket(wo, ticketId, data.get("summary") or ""),
                    "ticketId": ticketId, "wo": wo})


@app.post("/api/import")
def importSheet():
    upload = request.files.get("file")
    if not upload or not upload.filename:
        return fail("Pick an Excel or CSV file.")
    name = Path(upload.filename).name
    suffix = Path(name).suffix.lower()
    if suffix not in (".xlsx", ".xlsm", ".csv", ".xls"):
        return fail(f"{name}: use an .xlsx, .xlsm or .csv file.")
    folder = Path(tempfile.mkdtemp(prefix="kaam25-import-"))
    path = folder / f"upload{suffix}"
    try:
        upload.save(path)
        result = workflows.importSheetFile(path, sourceName=name)
    except (SheetImportError, Exception) as error:
        return fail(f"Couldn't import {name}: {error}")
    finally:
        try:
            path.unlink(missing_ok=True)
            folder.rmdir()
        except OSError:
            pass
    return jsonify(result)


# ---------- end ----------
def readyToEnd(record):
    """TEMS has written the WO's result (GridSummary.csv) - it's driven and can be ended."""
    from kaam.gridSummary import resultReady
    return resultReady(record["wo"])


@app.get("/api/end/open")
def endOpen():
    """Today's open tickets whose result is ready (End Ticket). ?all=1: every open one, with
    resultReady, for Live Testing (the ones still being driven come first)."""
    rows = [{**summary(r), "resultReady": readyToEnd(r)} for r in openTicketsToday()]
    if request.args.get("all"):
        return jsonify(sorted(rows, key=lambda r: r["resultReady"]))
    return jsonify([r for r in rows if r["resultReady"]])


@app.post("/api/end/run")
def endRun():
    wo = workflows.cleanWorkOrder(body().get("wo", ""))
    if not wo:
        return fail("Enter a WO first.")
    isLocal = isLocalStart(getRecord(wo))

    def work(job):
        if isLocal:
            job.progress("Local start: copying GridSummary and uploading…")
        return workflows.endTicket(wo, post=job.post)

    job = startJob("end", wo, f"{'Upload' if isLocal else 'End'} {wo}", work)
    return jsonify({"job": job.toJson()})


@app.post("/api/end/runAll")
def endRunAll():
    """End Tickets: every WO End Ticket lists (today's open ones whose result file is in), oldest
    first - all uploads, then the WhatsApp shares one by one (only what ended and wasn't shared)."""
    data = body()
    rows = sorted((r for r in openTicketsToday() if readyToEnd(r)), key=lambda r: r.get("startedAt") or "")
    wos = [r["wo"] for r in rows]
    if not wos:
        return fail("Nothing to end - no open WO has its result file yet.")
    send = data.get("send")
    job = startJob("endAll", "", f"End {len(wos)} tickets",
                   lambda job: workflows.endAll(wos, post=job.post, send=send))
    return jsonify({"job": job.toJson(), "wos": wos})


@app.post("/api/end/save")
def endSave():
    data = body()
    fields = data.get("fields") or {}
    # "event": null -> a quiet save (e.g. after a run or Copy); missing -> the Save button's history line
    event = data["event"] if "event" in data else (
        f"End: saved {fields.get('status')} · grids {fields.get('total')} / attempted "
        f"{fields.get('attempted')} / skipped {fields.get('skipped')} (not ended)")
    record = workflows.saveReportFields(fields, event=event)
    return jsonify(detail(record))


@app.post("/api/end/done")
def endDone():
    record = workflows.finishTicket(body().get("fields") or {})
    return jsonify(detail(record) if record else {})


@app.post("/api/end/eq")
def endSaveEq():
    data = body()
    message = workflows.saveEqIds(data.get("wo", ""), {"EQ3": data.get("eq3"), "EQ6": data.get("eq6")})
    return jsonify({"message": message})


# ---------- close ----------
@app.get("/api/close/ready")
def closeReady():
    return jsonify([summary(r) for r in searchRecords("") if workflows.isReadyToClose(r)])


@app.post("/api/close/run")
def closeRun():
    wo = workflows.cleanWorkOrder(body().get("wo", ""))
    record = getRecord(wo) or {}
    state = workflows.closeState(record)
    if not state["canClose"]:
        return fail(state["reason"])
    job = startJob("close", record["wo"], f"Close {record['wo']}",
                   lambda job: workflows.closeTicket(record["wo"], progress=job.progress))
    return jsonify({"job": job.toJson()})


# ---------- WhatsApp ----------
@app.post("/api/whatsapp")
def whatsapp():
    data = body()
    wo = workflows.cleanWorkOrder(data.get("wo", ""))
    if not wo:
        return fail("Enter a WO first.")
    report = data.get("report") or workflows.reportFromRecord(getRecord(wo) or {"wo": wo})
    send = data.get("send")
    job = startJob("whatsapp", wo, f"WhatsApp {wo}",
                   lambda job: workflows.shareTicket(wo, report, send=send, progress=job.progress))
    return jsonify({"job": job.toJson()})


@app.post("/api/tems")
def tems():
    """TEMS Paragon in Chrome (Cloud tab, TEMS Cloud login if needed), then
    find: is the WO in TEMS (Cloud list or Assign)?  go: Reserve + Open it (prod).
    test: check Reserve for cloudWo and Open for assignWo, click nothing.
    The job's result carries ok / summary / error / found / notFound."""
    data = body()
    action = data.get("action") or "find"
    if action not in temsActions:
        return fail(f"Unknown TEMS action {action}.")
    wo = workflows.cleanWorkOrder(data.get("wo", ""))
    cloudWo = workflows.cleanWorkOrder(data.get("cloudWo", ""))
    assignWo = workflows.cleanWorkOrder(data.get("assignWo", ""))
    if action == "play":
        return temsPlay()
    if action != "test" and not wo:
        return fail("Enter a WO first.")
    if action == "test" and not (cloudWo or assignWo):
        return fail("Enter a Cloud WO or an Assign WO to test.")

    def work(job):
        job.progress(f"Opening TEMS Paragon ({config.temsUrl}) in your Chrome… (Cloud tab, Log in if needed)")
        if action == "find":
            job.progress(f"Looking for {wo} in TEMS Cloud ({config.temsProject}), then on Assign…")
        elif action == "go":
            job.progress(f"{wo}: Reserve in TEMS Cloud ({config.temsProject}), then Open on Assign…")
        else:
            job.progress(f"TEST - nothing is clicked. Reserve for {cloudWo or '-'}, Open for {assignWo or '-'}…")
        result = runTems(action, wo=wo, cloudWo=cloudWo, assignWo=assignWo)
        if wo and action == "go" and result.get("ok"):
            workflows.safeSave(wo, event=result.get("summary") or "TEMS: reserved and opened")
        return result
    title = {"find": f"TEMS: find {wo}", "go": f"TEMS: reserve + open {wo}", "test": "TEMS test"}[action]
    job = startJob("tems", wo or cloudWo or assignWo, title, work)
    return jsonify({"job": job.toJson()})


def temsPlay():
    """Live Testing's Start ticket: TEMS's Control page, then play - only when TEMS says the open WO
    is Validated / Paused (read from TEMS first; never pressed while it runs - that would pause it).
    Stays on TEMS."""
    from kaam import temsMap

    def work(job):
        try:
            before = temsMap.workOrderState()
        except Exception as error:
            raise RuntimeError(f"TEMS isn't answering at {config.temsUrl} - is TEMS Paragon running? ({error})")
        name = before["wo"] or "the open WO"
        job.progress(f"TEMS: {name} is {before['stateName']}" + (f" ({before['error']})" if before["error"] else ""))
        if before["state"] == temsMap.executing:
            return {"ok": True, "summary": f"TEMS: {name} is already running - nothing pressed."}
        canPlay = before["state"] in temsMap.playable
        job.progress("Opening TEMS Control" + (", pressing play…" if canPlay else " (play isn't ready yet)…"))
        result = runTems("play", canPlay=canPlay)
        if not result.get("ok"):
            return result
        if not canPlay:
            why = before["error"] or f"it's {before['stateName']}, play works once it's Validated (green)"
            return {"ok": False, "error": f"TEMS Control is open, but {name} can't start yet: {why}."}
        if result.get("played"):
            for _ in range(20):  # TEMS takes a moment to start
                time.sleep(0.75)
                after = temsMap.workOrderState()
                if after["state"] == temsMap.executing:
                    return {"ok": True, "summary": f"TEMS: {name} started (Executing)."}
            return {"ok": False, "error": f"Pressed play, but {name} is {after['stateName']}"
                                          + (f" ({after['error']})" if after["error"] else "") + ". Check TEMS."}
        return result
    job = startJob("tems", "", "TEMS: start ticket", work)
    return jsonify({"job": job.toJson()})


# ---------- Live Testing (phones over adb, Vysor windows) ----------
liveActions = {
    "desk": "Set up desk",
    "fullTestAll": "Test all, one by one",
    "fullTest": "Full test",
    "speedtest": "Speed test",
    "airplane": "Airplane toggle",
}


@app.get("/api/live/temsMap")
def liveTemsMap():
    """TEMS's live map data (grid, route, track, car) for the Live Testing map."""
    from kaam import temsMap
    try:
        return jsonify(temsMap.readMap(request.args.get("trackFrom", 0, type=int)))
    except temsMap.TemsOffline as error:
        return fail(str(error), 503)


@app.get("/api/live/signal")
def liveSignal():
    """What each connected phone is latched to right now (NR / LTE, band, PCI, RSRP, SINR...),
    read continuously in the background while a Live Testing page keeps asking."""
    from kaam import liveSignal as signal, phoneControl
    import time as clock
    try:
        connected = set(phoneControl.connectedSerials())
    except Exception as error:
        return fail(error, 503)
    phones = {name: serial for name, serial in phoneControl.configuredPhones().items() if serial in connected}
    readings = signal.signals(list(phones.values()))
    now = clock.time()
    out = {}
    for name, serial in phones.items():
        reading = readings.get(serial)
        if reading:
            out[name] = {**{k: v for k, v in reading.items() if k != "at"}, "age": round(now - reading["at"], 1),
                         "text": phoneControl.networkText(reading)}
    return jsonify({"phones": out})


@app.get("/api/live/phones")
def livePhones():
    from kaam import phoneControl
    try:
        connected = set(phoneControl.connectedSerials())
        adbError = ""
    except Exception as error:
        connected, adbError = set(), str(error)
    def check(phone):
        """Live state of one phone (runs for both phones at once)."""
        serial = phone["serial"]
        try:
            onScreen = [c for c, _ in phoneControl.resumedActivities(serial)]
            phone["testScreen"] = any("ServiceMode" in c for c in onScreen) and any("chrome" in c for c in onScreen)
            phone["airplane"] = phoneControl.isAirplaneOn(serial)
            phone["locked"] = "isKeyguardShowing=true" in phoneControl.adbShell(
                serial, "dumpsys window | grep -m1 isKeyguardShowing")
            # The live loop's reading when it's fresh (no second screen read fighting it).
            from kaam import liveSignal
            fresh = liveSignal.latest.get(serial)
            if fresh and datetime.now().timestamp() - fresh["at"] < 30:
                phone["network"] = {k: v for k, v in fresh.items() if k != "at"}
            else:
                phone["network"] = phoneControl.readNetwork(serial)
            phone["networkText"] = phoneControl.networkText(phone["network"])
        except Exception as error:
            phone["error"] = str(error)

    phones = [{"name": name, "serial": serial, "connected": serial in connected, "airplane": None,
               "testScreen": False, "locked": False, "network": None, "networkText": ""}
              for name, serial in phoneControl.configuredPhones().items()]
    threads = [threading.Thread(target=check, args=(p,)) for p in phones if p["connected"]]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)
    return jsonify({"phones": phones, "adbError": adbError, "splitRatio": phoneControl.splitRatio,
                    "airplaneSeconds": phoneControl.airplaneSeconds,
                    "unconfigured": sorted(connected - {p["serial"] for p in phones})})


def speedResultText(result):
    from kaam.phoneControl import networkText
    network = result.get("network")
    tech = network.get("tech") if network else ""
    if result.get("error"):
        return f"{result['phone']} ({tech or '?'}): no speed - {result['error']}"
    return (f"{result['phone']} ({tech or '?'}): {result.get('download') or '?'} Mbps down, ping {result.get('ping') or '?'} ms"
            + (f" ({result['pingLoaded']} ms loaded)" if result.get("pingLoaded") else "")
            + (f" · {networkText(network)}" if network else ""))


def saveSpeedTest(wo, result):
    """Adds one speed test result to the WO's record (its speedTests list)."""
    record = getRecord(wo) or {}
    tests = list(record.get("speedTests") or [])
    tests.append({"phone": result.get("phone"), "download": result.get("download"), "ping": result.get("ping"),
                  "pingLoaded": result.get("pingLoaded"), "resultId": result.get("resultId"),
                  "network": result.get("network"), "error": result.get("error"),
                  "at": datetime.now().isoformat(timespec="seconds")})
    return workflows.safeSave(wo, event=f"Speed test {speedResultText(result)}", speedTests=tests)


@app.post("/api/live/tests/remove")
def liveTestRemove():
    data = body()
    wo = workflows.cleanWorkOrder(data.get("wo", ""))
    record = requireRecord(wo)
    tests = [t for t in record.get("speedTests") or [] if t.get("resultId") != data.get("resultId")]
    workflows.safeSave(record["wo"], speedTests=tests)
    return jsonify({"speedTests": tests})


@app.post("/api/live/run")
def liveRun():
    from kaam import phoneControl
    from kaam.chromeBridge import raiseIfStopped
    data = body()
    action, phone = data.get("action", ""), (data.get("phone") or "").strip()
    wo = workflows.cleanWorkOrder(data.get("wo", ""))
    if action not in liveActions:
        return fail(f"Unknown action {action}.")
    if action not in ("desk", "fullTestAll") and not phone:
        return fail("Pick a phone.")
    missingWo = wo if wo and not getRecord(wo) else ""
    if missingWo:
        wo = ""  # still test; the result just isn't saved anywhere
    resultText = speedResultText

    def keep(job, result):
        """Shows the result on the page at once and saves it on the WO."""
        job.post("results", (job.data.get("results") or []) + [result])
        if wo:
            problem = saveSpeedTest(wo, result)
            job.progress(problem or f"Saved on {wo}")

    def work(job):
        phoneControl.listenHere(job.progress)
        phoneControl.stopCheck = raiseIfStopped
        if missingWo:
            job.progress(f"{missingWo} isn't in Records - testing anyway, results won't be saved on a WO")
        try:
            if action == "desk":
                from kaam.deskLayout import setupDesk
                setupDesk()
                return "Desk ready: phones set up, Chrome on the left, phones on the right."
            if action == "fullTestAll":
                connected = set(phoneControl.connectedSerials())
                serials = [s for s in phoneControl.configuredPhones().values() if s in connected]
                if not serials:
                    raise RuntimeError("No phone from PHONES in .env is connected.")
                # one at a time (NR phones first, then LTE): two speed tests must not share the network
                results = phoneControl.fullTestOneByOne(serials, onResult=lambda r: keep(job, r),
                                                        onOrder=lambda names: job.post("order", names))
                return {"summary": " · ".join(resultText(r) for r in results), "results": results}
            serial = phoneControl.pickPhones([phone])[0]
            if action == "airplane":  # just re-attach to the network; no test, nothing saved
                if phoneControl.toggleAirplane(serial):
                    return f"{phone}: airplane mode toggled, back online."
                return {"ok": False, "summary": f"{phone}: airplane mode toggled, but no internet yet."}
            result = phoneControl.speedTest(serial) if action == "speedtest" else phoneControl.fullTest(serial)
            keep(job, result)
            return {"summary": resultText(result), "results": [result]}
        finally:
            phoneControl.listenHere(None)

    running = next((j for j in listJobs() if j["kind"] == "live" and j["state"] == "running"), None)
    if running:  # one at a time: tests share the network, and Set up desk moves the same phones
        return fail(f"Wait for \"{running['title']}\" to finish (or press Stop).")
    title = liveActions[action] + (f" · {phone}" if action in ("fullTest", "speedtest", "airplane") else "")
    job = startJob("live", phone or action, title, work)
    return jsonify({"job": job.toJson()})


# ---------- jobs ----------
@app.get("/api/jobs")
def jobsList():
    return jsonify(listJobs())


@app.get("/api/jobs/<jobId>")
def jobDetail(jobId):
    job = getJob(jobId)
    if not job:
        return fail("No such job (the server was restarted?).", 404)
    return jsonify(job.toJson())


@app.post("/api/stop")
def stop():
    stopAll()
    return jsonify({"ok": True})


@app.post("/api/bridge/start")
def bridgeStart():
    try:
        startBridge()
    except ChromeBridgeError as error:
        return fail(error)
    return jsonify(bridgeStatus())


# ---------- run ----------
def isPortFree(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind((bindHost(), port))
            return True
        except OSError:
            return False


def bindHost():
    """All network cards (so the WiFi can reach it) when LAN_ACCESS is on, else this PC only."""
    return "0.0.0.0" if config.lanAccess else "127.0.0.1"


def lanAddresses():
    """This PC's WiFi/LAN IPv4 addresses, for the startup message."""
    found = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))  # no packet is sent; just picks the outgoing card
            found.add(probe.getsockname()[0])
    except OSError:
        pass
    try:
        found.update(info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    return sorted(ip for ip in found if not ip.startswith(("127.", "169.254.")))


def pickPort(preferred=5000):
    for port in [preferred] + list(range(5001, 5021)):
        if isPortFree(port):
            return port
    raise SystemExit("No free port between 5000 and 5020.")


def showApp(url):
    """Show the app in Chrome: the extension switches to your open Kaam25 tab (pinned or not) instead
    of opening another; no Kaam25 tab (or no extension) -> the helper page turns into the app."""
    import urllib.parse
    if isPortFree(config.bridgePort):  # helper server isn't running: just open the app
        webbrowser.open(url)
        return
    try:
        openInChrome(f"http://127.0.0.1:{config.bridgePort}/app#" + urllib.parse.urlencode({"url": url}))
    except Exception:  # Chrome not found: the default browser
        webbrowser.open(url)


def findRunningApp(preferred=5000):
    """(url, pid) of a Kaam25 web app already running on this computer, or None."""
    import json
    import urllib.request
    for port in [preferred] + list(range(5001, 5021)):
        url = f"http://127.0.0.1:{port}"
        try:
            with urllib.request.urlopen(f"{url}/api/state", timeout=0.4) as response:
                data = json.loads(response.read() or b"{}")
        except (OSError, ValueError):
            continue
        if "employeeId" in data:
            booted = str(data.get("bootedAt") or "")
            pid = booted.rsplit(".", 1)[-1]  # bootedAt ends with ".<pid>"
            return url, int(pid) if pid.isdigit() else None
    return None


def takeOver(url, pid, port):
    """Stop the copy running at `url` so this one can run in your terminal instead."""
    import time
    import urllib.request
    try:
        urllib.request.urlopen(urllib.request.Request(f"{url}/api/quit", data=b"{}", method="POST",
                                                      headers={"Content-Type": "application/json"}),
                               timeout=2).close()
    except OSError:
        pass  # an older copy without /api/quit: the process kill below handles it
    deadline = time.time() + 6
    while time.time() < deadline:
        if isPortFree(port) and isPortFree(config.bridgePort):
            return True
        time.sleep(0.2)
    if pid and pid != os.getpid():  # didn't let go in time: end its process
        try:
            import signal
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.time() + 5
        while time.time() < deadline:
            if isPortFree(port) and isPortFree(config.bridgePort):
                return True
            time.sleep(0.2)
    return False


def main():
    preferred = int(os.environ.get("KAAM_PORT") or 5000)
    afterRestart = "--after-restart" in sys.argv  # Settings saved .env: the page is already open
    if afterRestart:
        import time
        deadline = time.time() + 10  # come back on the same port once the old copy has let go
        while time.time() < deadline and not (isPortFree(preferred) and isPortFree(config.bridgePort)):
            time.sleep(0.2)
    else:
        running = findRunningApp(preferred)
        if running:  # an older copy is running: stop it so this one runs in this window
            url, pid = running
            print(f"Kaam25 is already running on {url} - stopping it so it runs here instead ...")
            oldPort = int(url.rsplit(":", 1)[-1])
            if takeOver(url, pid, oldPort):
                preferred = oldPort  # same address, so your open tab keeps working
            else:
                print("! Couldn't stop the old copy - starting on the next free port.")
    port = pickPort(preferred)
    try:
        startBridge()  # the Chrome extension talks to this; also shows "connected" in the UI
    except ChromeBridgeError as error:
        print(f"! Chrome bridge not started: {error}")
    url = f"http://127.0.0.1:{port}"
    print(f"Kaam25 web is running on {url}  (Ctrl+C to stop)")
    if config.lanAccess:
        for ip in lanAddresses():
            print(f"  On the same WiFi: http://{ip}:{port}")
    if "--no-browser" not in sys.argv and not afterRestart:
        threading.Timer(1.0, lambda: showApp(url)).start()
    app.run(host=bindHost(), port=port, threaded=True, use_reloader=False, debug=False)


if __name__ == "__main__":
    main()
