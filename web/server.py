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

from kaam import config, envSettings, workflows  # noqa: E402
from kaam.chromeBridge import ChromeBridgeError, bridgeStatus, openInChrome, startBridge, stopAll  # noqa: E402
from kaam.gridSummary import buildFolderName, showInExplorer  # noqa: E402
from kaam.sheetImport import SheetImportError  # noqa: E402
from kaam.temsParagon import actions as temsActions, runTems  # noqa: E402
from kaam.ticketLookup import currentDriveShift  # noqa: E402
from kaam.ticketStore import (TicketStoreError, cloudStartToday, deleteRecord, fileStamp, getRecord,  # noqa: E402
                              isLocalStart, localTicketId, moveToToday, nextLocalNumber, notStartedRecords,
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
        "bootedAt": bootedAt,  # changes after a restart (Settings waits for it)
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
    if "--no-browser" not in sys.argv and not afterRestart:
        threading.Timer(1.0, lambda: showApp(url)).start()
    app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False, debug=False)


if __name__ == "__main__":
    main()
