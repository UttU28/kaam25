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

from flask import Flask, jsonify, request, send_file, send_from_directory  # noqa: E402

from kaam import config, envSettings, ticketFlow, workflows  # noqa: E402
from kaam.chromeBridge import ChromeBridgeError, bridgeStatus, openInChrome, startBridge, stopAll  # noqa: E402
from kaam.gridSummary import buildFolderName, showInExplorer  # noqa: E402
from kaam.sheetImport import SheetImportError  # noqa: E402
from kaam.temsParagon import actions as temsActions, runTems  # noqa: E402
from kaam.pictures import PictureError, pictureInfo, pictureOf, savePicture  # noqa: E402
from kaam.ticketLookup import currentDriveShift  # noqa: E402
from kaam.ticketStore import (TicketStoreError, cloudStartToday, deleteNotStarted, deleteRecord, fileStamp,  # noqa: E402
                              getRecord, isLocalStart, localTicketId, markDone, moveToToday, nextLocalNumber, notStartedRecords,
                              openTicketsToday, renameWo, searchRecords, woKey)
from kaam.workflows import WorkflowError  # noqa: E402

from web.jobs import getJob, listJobs, runningJobs, startJob  # noqa: E402

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
        "endProblem": record.get("endProblem") or None, "closeProblem": record.get("closeProblem") or None,
        "endLater": record.get("endLater") or None, "closeLater": record.get("closeLater") or None,
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
        # when that file was made: Live Testing hides only the speed tests from before it
        "resultAt": resultAt(record) if record.get("startedAt") else None,
        "report": workflows.reportFromRecord(record) if record.get("startedAt")
        else workflows.formatLocationPreview(record.get("wo", ""), record),
        "reportFields": workflows.reportFieldsFromRecord(record),
        "locationPreview": workflows.formatLocationPreview(record.get("wo", ""), record),
        "folderName": record.get("folderName") or buildFolderName(record.get("wo", "")),
        "close": workflows.closeState(record),
        "history": list(reversed(record.get("history") or [])),
        "previousTickets": record.get("previousTickets") or [],
        # the TEMS picture (required for the WhatsApp share): where it's saved and when
        "picture": pictureInfo(record),
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
            "notInTems": len(notInTemsRecords()),  # waiting for the coordinators to add them in TEMS
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
    Driven that day (started or ended then): completed / doing - completed also once Submit went
    through in TEMS and you pressed Close on its pop-up (submittedAt), before End Ticket. The rest of that day's list
    (Records' day, plus Start's To start list today): pending today, missed on a past day."""
    todayText = datetime.now().date().isoformat()
    isToday = dayText == todayText
    ahead = dayText >= todayText  # today or a later day (e.g. tomorrow's plan): still to drive, not missed
    records = searchRecords("") if records is None else records
    picked = {}
    for record in records:
        started = (record.get("startedAt") or "").startswith(dayText)
        ended = (record.get("endedAt") or "").startswith(dayText)
        submitted = (record.get("submittedAt") or "").startswith(dayText)
        if started or ended or submitted:
            done = record.get("endedAt") or record.get("submittedAt")
            picked[woKey(record.get("wo"))] = (record, "completed" if done else "doing")
    for record in records:  # the day's list, as in Records (imported / moved / created that day)
        key = woKey(record.get("wo"))
        if (key not in picked and not record.get("startedAt") and record.get("temsCheck") != "missing"
                and (recordDay(record) or "").startswith(dayText)):  # not in TEMS yet: nothing to drive
            picked[key] = (record, "pending" if ahead else "missed")
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
        # A later day (moved to tomorrow in Records) with WOs on it: in the list to plan ahead.
        recordOn = (recordDay(record) or "")[:10]
        if recordOn > today.isoformat() and not record.get("startedAt"):
            days.add(recordOn)
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
    return jsonify({"date": dayText, "isToday": isToday, "planning": day >= today, "dates": sorted(days, reverse=True),
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
    if not dayText or dayText < datetime.now().date().isoformat():  # today or a later day's plan
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
        "whatsappWoGroup": config.whatsappWoGroup, "teamsUrl": config.teamsUrl,
        "whatsappSend": config.whatsappSend, "whatsappRetries": config.whatsappRetries,
        "whatsappAutoShare": config.whatsappAutoShare, "whatsappNoPicture": config.whatsappNoPicture,
        "temsTestMode": config.temsTestMode, "temsProject": config.temsProject, "temsAssignWo": config.temsAssignWo,
        "actixSubmit": config.actixSubmit, "closeTabsWhenDone": config.closeTabsWhenDone,
        "paths": {"Tickets file": str(config.ticketStoreFile), "Drive logs": str(config.logRootDir),
                  "Work order output": str(config.workOrderOutputDir), "Debug log": str(config.debugLogPath),
                  "Settings (.env)": str(config.envPath)},
        # the WO box's QR icon: "apeksha" (post the Maps link) or "qr" (show the QR code)
        "locationTarget": config.locationTarget()[1], "locationVia": config.locationTarget()[0],
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
    source = data.get("source") if data.get("source") in ("End", "Live Testing") else "Records"
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
    """{"wos": [...], "tomorrow": true} moves them to tomorrow instead (for the next day's plan)."""
    data = body()
    moved = moveToToday(data.get("wos") or [], tomorrow=bool(data.get("tomorrow")))
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


@app.get("/api/records/<path:wo>/picture")
def recordPicture(wo):
    """The WO's TEMS picture (the file itself, for the page to show)."""
    path = pictureOf(getRecord(wo))
    if not path:
        return fail("No picture saved for this WO.", 404)
    response = send_file(path, max_age=0)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/records/<path:wo>/picture")
def recordPictureSave(wo):
    """A picture for the WO, picked or dragged in on End Ticket (form field "picture"). Replaces the old one."""
    requireRecord(wo)
    upload = request.files.get("picture")
    if not upload:
        return fail("No picture in the upload.")
    try:
        path, replaced = savePicture(wo, upload.read(), upload.filename or "", source="added by hand")
    except PictureError as error:
        return fail(str(error))
    return jsonify({"message": f"Picture {'replaced' if replaced else 'saved'}: {path}", "record": detail(getRecord(wo))})


@app.post("/api/records/<path:wo>/picture/show")
def recordPictureShow(wo):
    """Shows the WO's picture in Explorer (selected in the pictures folder)."""
    import subprocess
    path = pictureOf(getRecord(wo))
    if not path:
        return fail("No picture saved for this WO.")
    subprocess.Popen(["explorer", "/select,", str(path)])
    return jsonify({"opened": str(path)})


@app.post("/api/records/<path:wo>/openFile")
def recordOpenFile(wo):
    record = getRecord(wo) or {}
    try:
        opened = showInExplorer(workflows.cleanWorkOrder(wo), record.get("gridSummaryPath"))
    except Exception as error:
        return fail(f"Couldn't open the file: {error}")
    return jsonify({"opened": str(opened)})


@app.get("/api/qr")
def qrCode():
    """A QR code (SVG) for ?text= - e.g. a WO's Google Maps link. Made on this PC, no internet needed."""
    import io
    import segno
    text = (request.args.get("text") or "").strip()
    if not text or len(text) > 500:
        return fail("Nothing to put in a QR code.")
    out = io.BytesIO()
    segno.make(text, error="m").save(out, kind="svg", scale=8, border=3, dark="#000000", light="#ffffff", xmldecl=False)
    response = app.response_class(out.getvalue(), mimetype="image/svg+xml")
    response.headers["Cache-Control"] = "max-age=86400"
    return response


@app.get("/api/phones/location")
def phonesLocation():
    """Where you are, from the test phones' GPS (Maps' "you" dot - the laptop has no GPS)."""
    from kaam import phoneControl
    try:
        return jsonify({"location": phoneControl.phoneLocation()})
    except Exception as error:
        return jsonify({"location": None, "error": str(error)})


@app.get("/api/connection")
def connectionInfo():
    """The Connection page: this PC's address on the WiFi it's connected to (the card its internet
    goes out on) and the app's port, as the link others on the same WiFi open. Read fresh each
    time, so a different WiFi shows its own address."""
    port = request.environ.get("SERVER_PORT") or request.host.rpartition(":")[2] or "5000"
    primary = ""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))  # no packet is sent; just picks the outgoing card
            primary = probe.getsockname()[0]
    except OSError:
        pass
    if primary.startswith(("127.", "169.254.", "0.")):
        primary = ""
    others = [ip for ip in lanAddresses() if ip != primary]
    # Windows Mobile hotspot (this laptop sharing its internet) always gives itself 192.168.137.1.
    # Phone hotspots often keep their devices apart (each reaches only the phone), so a tablet on
    # the laptop's own hotspot is the way round that.
    hotspot = next((ip for ip in others if ip.startswith("192.168.137.")), "")
    others = [ip for ip in others if ip != hotspot]
    return jsonify({"lanAccess": config.lanAccess, "port": int(port), "ip": primary,
                    "url": f"http://{primary}:{port}" if primary else "",
                    "hotspot": {"ip": hotspot, "url": f"http://{hotspot}:{port}"} if hotspot else None,
                    "others": [{"ip": ip, "url": f"http://{ip}:{port}"} for ip in others],
                    "openedFrom": request.host})


@app.post("/api/records/<path:wo>/later")
def recordLater(wo):
    """Needs redo -> Do later ({kind: end / close}), or back ({later: false}: End now / Close now)."""
    data = body()
    try:
        record = workflows.setLater(wo, data.get("kind", ""), data.get("later", True) is not False)
    except workflows.WorkflowError as error:
        return fail(str(error))
    return jsonify(detail(record))


@app.post("/api/records/<path:wo>/location")
def recordSendLocation(wo):
    return jsonify({"message": workflows.sendLocation(wo)})


# ---------- start ----------
@app.get("/api/start/waiting")
def startWaiting():
    records, stops = inMapOrder(notStartedRecords())
    return jsonify([{**summary(r), "mapStop": n + 1 if n < stops else None} for n, r in enumerate(records)])


@app.post("/api/start/order")
def startOrderSave():
    """Start's To start list dragged into a new order ({keys}): saved as today's order on Maps too
    ("Your order · saved"), so Start, Maps and Sheets all follow it. Stops Maps had that aren't on
    the list (e.g. not in TEMS yet) keep their place after these."""
    import json
    keys = [str(key) for key in (body().get("keys") or []) if key]
    if not keys:
        return fail("Nothing to order.")
    today = datetime.now().date().isoformat()
    with routeOrderLock:
        orders, sequences = readRouteOrders(), readRouteSequences()
        before = sequences.get(today) or orders.get(today) or []
        order = keys + [key for key in before if key not in keys]
        orders[today] = order
        sequences[today] = order
        orders = {d: orders[d] for d in sorted(orders, reverse=True)[:60]}
        sequences = {d: sequences[d] for d in sorted(sequences, reverse=True)[:14]}
        for path, value in ((routeOrderFile, orders), (routeSequenceFile, sequences)):
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps(value, indent=1), encoding="utf-8")
            os.replace(temp, path)
    return jsonify({"ok": True, "order": order})


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


def notInTemsRecords():
    """Every not-started WO the plan check didn't find in TEMS (any import, saved in tickets.json):
    off Start's list until a recheck finds them."""
    rows = [r for r in searchRecords() if r.get("temsCheck") == "missing" and not r.get("startedAt")]
    return sorted(rows, key=lambda r: (r.get("importedAt") or "", r.get("importOrder") or 0))


@app.get("/api/import/notInTems")
def importNotInTems():
    return jsonify([{"wo": r["wo"], "cluster": r.get("cluster") or "", "gridKey": r.get("gridKey") or "",
                     "planDate": planDateOf(r.get("wo")), "importSource": r.get("importSource") or "",
                     "temsCheckAt": r.get("temsCheckAt") or ""} for r in notInTemsRecords()])


def lastImportRecords():
    """The WOs of the latest import (the records it saved or refreshed), in the plan's order."""
    records = [r for r in searchRecords() if r.get("importedAt")]
    if not records:
        return []
    latest = max(r["importedAt"] for r in records)
    return sorted((r for r in records if r["importedAt"] == latest), key=lambda r: r.get("importOrder") or 0)


def planDateOf(wo):
    """The plan date in a WO name (..._110426_... = Nov 4, 2026) as YYYY-MM-DD, or ""."""
    import re
    match = re.search(r"_(\d{2})(\d{2})(\d{2})_", wo or "")
    if not match:
        return ""
    month, day, year = match.groups()
    return f"20{year}-{month}-{day}" if 1 <= int(month) <= 12 and 1 <= int(day) <= 31 else ""


@app.get("/api/import/last")
def importLast():
    """The latest import as a table: each WO, its plan spelling, and whether TEMS has it."""
    records = lastImportRecords()
    rows = [{**summary(r), "excelWo": r.get("excelWo") or "", "planDate": planDateOf(r.get("wo")),
             "importOrder": r.get("importOrder"), "temsCheck": r.get("temsCheck") or "",
             "temsWhere": r.get("temsWhere") or "", "temsName": r.get("temsName") or "",
             "temsCheckAt": r.get("temsCheckAt") or ""} for r in records]
    first = records[0] if records else {}
    return jsonify({"source": first.get("importSource") or "", "importedAt": first.get("importedAt") or "",
                    "rows": rows})


@app.post("/api/import/check")
def importCheck():
    """Plan check: are the WOs (default: the latest import) in TEMS Cloud / on Assign? A job."""
    wos = body().get("wos") or [r["wo"] for r in lastImportRecords()]
    if not wos:
        return fail("Import a plan first.")
    job = startJob("planCheck", "", f"TEMS check · {len(wos)} WOs",
                   lambda job: workflows.checkPlanInTems(wos, progress=job.progress))
    return jsonify({"job": job.toJson()})


@app.get("/api/import/missing.xlsx")
def importMissingExcel():
    """Every WO still waiting on TEMS, one per row (for the coordinators)."""
    import io
    from openpyxl import Workbook
    from openpyxl.styles import Font
    missing = [r["wo"] for r in notInTemsRecords()]
    book = Workbook()
    sheet = book.active
    sheet.title = "Not in TEMS"
    sheet.append(["WO"])
    sheet["A1"].font = Font(bold=True)
    for wo in missing:
        sheet.append([wo])
    sheet.column_dimensions["A"].width = max([len(wo) for wo in missing] + [12]) + 4
    data = io.BytesIO()
    book.save(data)
    data.seek(0)
    return send_file(data, as_attachment=True, download_name=f"WOs not in TEMS {datetime.now():%m-%d-%Y}.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


# ---------- end ----------
def readyToEnd(record):
    """TEMS has written the WO's result (GridSummary.csv) - it's driven and can be ended."""
    from kaam.gridSummary import resultReady
    return resultReady(record["wo"])


def resultAt(record):
    """ISO time TEMS wrote the WO's GridSummary, or None."""
    from datetime import datetime
    from kaam.gridSummary import resultTime
    made = resultTime(record["wo"])
    return datetime.fromtimestamp(made).isoformat() if made else None


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
    first - all uploads, then the WhatsApp shares (only what uploaded fully). {wos}: just those
    (Redo: the ones that stopped with a problem)."""
    data = body()
    rows = sorted((r for r in openTicketsToday() if readyToEnd(r)), key=lambda r: r.get("startedAt") or "")
    if data.get("wos"):
        wanted = {woKey(wo) for wo in data["wos"]}
        rows = [r for r in rows if woKey(r["wo"]) in wanted]
    else:
        rows = [r for r in rows if not r.get("endLater")]  # put off with Do later
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


@app.post("/api/close/runAll")
def closeRunAll():
    """Close Tickets: every ready-to-close ticket, the one started first first ({wos}: just those -
    Redo). One that fails keeps its problem and isn't marked closed; the run goes on with the next."""
    data = body()
    rows = sorted((r for r in searchRecords("") if workflows.isReadyToClose(r) and workflows.closeState(r)["canClose"]),
                  key=lambda r: r.get("startedAt") or "")
    if data.get("wos"):
        wanted = {woKey(wo) for wo in data["wos"]}
        rows = [r for r in rows if woKey(r["wo"]) in wanted]
    wos = [r["wo"] for r in rows]
    if not wos:
        return fail("Nothing to close - no ticket is ready.")
    job = startJob("closeAll", "", f"Close {len(wos)} tickets", lambda job: workflows.closeAll(wos, post=job.post))
    return jsonify({"job": job.toJson(), "wos": wos})


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


@app.post("/api/whatsapp/many")
def whatsappMany():
    """Several WOs in one WhatsApp run ({wos, group?}), Send pressed: the chat opened once, then each
    WO's CSV + report + picture back to back. Another group than the summary group = a test: sent
    there, nothing saved on the WOs. The result has each WO's time and the total."""
    data = body()
    wos = [workflows.cleanWorkOrder(wo) for wo in data.get("wos") or []]
    wos = [wo for wo in wos if wo]
    if not wos:
        return fail("No WOs to share.")
    group = (data.get("group") or "").strip() or config.whatsappGroup
    isTest = group != config.whatsappGroup

    def work(job):
        started = time.time()
        # A test group may get the same WOs again (to time it); the real group never gets one twice.
        results = workflows.shareTickets(wos, group=group, progress=job.progress, save=not isTest,
                                         checkFirst=not (isTest and data.get("again")))
        total = round(time.time() - started, 1)
        sent = [r for r in results.values() if r.get("ok")]
        perWo = round(total / len(sent), 1) if sent else None
        lines = [f"{len(sent)} of {len(wos)} shared to \"{group}\" in {total}s"
                 + (f" ({perWo}s per WO, opening WhatsApp and the chat included)" if perWo else "") + "."]
        lines += [f"{wo}: {r['seconds']}s" for wo, r in results.items() if r.get("ok") and r.get("seconds")]
        lines += [f"{wo}: {r.get('error')}" for wo, r in results.items() if not r.get("ok")]
        return {"ok": len(sent) == len(wos), "summary": "\n".join(lines), "total": total, "perWo": perWo,
                "items": list(results.values()), "test": isTest}
    job = startJob("whatsapp", f"many:{group}", f"WhatsApp {group}: {len(wos)} WOs", work)
    return jsonify({"job": job.toJson()})


@app.post("/api/whatsapp/inspect")
def whatsappInspect():
    """Sends nothing: opens the group in WhatsApp Web and describes its last messages (markers, icons,
    labels - no text), to keep the "already in the chat" check working when WhatsApp changes."""
    import urllib.parse
    from kaam.chromeBridge import bridgePort, runInChrome
    data = body()
    group = (data.get("group") or "").strip() or config.whatsappGroup
    lookFor = (data.get("lookFor") or "").strip()

    def work(job):
        message = runInChrome(lambda requestId: f"http://127.0.0.1:{bridgePort}/whatsapp#" + urllib.parse.urlencode({
            "kaamId": requestId, "kaamGroup": group, "kaamSend": "0", "kaamInspect": lookFor or "-"}), timeout=120)
        return {"ok": bool(message.get("ok")), "summary": message.get("summary") or message.get("error") or "",
                "inspect": message.get("inspect")}
    job = startJob("whatsapp", f"inspect:{group}", f"WhatsApp {group}: inspect", work)
    return jsonify({"job": job.toJson()})


@app.post("/api/whatsapp/woDone")
def whatsappWoDone():
    """Sheets' Coordinator Data: the whole list ("<WO> - Done" per line) in one message to the WO group."""
    data = body()
    wos = [workflows.cleanWorkOrder(wo) for wo in data.get("wos") or []]
    wos = [wo for wo in wos if wo]
    if not wos:
        return fail("No WOs to send.")
    if not config.whatsappWoGroup:
        return fail("No WO group set - add WHATSAPP_GROUP_WO in Settings (WhatsApp) first.")
    send = data.get("send")

    def work(job):
        summary = workflows.sendWoDone(wos, send=send, progress=job.progress, onlyNew=False)
        if "not sent" in summary:
            raise RuntimeError(summary)
        return {"ok": True, "summary": summary}
    job = startJob("whatsappWo", "", f"WhatsApp {config.whatsappWoGroup}: {len(wos)} done", work)
    return jsonify({"job": job.toJson()})


# A WO is "active" in TEMS (Control and Map show it) from Opening until it's closed: Opening, Opened,
# Validating, Validated, Executing, Executed (results waiting), Pausing, Paused, Recovering.
temsActiveStates = (1, 2, 5, 6, 7, 8, 9, 10, 12)


def temsActiveCheck(wo):
    """Which WO TEMS has active right now (its own data - what Control shows), and whether it's `wo`.
    {reachable, active, openWo, state, stateName, same, otherWo (a different WO is active), closed
    (TEMS's last word on `wo` is Closed)}. Read-only."""
    from kaam import temsMap
    try:
        state = temsMap.workOrderState()
    except Exception as error:
        return {"reachable": False, "error": str(error)}
    active = state["state"] in temsActiveStates and bool(state["wo"])
    same = bool(wo and state["wo"] and sameWo(state["wo"], wo))
    return {"reachable": True, "active": active, "openWo": state["wo"], "state": state["state"],
            "stateName": state["stateName"], "same": same and active,
            "otherWo": state["wo"] if active and wo and not same else "",
            "closed": same and state["state"] == 4}


@app.get("/api/tems/active")
def temsActive():
    """Start Ticket asks first: is a WO already active in TEMS, and is it this one?"""
    return jsonify(temsActiveCheck(workflows.cleanWorkOrder(request.args.get("wo", ""))))


def otherWoMessage(wo, check):
    return (f"The WO you want, {wo}, isn't running in TEMS - {check['otherWo']} is ({check['stateName']}). "
            f"Nothing pressed. Finish, suspend or close {check['otherWo']} in TEMS first, or pick it here.")


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
        return temsPlay(wo)
    if action in ("suspend", "discard", "submit"):
        return temsEnd(action, wo)
    if action == "openWo":
        return fail("openWo is part of Start Stationary.")
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


def sameWo(a, b):
    """Same WO, ignoring case, spaces / dashes and the G23d / G23e letter."""
    import re

    def norm(text):
        return re.sub(r"(g\d+)[de]", r"\1", re.sub(r"[^a-z0-9]", "", (text or "").lower()))
    return norm(a) == norm(b)


def reopenPhones(progress):
    """Start Stationary: close the TMO 1 / TMO 2 Vysor windows and open them again (fresh mirror)."""
    from kaam import phoneControl
    from kaam.deskLayout import closePhones, layoutDesk
    phoneControl.listenHere(progress)
    try:
        closePhones()
        time.sleep(1.5)
        layoutDesk()
    except Exception as error:
        progress(f"Phones: couldn't reopen them ({error}) - press Set up desk")
    finally:
        phoneControl.listenHere(None)


def temsPlay(wo=""):
    """Live Testing's Start Stationary: the phones' Vysor windows closed and opened again (at the
    same time as the rest), then in TEMS: if the WO isn't open, Assign -> the WO -> Open and wait
    until TEMS has it ready (Validated, green); then the Control page and play - only when TEMS
    says Validated / Paused (never while it runs - that would pause it). Stays on TEMS."""
    from kaam import temsMap

    def readState():
        try:
            return temsMap.workOrderState()
        except Exception as error:
            raise RuntimeError(f"TEMS isn't answering at {config.temsUrl} - is TEMS Paragon running? ({error})")

    def work(job):
        check = temsActiveCheck(wo)
        if check.get("otherWo"):  # TEMS has another WO active: the pop-up says so, nothing pressed
            job.progress(f"TEMS: {check['otherWo']} is active ({check['stateName']}), not {wo}")
            return {"ok": False, "otherWo": check["otherWo"], "otherState": check["stateName"], "wantedWo": wo,
                    "error": otherWoMessage(wo, check)}
        if check.get("same") and check.get("state") == 8:  # its run is over, results waiting
            if getRecord(wo) and not ticketFlow.currentRun(getRecord(wo)):  # ...an older ticket's run
                return {"ok": False, "staleResults": True,
                        "error": f"TEMS shows the results of an earlier run of {wo}, not this ticket's - nothing pressed. "
                                 "Discard or suspend it in TEMS first (or, if you tested it by hand, press \"It's this ticket's run\")."}
            return {"ok": True, "summary": f"TEMS: {wo} has finished its run - Submit, Discard or Suspend it (nothing pressed)."}
        runWo = temsRunWo(wo)
        if runWo:
            noteFreshRun(runWo)  # before play: what TEMS shows of the old run
            from kaam.chromeBridge import resetStationaryAlert
            resetStationaryAlert(runWo)  # stationary fails are counted per run
        phones = threading.Thread(target=reopenPhones, args=(job.progress,), daemon=True)
        phones.start()
        try:
            result = startOnTems(job)
        finally:
            phones.join(60)
        said = result.get("summary") or ""
        if runWo and result.get("ok") and ("started (Executing)" in said or "already running" in said):
            markRunStarted(runWo, "Start Stationary" if "started" in said else "already running in TEMS")
        return result

    def waitReady(job, before, stopOnCloud=True):
        """Up to ~2 min for Validated / Paused (or Executing: already running). Stops early when TEMS
        says it isn't connected to TEMS Cloud - the play step logs in first then."""
        for _ in range(80):  # Opening -> Opened -> Validating -> Validated
            if before["state"] in temsMap.playable or before["state"] == temsMap.executing:
                break
            if stopOnCloud and temsMap.cloudOffline(before["error"]):
                job.progress(f"TEMS says \"{before['error']}\" - logging in to TEMS Cloud before play")
                break
            time.sleep(1.5)
            before = readState()
        return before

    def startOnTems(job):
        before = readState()
        name = before["wo"] or "the open WO"
        job.progress(f"TEMS: {name} is {before['stateName']}" + (f" ({before['error']})" if before["error"] else ""))
        if before["state"] == temsMap.executing:
            return {"ok": True, "summary": f"TEMS: {name} is already running - nothing pressed."}
        isOpen = before["state"] in (1, 2, 5, 6, 9, 10)  # Opening / Opened / Validating / Validated / Pausing / Paused
        if isOpen and wo and before["wo"] and not sameWo(before["wo"], wo):
            raise RuntimeError(f"TEMS has {before['wo']} open, not {wo} - nothing pressed. Close it in TEMS "
                               "or pick that WO here.")
        if not isOpen:
            if not wo:
                raise RuntimeError(f"TEMS has no WO open ({before['stateName']}) - pick the WO here so it can be opened from Assign.")
            job.progress(f"TEMS: opening {wo} from Assign…")
            opened = runTems("openWo", wo=wo, timeout=3 * 60)
            if not opened.get("ok"):
                return opened
            job.progress(opened.get("summary") or "Opened")
        if before["state"] not in temsMap.playable:
            job.progress("Waiting for TEMS to have it ready (green)…")
            before = waitReady(job, before)
            if temsMap.cloudOffline(before["error"]) and before["state"] not in temsMap.playable:
                login = runTems("cloudLogin", timeout=5 * 60)
                if not login.get("ok"):
                    return {"ok": False, "error": f"TEMS isn't connected to TEMS Cloud and the login didn't work: {login.get('error')}"}
                job.progress(login.get("summary") or "Logged in to TEMS Cloud")
                before = waitReady(job, readState(), stopOnCloud=False)
            job.progress(f"TEMS: {before['wo'] or name} is {before['stateName']}")
            name = before["wo"] or name
            if before["state"] == temsMap.executing:
                return {"ok": True, "summary": f"TEMS: {name} is already running - nothing pressed."}
        canPlay = before["state"] in temsMap.playable
        job.progress("Opening TEMS Control" + (", pressing play…" if canPlay else " (play isn't ready yet)…"))
        result = runTems("play", canPlay=canPlay)
        if not result.get("ok"):
            return result
        if result.get("cloudLogin") and not result.get("played"):
            # TEMS wasn't connected to Cloud: the extension logged in and went back to Control. Now
            # wait for it to be ready again and press play once more.
            job.progress(result.get("summary") or "Logged in to TEMS Cloud")
            job.progress("Waiting for TEMS to have it ready (green) now that Cloud is logged in…")
            before = waitReady(job, readState(), stopOnCloud=False)
            name = before["wo"] or name
            if before["state"] == temsMap.executing:
                return {"ok": True, "summary": f"TEMS: {name} is already running - nothing pressed."}
            canPlay = before["state"] in temsMap.playable
            if canPlay:
                job.progress("TEMS: pressing play on Control…")
                result = runTems("play", canPlay=True)
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
    ticketFlow.logClick(wo, "Start Stationary")
    job = startJob("tems", wo, "TEMS: start stationary", work)
    return jsonify({"job": job.toJson()})


def newRunInTems(wo, record):
    """TEMS is running the WO: is that a run the app doesn't know yet? Yes when this ticket has no
    run, or its run was discarded / suspended. Never while Submit replays it, or once submitted."""
    if (submitRuns.get(woKey(wo)) or {}).get("state") == "running":
        return False
    if not ticketFlow.currentRun(record):
        return True
    ended = runEnded(wo)
    return bool(ended) and ended.get("as") in ("discard", "suspend")


def markRunStarted(wo, how):
    """TEMS runs the WO now: a new run for this ticket - unless its run is still going (play
    resumed a paused run, or it was already running): then nothing changes."""
    endedRuns.pop(woKey(wo), None)
    record = getRecord(wo)
    if not record:
        return
    if not ticketFlow.currentRun(record) or runEnded(wo):
        from kaam.chromeBridge import resetStationaryAlert
        resetStationaryAlert(wo)  # a new run: stationary fails count from 0
        ticketFlow.runStarted(wo, how)
    else:
        workflows.safeSave(wo, event=f"TEMS: running ({how})")


def saveTemsPicture(wo, dataUrl):
    """Submit's picture of TEMS into the pictures folder (one per WO, replaces an older one); the
    WO's record remembers where. Returns the path."""
    import base64
    path, _ = savePicture(wo or "TEMS", base64.b64decode(dataUrl.split(",", 1)[1]), "picture.png", source="TEMS Submit")
    return path


endWords = {"submit": "submitted", "discard": "discarded", "suspend": "suspended"}


def temsRunWo(wo=""):
    """The WO a TEMS run belongs to: the one picked on Live Testing, else the one TEMS has open."""
    if wo:
        return wo
    from kaam import temsMap
    try:
        return temsMap.workOrderState().get("wo") or ""
    except Exception:
        return ""


def markRunEnded(wo, action):
    """This WO's TEMS run is over (Submit / Discard / Suspend went through): Live Testing stops
    showing it as a running test - also the WO Submit reopens - until Start Stationary is pressed."""
    if not wo:
        return
    from kaam.ticketStore import now as stamp
    if getRecord(wo):
        workflows.safeSave(wo, event=f"TEMS: test {endWords[action]}", temsRunEnd=action, temsRunEndedAt=stamp())
    else:
        endedRuns[woKey(wo)] = {"temsRunEnd": action, "temsRunEndedAt": stamp()}


endedRuns = {}  # WOs not in Records: kept here (until the app restarts)

# A run just started with Start Stationary (after a Discard / Suspend, say): TEMS can still show the
# old run's counts as all done for a while, and its tab's watcher can still say "complete". Until
# TEMS's counts drop (the new run reset them), "complete" isn't believed - the pop-up shows stationary.
freshRuns = {}  # woKey -> {"at": time, "stale": the old run's counts showed all done, "reset": seen them drop}
freshGraceSeconds = 90  # no reading at the start: "complete" isn't believed this soon either


def allDone(status):
    stationary, mobility = status.get("stationary") or {}, status.get("mobility") or {}
    total = (stationary.get("total") or 0) + (mobility.get("total") or 0)
    return bool(total) and (stationary.get("done") or 0) >= (stationary.get("total") or 0)         and (mobility.get("done") or 0) >= (mobility.get("total") or 0)


def noteFreshRun(wo):
    from kaam import temsMap
    try:
        stale = allDone(temsMap.testStatus())
    except Exception:
        stale = None  # couldn't read: the grace time covers it
    freshRuns[woKey(wo)] = {"at": time.time(), "stale": stale, "reset": False}


def freshRunStage(wo, status, stage):
    """The stage to show for a run that just started: "complete" from the old run -> "stationary"."""
    run = freshRuns.get(woKey(wo)) if wo else None
    if not run or run["reset"]:
        return stage
    if status.get("online") and not allDone(status):
        run["reset"] = True  # the new run's counts are in: TEMS is right from here on
        return stage
    young = time.time() - run["at"] < freshGraceSeconds
    if stage == "complete" and (run["stale"] or (run["stale"] is None and young)):
        return "stationary"
    return stage


def runEnded(wo):
    """{"as": submit / discard / suspend, "at": iso} when this WO's last TEMS run was ended here
    after its last Start Stationary, else None."""
    if not wo:
        return None
    record = getRecord(wo)
    if record:  # only this ticket's run (an older ticket's end says nothing about this one)
        ended, started = ticketFlow.mine(record, "temsRunEndedAt"), ticketFlow.currentRun(record)
    else:
        record = endedRuns.get(woKey(wo)) or {}
        ended, started = record.get("temsRunEndedAt"), record.get("temsRunStartedAt")
    if ended and (not started or started < ended):
        return {"as": record.get("temsRunEnd") or "", "at": ended}
    return None


# ---------- Submit's progress, step by step (Live Testing's pop-up shows it) ----------
submitSteps = [("suspend", "Suspend in TEMS"), ("picture", "Picture of the WO"), ("reopen", "Opened again"),
               ("play", "Play pressed"), ("results", "Results showing Submit / Discard / Suspend"),
               ("submit", "Submit pressed in TEMS")]
submitRuns = {}       # woKey -> the run (also saved on the record as temsSubmit, for a restart)
lastSubmit = {"key": ""}


class SubmitRun:
    """One Submit: each step's state (working / done / failed), where it got stuck and why."""

    def __init__(self, wo, jobId):
        self.data = {"wo": wo, "jobId": jobId, "state": "running", "steps": {}, "failedAt": "", "error": "",
                     "picture": "", "byHand": False, "closed": False,
                     "startedAt": datetime.now().isoformat(timespec="seconds"), "endedAt": ""}
        submitRuns[woKey(wo)] = self.data
        lastSubmit["key"] = woKey(wo)
        self.save()

    def save(self):
        wo = self.data["wo"]
        if wo and getRecord(wo):
            workflows.safeSave(wo, temsSubmit=dict(self.data))

    def step(self, key, state, save=True):
        self.data["steps"][key] = state
        if save:
            self.save()

    def done(self, keys):
        for key in keys:
            self.step(key, "done", save=False)
        self.save()

    def fail(self, error, at=""):
        """Stuck: at the first step not done yet (or `at`)."""
        at = at or next((key for key, _ in submitSteps if self.data["steps"].get(key) != "done"), "")
        if at:
            self.data["steps"][at] = "failed"
        for key, state in list(self.data["steps"].items()):
            if state == "working" and key != at:
                self.data["steps"][key] = ""
        self.data.update(state="failed", failedAt=at, error=str(error),
                         endedAt=datetime.now().isoformat(timespec="seconds"))
        self.save()

    def finish(self):
        self.data.update(state="done", endedAt=datetime.now().isoformat(timespec="seconds"))
        self.save()


def submitRunFor(wo=""):
    """The Submit run to show: this WO's (this ticket's), else (no WO given) the latest one - unless
    it was closed. A run the app was in the middle of when it restarted shows as stuck."""
    run = submitRuns.get(woKey(wo)) if wo else None
    start = ticketFlow.ticketStart(getRecord(wo)) if wo else ""
    if run and start and (run.get("startedAt") or "") < start:
        run = None  # an older ticket's Submit
    if not run and wo:
        saved = (getRecord(wo) or {}).get("temsSubmit")
        if saved and start and (saved.get("startedAt") or "") < start:
            saved = None
        if saved:
            run = dict(saved)
            if run.get("state") == "running":
                at = next((k for k, _ in submitSteps if (run.get("steps") or {}).get(k) != "done"), "")
                run.update(state="failed", failedAt=at, error="The app restarted while it was submitting.")
                run.setdefault("steps", {})[at] = "failed"
            submitRuns[woKey(wo)] = run
    if not run and not wo and lastSubmit["key"]:
        run = submitRuns.get(lastSubmit["key"])
    return run if run and not run.get("closed") else None


def submitToResults(job, runWo, run):
    """Submit's steps after the picture: wait until TEMS has the reopened WO ready, press play
    (warnings get OK), then look on TEMS's Results page for Submit / Discard / Suspend (reloading
    TEMS only when they're not there), up to ~10 minutes, and press Submit. Returns (ok, summary)."""
    from kaam import temsMap
    from kaam.chromeBridge import raiseIfStopped
    def stuck(text):
        run.fail(text)
        return False, text
    run.step("play", "working")
    job.progress("TEMS: waiting for the WO to be ready (green) to press play…")

    def waitReady(stopOnCloud=True):
        state = {}
        for _ in range(80):  # ~2 min: Opening -> Opened -> Validating -> Validated
            raiseIfStopped()
            try:
                state = temsMap.workOrderState()
            except Exception:
                state = {}
            if state.get("state") in temsMap.playable or state.get("state") == temsMap.executing:
                break
            if stopOnCloud and temsMap.cloudOffline(state.get("error")):
                break
            time.sleep(1.5)
        return state
    state = waitReady()
    if temsMap.cloudOffline(state.get("error")) and state.get("state") not in temsMap.playable:
        # TEMS isn't connected to TEMS Cloud: the play step logs in (Cloud tab), goes back to Control
        # and then the WO gets ready - wait for that, then press play below.
        job.progress(f"TEMS says \"{state.get('error')}\" - logging in to TEMS Cloud, then back to Control…")
        login = runTems("cloudLogin", wo=runWo, timeout=5 * 60)
        if not login.get("ok"):
            return stuck(f"TEMS isn't connected to TEMS Cloud and the login didn't work: {login.get('error')}")
        job.progress(login.get("summary") or "Logged in to TEMS Cloud")
        state = waitReady(stopOnCloud=False)
    if state.get("state") in temsMap.playable:
        job.progress("TEMS: pressing play on Control…")
        played = runTems("play", wo=runWo, canPlay=True, timeout=5 * 60)  # 5 min: a Cloud login may come first
        if not played.get("ok"):
            return stuck(f"Play didn't go through: {played.get('error')}")
        job.progress(played.get("summary") or "Play pressed")
        if played.get("cloudLogin") and not played.get("played"):  # logged in to Cloud, play wasn't ready yet
            state = waitReady(stopOnCloud=False)
            if state.get("state") in temsMap.playable:
                played = runTems("play", wo=runWo, canPlay=True, timeout=5 * 60)
                if not played.get("ok") or not played.get("played"):
                    return stuck(f"Logged in to TEMS Cloud, but play didn't go through: {played.get('error') or played.get('summary')}")
                job.progress(played.get("summary") or "Play pressed")
            elif state.get("state") != temsMap.executing:
                return stuck(f"Logged in to TEMS Cloud, but TEMS never had the WO ready to play ({state.get('stateName') or 'no answer'}"
                             + (f": {state.get('error')}" if state.get("error") else "") + ").")
    elif state.get("state") == temsMap.executing:
        job.progress("TEMS: already running - no play needed.")
    else:
        return stuck(f"TEMS never had the WO ready to play ({state.get('stateName') or 'no answer'}"
                     + (f": {state.get('error')}" if state.get("error") else "") + ").")
    run.step("play", "done", save=False)
    run.step("results", "working")
    started = time.time()
    attempt = 0
    while time.time() - started < 10 * 60:
        raiseIfStopped()
        attempt += 1
        job.progress(f"TEMS: Results - looking for Submit / Discard / Suspend, reloading if they're not there (try {attempt})…")
        check = runTems("results", wo=runWo, timeout=3 * 60)
        if check.get("found") or "no Submit button" in (check.get("error") or ""):
            run.step("results", "done", save=False)
            run.step("submit", "working")
        if check.get("found") and check.get("submitted"):
            run.step("submit", "done")
            return True, check.get("summary") or "Submit pressed."
        if check.get("found") or "no Submit button" in (check.get("error") or ""):
            return stuck(f"Submit / Discard / Suspend showed, but Submit wasn't pressed: {check.get('error') or '?'}")
        if not check.get("ok"):
            job.progress(f"Results check: {check.get('error')}")
        time.sleep(15)  # give TEMS a moment, then reload again
    return stuck("Submit / Discard / Suspend didn't show on Results within 10 minutes.")


def temsEnd(action, wo=""):
    """TEMS's finished-test page (stationary + mobility done): Suspend / Discard / Submit.
    Discard / Suspend: the WO gets tested again. Submit: Suspend, a picture of the WO's details on
    Assign (saved in the pictures folder and on the WO - WhatsApp sends it with the CSV), open it
    again, press play, then Results (reloaded until Submit / Discard / Suspend show) and press Submit.
    Every one of them ends the run here: Live Testing no longer shows it as a test."""
    from kaam.chromeBridge import setTemsStage
    runWo = temsRunWo(wo) or wo
    ticketFlow.logClick(runWo, action.capitalize())
    track = {}
    already = (submitRuns.get(woKey(runWo)) or {}).get("state") == "running"
    if action == "submit" and not already:  # (already running: startJob hands back that job)
        track["run"] = SubmitRun(runWo, "")

    def work(job):
        run = track.get("run")
        try:
            return steps(job, run)
        except Exception as error:  # Stop pressed / anything unexpected: the pop-up says where
            if run and run.data["state"] == "running":
                run.fail("Stopped by you." if type(error).__name__ == "StoppedError" else error)
            raise

    def steps(job, run):
        job.progress({"suspend": "TEMS: Suspend…", "discard": "TEMS: Discard (and Yes)…",
                      "submit": "TEMS: Chrome full window, Suspend, then a picture of the WO on Assign…"}[action])
        if run:
            run.step("suspend", "working")
        result = runTems(action, wo=runWo, timeout=6 * 60)
        picture = result.pop("screenshot", None)
        stepsDone = result.pop("stepsDone", None) or []
        # Over once it went through - or once TEMS suspended / discarded it, even if a later step
        # (Submit's picture or reopen) had trouble: the run itself has ended either way.
        said = f"{result.get('summary') or ''} {result.get('error') or ''}".lower()
        if result.get("ok") or "suspended" in said or "discarded" in said or "suspend" in stepsDone:
            setTemsStage("closed", runWo)
            markRunEnded(runWo, action)
        if picture:
            path = saveTemsPicture(runWo, picture)
            result["summary"] = f"{result.get('summary') or 'Done'} Picture: {path}"
            result["picture"] = str(path)
            if run:
                run.data["picture"] = str(path)
                stepsDone = list(dict.fromkeys(stepsDone + ["picture"]))
        if action == "submit":
            if result.get("ok"):
                run.done(["suspend", "picture", "reopen"])
                ok, text = submitToResults(job, runWo, run)
                result["summary"] = f"{result['summary']} {text}"
                if ok:
                    run.finish()
                    ticketFlow.checkOut(runWo, "Submit")
                else:
                    result.update(ok=False, error=f"{result['summary']}")
            else:
                run.done([s for s in stepsDone if s in dict(submitSteps)])
                run.fail(result.get("error") or "TEMS didn't say what happened.")
        if runWo and getRecord(runWo):
            workflows.safeSave(runWo, event=result.get("summary") or result.get("error"))
        return result
    title = {"suspend": "TEMS: suspend", "discard": "TEMS: discard",
             "submit": "TEMS: submit (suspend, picture, play, results, Submit)"}[action]
    job = startJob("tems", runWo, f"{title}{f' {runWo}' if runWo else ''}", work)
    if track.get("run"):
        track["run"].data["jobId"] = job.id
    return jsonify({"job": job.toJson()})


@app.post("/api/tems/submit/close")
def temsSubmitClose():
    """The Submit pop-up's Close: it's not shown again. Submitted in TEMS (by the app or marked done
    by hand): the WO counts as done today from now on (Sheets' Coordinator data, Maps), even before
    End Ticket's uploads."""
    run = submitRunFor(body().get("wo", ""))
    if run:
        run["closed"] = True
        wo = run.get("wo") or ""
        record = getRecord(wo) if wo else None
        if record:
            fields = {"temsSubmit": dict(run)}
            event = None
            if run.get("state") == "done" and not record.get("submittedAt"):
                fields["submittedAt"] = datetime.now().isoformat(timespec="seconds")
                event = "Submitted in TEMS - moved to done (Coordinator data)"
            workflows.safeSave(wo, event=event, **fields)
    return jsonify({"ok": True})


@app.post("/api/tems/submit/done")
def temsSubmitDoneByHand():
    """Submit got stuck and you finished it in TEMS yourself: marked submitted, done and dusted."""
    from kaam.chromeBridge import setTemsStage
    run = submitRunFor(body().get("wo", ""))
    if not run:
        return fail("No Submit to mark.")
    wo = run.get("wo") or ""
    ticketFlow.logClick(wo, "Yes, I did it (Submit by hand)")
    ticketFlow.checkOut(wo, "submitted by hand")
    run.update(state="done", byHand=True, endedAt=datetime.now().isoformat(timespec="seconds"))
    setTemsStage("closed", wo)
    markRunEnded(wo, "submit")
    if wo and getRecord(wo):
        workflows.safeSave(wo, event=f"TEMS: Submit finished by hand (the app got stuck at {run.get('failedAt') or '?'})",
                           temsSubmit=dict(run))
    return jsonify({"ok": True, "submit": run})


@app.get("/api/tems/status")
def temsStatusNow():
    """Where the WO's test is right now - for Live Testing's test pop-up, also after an app restart.
    Read from TEMS itself (its data service: run state, stationary points and waypoints done), plus
    the TEMS tab's watcher when it reported in the last 2 minutes (it sees TEMS's screen). The
    further-along of the two wins. stage: idle / ready / stationary / mobility / complete / paused /
    failed / closed, or "" when TEMS can't be read."""
    from kaam import gridWatch, temsMap
    from kaam.chromeBridge import temsStage
    pageWo = workflows.cleanWorkOrder(request.args.get("wo", ""))
    gridWatch.watch(pageWo)  # check-in: is the car in this WO's grid yet?
    order = {"stationary": 1, "mobility": 2, "complete": 3}
    age = time.time() - temsStage["at"] if temsStage["at"] else None
    watched = temsStage["stage"] if age is not None and age < 120 else ""
    try:
        status = temsMap.testStatus()
        status["online"] = True
    except Exception as error:
        status = {"online": False, "error": str(error), "stage": "", "wo": temsStage["wo"] or ""}
    fresh = freshRuns.get(woKey(status.get("wo") or temsStage["wo"] or ""))
    if fresh and temsStage["at"] and temsStage["at"] < fresh["at"]:
        watched = ""  # the TEMS tab said that about the run before this Start Stationary
    stage, source = status.get("stage", ""), "tems"
    if watched == "closed" and stage not in ("stationary", "mobility", "complete"):
        stage, source = "closed", "watcher"
    elif watched in order and (order[watched] > order.get(stage, 0) or not status["online"]):
        stage, source = watched, "watcher"
    # Ended here (Submit / Discard / Suspend): TEMS may still show that run's data, Submit reopens
    # the WO, the TEMS tab may still say "complete" - none of it is a test any more.
    fixed = freshRunStage(status.get("wo") or temsStage["wo"], status, stage)
    if fixed != stage:
        stage, source = fixed, "freshRun"
    # the WO TEMS has: from TEMS, else from the TEMS tab only while its report is recent
    temsWo = status.get("wo") or (temsStage["wo"] if age is not None and age < 120 else "") or ""
    wo = pageWo or temsWo
    record = getRecord(wo) if wo else None
    otherWo = ""
    if pageWo and temsWo and not sameWo(pageWo, temsWo):
        # TEMS has another WO: its run, results or Submit say nothing about this one
        otherWo, stage, source = temsWo, "otherWo", "app"
    elif record and status.get("online") and status.get("state") == temsMap.executing and newRunInTems(wo, record):
        markRunStarted(wo, "started in TEMS")  # running now and not a run of ours: started by hand in TEMS
    elif record and stage in ("stationary", "mobility", "complete", "paused", "failed") \
            and not ticketFlow.currentRun(record):
        stage, source = "stale", "app"  # an earlier ticket's stationary test / results page
    if stage in ("mobility", "complete") and record:
        ticketFlow.noteStage(wo, stage)
    ended = runEnded(wo)
    if ended:
        stage, source = "ended", "app"
    # Submit's steps (running, done or stuck) until its pop-up is closed - this WO's only
    submit = submitRunFor(wo)
    record = getRecord(wo) if wo else None
    checkIn = {"at": ticketFlow.mine(record, "checkInTime"), "source": record.get("checkInSource") or ""} \
        if record and ticketFlow.mine(record, "checkInTime") else None
    from kaam.chromeBridge import stationaryAlert
    alertWo = stationaryAlert["wo"] or temsWo
    alert = stationaryAlert if (stationaryAlert["fails"] or stationaryAlert["waiting"]) and wo and sameWo(alertWo, wo) else None
    status["stationaryFail"] = {k: alert[k] for k in ("fails", "waiting", "ack")} if alert else None
    status.update(stage=stage, source=source, watcherStage=watched, watcherAge=age, ended=ended, otherWo=otherWo,
                  pageWo=pageWo, temsWo=temsWo, checkIn=checkIn, grid=gridWatch.state["last"] if pageWo else "",
                  flow=ticketFlow.flow(record) if record else [],
                  clicks=(record.get("clicks") or [])[-8:] if record else [],
                  submit=dict(submit, labels=dict(submitSteps), order=[k for k, _ in submitSteps]) if submit else None)
    return jsonify(status)


@app.post("/api/tems/stationaryRedo")
def temsStationaryRedo():
    """The stationary test failed and TEMS asks to start it again: Redo = press its OK."""
    from kaam.chromeBridge import stationaryAlert
    wo = workflows.cleanWorkOrder(body().get("wo", ""))
    ticketFlow.logClick(wo, "Redo stationary test", f"failed {stationaryAlert['fails']}x")
    stationaryAlert.update(waiting=False, ack=stationaryAlert["fails"])
    job = startJob("tems", wo, "TEMS: stationary test again (OK)", lambda job: runTems("stationaryOk", wo=wo, timeout=60))
    return jsonify({"job": job.toJson()})


@app.post("/api/tems/stationaryCancel")
def temsStationaryCancel():
    """The stationary test failed: Cancel = leave TEMS's pop-up alone, don't ask again for these fails."""
    from kaam.chromeBridge import stationaryAlert
    data = body()
    wo = workflows.cleanWorkOrder(data.get("wo", ""))
    fails = stationaryAlert["fails"]
    if data.get("skip"):  # failed 3 times or more: skipped, the ticket says so
        ticketFlow.logClick(wo, "Skip stationary", f"failed {fails}x")
        if wo and getRecord(wo):
            workflows.safeSave(wo, event=f"Stationary skipped - failed {fails} times",
                               stationarySkippedAt=datetime.now().isoformat(timespec="seconds"), stationaryFails=fails)
    else:
        ticketFlow.logClick(wo, "Cancel (stationary test failed)", f"failed {fails}x")
    stationaryAlert.update(waiting=False, ack=fails)
    return jsonify({"ok": True})


@app.post("/api/tems/adoptRun")
def temsAdoptRun():
    """\"It's this ticket's run\": what TEMS shows (tested by hand, outside the app) counts for this ticket."""
    wo = workflows.cleanWorkOrder(body().get("wo", ""))
    if not wo or not getRecord(wo):
        return fail("Pick a WO that's in Records.")
    ticketFlow.logClick(wo, "It's this ticket's run")
    ticketFlow.runStarted(wo, "by hand in TEMS")
    freshRuns.pop(woKey(wo), None)
    return jsonify({"ok": True})


@app.get("/api/tems/stage")
def temsStageNow():
    """Where the TEMS test is (from the TEMS tab's watcher) and how old that is."""
    from kaam.chromeBridge import temsStage
    age = time.time() - temsStage["at"] if temsStage["at"] else None
    return jsonify({"stage": temsStage["stage"], "wo": temsStage["wo"], "age": age})


# ---------- Live Testing (phones over adb, Vysor windows) ----------
liveActions = {
    "desk": "Set up desk",
    "closePhones": "Close TMO windows",
    "fullTestAll": "Test all, one by one",
    "fullTest": "Full test",
    "speedtest": "Speed test",
    "airplane": "Airplane toggle",
    "hotspot": "Hotspot on the best phone",
    "airplaneAll": "Airplane toggle on both",
}
deskActions = ("desk", "closePhones", "fullTestAll", "hotspot", "airplaneAll")  # use both phones: nothing else at the same time
liveLock = threading.Lock()  # the "is something else running?" check and the start, as one step


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
        speed = phoneControl.liveSpeeds.get(name)  # its speed test's live gauge, while running
        if speed and now - speed["at"] < 5:
            out.setdefault(name, {})["speed"] = {"value": speed["value"], "label": speed["label"]}
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
                  "location": result.get("location"), "runId": result.get("runId"),
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
    if action not in deskActions and not phone:
        return fail("Pick a phone.")
    missingWo = wo if wo and not getRecord(wo) else ""
    if missingWo:
        wo = ""  # still test; the result just isn't saved anywhere
    resultText = speedResultText

    def keep(job, result):
        """Shows the result on the page at once and saves it on the WO."""
        result["runId"] = job.id  # Test All's NR + LTE results share one spot on the map
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
            if action == "closePhones":
                from kaam.deskLayout import closePhones
                closed = closePhones()
                return (f"Closed {' and '.join(closed)} in Vysor - Set up desk opens them again."
                        if closed else "No TMO window was open in Vysor.")
            if action == "fullTestAll":
                connected = set(phoneControl.connectedSerials())
                serials = [s for s in phoneControl.configuredPhones().values() if s in connected]
                if not serials:
                    raise RuntimeError("Neither TMO 1 nor TMO 2 (Settings > Phones) is connected.")
                # one at a time (NR phones first, then LTE): two speed tests must not share the network
                results = phoneControl.fullTestOneByOne(serials, onResult=lambda r: keep(job, r),
                                                        onOrder=lambda names: job.post("order", names))
                return {"summary": " · ".join(resultText(r) for r in results), "results": results}
            if action == "hotspot":  # airplane on all at once, hotspot on the best of the quick ones
                connected = set(phoneControl.connectedSerials())
                serials = [s for s in phoneControl.configuredPhones().values() if s in connected]
                if not serials:
                    raise RuntimeError("Neither TMO 1 nor TMO 2 (Settings > Phones) is connected.")
                return phoneControl.hotspotAfterAirplane(serials)
            if action == "airplaneAll":  # airplane on and off on both phones at once
                connected = set(phoneControl.connectedSerials())
                serials = [s for s in phoneControl.configuredPhones().values() if s in connected]
                if not serials:
                    raise RuntimeError("Neither TMO 1 nor TMO 2 (Settings > Phones) is connected.")
                return phoneControl.airplaneAll(serials)
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

    # TMO 1 and TMO 2 run side by side (one job per phone); Set up desk / Close phones / Test All /
    # Hotspot use both phones, so they wait for everything and everything waits for them.
    title = liveActions[action] + (f" · {phone}" if action in ("fullTest", "speedtest", "airplane") else "")
    lane = action if action in deskActions else phone
    ticketFlow.logClick(wo, title)
    with liveLock:
        running = next((j for j in runningJobs("live")
                        if action in deskActions or j.wo in deskActions or j.wo == lane), None)
        if running:
            return fail(f"Wait for \"{running.title}\" to finish (or press Stop).")
        job = startJob("live", lane, title, work)
    return jsonify({"job": job.toJson()})


@app.post("/api/live/reboot")
def liveReboot():
    """Restart both phones at the same time. Nothing waits for it: the other buttons stay free."""
    from kaam import phoneControl
    try:
        connected = set(phoneControl.connectedSerials())
    except Exception as error:
        return fail(error, 503)
    phones = {name: serial for name, serial in phoneControl.configuredPhones().items() if serial in connected}
    if not phones:
        return fail("Neither TMO 1 nor TMO 2 (Settings > Phones) is connected.")
    ticketFlow.logClick(workflows.cleanWorkOrder(body().get("wo", "")), "Restart phones")
    for serial in phones.values():
        threading.Thread(target=phoneControl.runAdb, args=(["reboot"],), kwargs={"serial": serial, "timeout": 30},
                         daemon=True, name=f"reboot {serial}").start()
    return jsonify({"ok": True, "summary": f"Restarting {' and '.join(phones)} - back in about a minute."})


def setupDeskOnCheckIn(wo, kind, info):
    """In the grid for the first time: Set up desk by itself, so the phones are ready - unless a
    phone job is running (a speed test isn't interrupted)."""
    if kind != "checkIn":
        return
    from kaam import phoneControl
    from kaam.deskLayout import setupDesk

    def work(job):
        phoneControl.listenHere(job.progress)
        try:
            setupDesk()
            return f"{wo}: entered the grid - desk ready."
        finally:
            phoneControl.listenHere(None)
    with liveLock:
        playing = any("start stationary" in (j.title or "").lower() for j in runningJobs("tems"))
        if runningJobs("live") or playing:  # never in the middle of a speed test or Start Stationary's phone reopen
            workflows.safeSave(wo, event="Entered the grid: Set up desk skipped (phones busy)")
            return
        startJob("live", "desk", "Set up desk (entered the grid)", work)
    workflows.safeSave(wo, event="Entered the grid: Set up desk started by itself")


ticketFlow.listeners.append(setupDeskOnCheckIn)


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
