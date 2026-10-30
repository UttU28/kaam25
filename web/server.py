"""Kaam25 web app: a JSON API over kaam/ plus the single-page UI in web/static.

Run:  runWeb.bat   (or: venv\\Scripts\\python -m web.server)
Opens on http://127.0.0.1:5000 (or the next free port). Local only - it drives your Chrome.
"""

import os
import socket
import sys
import tempfile
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

projectDir = Path(__file__).resolve().parent.parent
if str(projectDir) not in sys.path:
    sys.path.insert(0, str(projectDir))  # so "python web/server.py" works too

from flask import Flask, jsonify, request, send_from_directory  # noqa: E402

from kaam import config, workflows  # noqa: E402
from kaam.chromeBridge import ChromeBridgeError, bridgeStatus, startBridge, stopAll  # noqa: E402
from kaam.gridSummary import buildFolderName, showInExplorer  # noqa: E402
from kaam.sheetImport import SheetImportError  # noqa: E402
from kaam.temsParagon import assignWoFor, openTemsCloud  # noqa: E402
from kaam.ticketLookup import currentDriveShift  # noqa: E402
from kaam.ticketStore import (TicketStoreError, cloudStartToday, deleteRecord, fileStamp, getRecord,  # noqa: E402
                              isLocalStart, localTicketId, moveToToday, nextLocalNumber, notStartedRecords,
                              openTicketsToday, searchRecords, woKey)
from kaam.workflows import WorkflowError  # noqa: E402

from web.jobs import getJob, listJobs, startJob  # noqa: E402

staticDir = Path(__file__).resolve().parent / "static"
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
    pmFrom = datetime.combine(datetime.now().date(), config.driveShiftPmFrom)
    return jsonify({
        "now": datetime.now().isoformat(timespec="seconds"),
        # Changes whenever tickets.json does (from any page, tab or Chrome job): pages refresh on it.
        "dataVersion": "-".join(map(str, fileStamp() or ())) + "|" + datetime.now().date().isoformat(),
        "employeeId": config.employeeId,
        "shift": currentDriveShift(), "pmFrom": pmFrom.strftime("%I:%M %p").lstrip("0"),
        "cloudStart": summary(cloud) if cloud else None,
        "nextLocalId": localTicketId(nextLocalNumber()),
        "counts": {
            "today": len(todays),
            "open": len(openTicketsToday()),
            "completedToday": sum(1 for r in todays if r.get("endedAt")),
            "toStart": len(notStartedRecords()),
            "readyToClose": sum(1 for r in records if workflows.isReadyToClose(r)),
            "whatsappPending": sum(1 for r in todays if r.get("endedAt") and not r.get("whatsappSentAt")),
            "total": len(records),
        },
        "today": [summary(r) for r in sorted(todays, key=lambda r: r.get("startedAt") or r.get("updatedAt") or "")],
        "bridge": bridgeStatus(),
        "jobs": [job for job in listJobs() if job["state"] == "running"],
    })


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
        "whatsappSend": config.whatsappSend, "whatsappRetries": config.whatsappRetries,
        "actixSubmit": config.actixSubmit, "closeTabsWhenDone": config.closeTabsWhenDone,
        "paths": {"Tickets file": str(config.ticketStoreFile), "Drive logs": str(config.logRootDir),
                  "Work order output": str(config.workOrderOutputDir), "Debug log": str(config.debugLogPath),
                  "Settings (.env)": str(config.envPath)},
        "urls": {"TechInsights": config.ticketsUrl, "ActixOne": config.actixUploadUrl, "TEMS Paragon": config.temsUrl, "TEMS project": config.temsProject,
                 "Apeksha": config.apekshaUrl},
        "bridge": bridgeStatus(),
    })


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
    return jsonify([summary(r) for r in notStartedRecords()])


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
@app.get("/api/end/open")
def endOpen():
    return jsonify([summary(r) for r in openTicketsToday()])


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
    """TEMS Paragon in Chrome: Cloud tab, TEMS Cloud login if needed, then (with a WO) open the
    project, find the WO and check Reserve - not clicked yet."""
    wo = workflows.cleanWorkOrder(body().get("wo", ""))

    def work(job):
        job.progress(f"Opening TEMS Paragon ({config.temsUrl}) in your Chrome…")
        job.progress("Cloud tab → Log in if needed (Chrome fills your saved password)…")
        if wo:
            job.progress(f"Then project {config.temsProject} → find {wo} → check Reserve (not clicked)…")
            job.progress(f"Then Assign → open {assignWoFor(wo)} → check Open (not clicked)…")
        return {"ok": True, "summary": openTemsCloud(wo)}
    job = startJob("tems", wo, f"TEMS {wo}" if wo else "TEMS Cloud login", work)
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
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pickPort(preferred=5000):
    for port in [preferred] + list(range(5001, 5021)):
        if isPortFree(port):
            return port
    raise SystemExit("No free port between 5000 and 5020.")


def findRunningApp(preferred=5000):
    """The URL of a Kaam25 web app already running on this computer, or None."""
    import json
    import urllib.request
    for port in [preferred] + list(range(5001, 5021)):
        url = f"http://127.0.0.1:{port}"
        try:
            with urllib.request.urlopen(f"{url}/api/state", timeout=0.4) as response:
                if "employeeId" in json.loads(response.read() or b"{}"):
                    return url
        except (OSError, ValueError):
            continue
    return None


def main():
    preferred = int(os.environ.get("KAAM_PORT") or 5000)
    running = findRunningApp(preferred)
    if running:  # double-clicked again: show the open app instead of starting a second copy
        print(f"Kaam25 is already running on {running} - opening it.")
        if "--no-browser" not in sys.argv:
            webbrowser.open(running)
        return
    port = pickPort(preferred)
    try:
        startBridge()  # the Chrome extension talks to this; also shows "connected" in the UI
    except ChromeBridgeError as error:
        print(f"! Chrome bridge not started: {error}")
    url = f"http://127.0.0.1:{port}"
    print(f"Kaam25 web is running on {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False, debug=False)


if __name__ == "__main__":
    main()
