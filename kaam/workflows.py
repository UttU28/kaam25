"""The Start / End / Close / WhatsApp workflows, without any UI.

Every function here does the work behind the web pages (same checks, same saves to
tickets.json, same history lines). Long ones take `progress(text)` and `post(kind, value)`
callbacks so a caller (the web app's job runner) can show live progress.
"""

import re
from datetime import datetime
from pathlib import Path

from .actixLogin import prepareAllUploads
from .apeksha import shareLocation
from .chromeBridge import ChromeBridgeError, requestTabsClosed
from .config import (defaultAttempted, defaultMarket, defaultRegion, defaultSkipped, defaultStatus,
                     defaultTotalGrids, employeeId, equipments, gridSummaryFile, ticketStoreFile)
from .gridSummary import buildFolderName, copyGridSummary, findRenamedCopy
from .sheetImport import readSheet
from .ticketLookup import closeTicketSteps, currentDriveShift, lookupTicketId, openCreateTicketForm
from .ticketStore import (findRecord, getRecord, importWorkOrders, isLocalStart, localIdPattern, now,
                          saveRecord, searchRecords, startLocal, startNewTicket)
from .whatsappShare import shareOnWhatsApp

statusOptions = ["PASSED", "SKIPPED", "FAILED"]

# (record field set when done, name, what it does)
closeSteps = [
    ("closeStep1At", "Step 1", "Start Driving task → Completed (Save, then OK)"),
    ("closeStep2At", "Step 2", "Check Out: Route Completion Status → Completed, task → Completed"),
    ("closeStep3At", "Step 3", "Upload Collection: EQ3, EQ6, GridSummary CSV, grid counts → Completed, Save, OK"),
]

# "Cloud WO - X", "WO: X", "WO:X" -> "X"
woPrefixPattern = re.compile(r"^\s*(?:cloud\s*wo\s*-\s*|wo\s*:\s*)", re.IGNORECASE)
ticketLinePattern = re.compile(r"^(Ticket ID:)[ \t]*(.*)$", re.MULTILINE)


class WorkflowError(Exception):
    pass


# ---------- small helpers ----------
def cleanWorkOrder(text):
    return woPrefixPattern.sub("", text or "").strip()


def resolveWorkOrder(text):
    """What's in a WO box -> (wo, record, matchedBy). Accepts a WO, grid key or Ticket ID;
    anything unknown comes back as typed (cleaned), with record None."""
    cleaned = cleanWorkOrder(text)
    try:
        record, matchedBy = findRecord(cleaned)
    except Exception:
        record, matchedBy = None, None
    return (record["wo"] if record else cleaned), record, matchedBy


def safeSave(wo, event=None, **fields):
    """Save to tickets.json; a disk problem is reported, never fatal. Returns an error or None."""
    try:
        saveRecord(wo, event=event, **fields)
        return None
    except Exception as error:
        return f"Couldn't save to {ticketStoreFile.name}: {error}"


def latLong(record):
    """(lat, long) as saved text, in the right order. Some sheets have Lat and Long swapped;
    latitude is the positive one (north), longitude the negative one (west)."""
    lat, lon = str((record or {}).get("lat") or "").strip(), str((record or {}).get("long") or "").strip()
    try:
        latValue, lonValue = float(lat), float(lon)
    except ValueError:
        return lat, lon
    if abs(latValue) > 90 or (latValue < 0 < lonValue):
        return lon, lat
    return lat, lon


def formatLocationPreview(wo, record=None):
    record = record or {}
    lat, lon = latLong(record)
    location = f"{lat}, {lon}" if lat or lon else ""
    return f"WO: {wo or record.get('wo', '')}\nGrid Key: {record.get('gridKey') or ''}\nLocation: {location}"


def formatReport(fields):
    """The report text. fields: wo, ticket, eq3, eq6, total, attempted, skipped, status,
    remarks. REMARKS is left out when empty."""
    get = lambda key: str(fields.get(key) or "").strip()
    report = (
        f"WO: {get('wo')}\n"
        f"Ticket ID: {get('ticket')}\n"
        f"\n"
        f"EQ3: {get('eq3')}\n"
        f"EQ6: {get('eq6')}\n"
        f"\n"
        f"TOTAL GRIDS: {get('total')}\n"
        f"GRIDS ATTEMPTED: {get('attempted')}\n"
        f"GRIDS SKIPPED: {get('skipped')}\n"
        f"STATUS : {get('status')}"
    )
    if get("remarks"):
        report += f"\n\nREMARKS: {get('remarks')}"
    return report


def reportFieldsFromRecord(record):
    record = record or {}
    value = lambda key, default: str(record[key]) if record.get(key) not in (None, "") else default
    return {
        "wo": record.get("wo", ""), "ticket": record.get("ticketId") or "",
        "eq3": record.get("eq3") or "", "eq6": record.get("eq6") or "",
        "total": value("totalGrids", defaultTotalGrids), "attempted": value("attempted", defaultAttempted),
        "skipped": value("skipped", defaultSkipped),
        "status": record.get("status") if record.get("status") in statusOptions else defaultStatus,
        "remarks": record.get("remarks") or "",
    }


def reportFromRecord(record):
    return record.get("report") or formatReport(reportFieldsFromRecord(record))


def whatsappCaption(wo, report):
    """The report as shared on WhatsApp: a local start has no real ticket, so its "Ticket ID:"
    line goes out blank (the LM_N_date ID stays in Records and the copied report)."""
    try:
        record, _ = findRecord(wo)
    except Exception:
        record = None
    match = ticketLinePattern.search(report or "")
    if match and (isLocalStart(record) or localIdPattern.match(match.group(2).strip())):
        report = ticketLinePattern.sub(r"\1", report, count=1)
    return report


def niceTime(isoText):
    try:
        moment = datetime.fromisoformat(isoText)
    except (TypeError, ValueError):
        return isoText or ""
    return f"{moment.strftime('%b')} {moment.day}, {moment.strftime('%I:%M %p').lstrip('0')}"


# ---------- Start ----------
def startLocalWo(wo):
    """Local start: no TechInsights, the next LM_N_MMDDYYYY. Returns {ticketId, isNew, summary}."""
    wo = cleanWorkOrder(wo)
    if not wo:
        raise WorkflowError("Enter a WO first.")
    record = getRecord(wo) or {}
    warning = ""
    if record.get("endedAt") and not (isLocalStart(record) and (record.get("startedAt") or "")[:10]
                                      == datetime.now().date().isoformat()):
        warning = f" Note: Records shows this WO was already completed {niceTime(record['endedAt'])}."
    saved, isNew = startLocal(wo, region=defaultRegion, market=defaultMarket, driveShift=currentDriveShift(),
                              folderName=buildFolderName(wo))
    ticketId = saved["ticketId"]
    summary = (f"Started locally as {ticketId}. No ticket created. End Ticket works as usual."
               if isNew else f"Already started locally today as {ticketId} - nothing changed.")
    return {"wo": saved["wo"], "ticketId": ticketId, "isNew": isNew, "summary": summary + warning}


def startCloud(wo, submit=True, shift=None, force=False, progress=lambda text: None):
    """Cloud start: create the day's real ticket in TechInsights (through Chrome).
    Returns {"summary", "ticketId", "ask": bool}. ask=True: the WO already has a ticket in
    TechInsights - the caller asks: use it (useExistingTicket) or create a new one (force=True)."""
    wo = cleanWorkOrder(wo)
    if not wo:
        raise WorkflowError("Enter a WO first.")
    shift = shift or currentDriveShift()
    progress("Opening TechInsights in your Chrome…")
    try:
        summary, ticketId, wasExisting = openCreateTicketForm(wo, submit=submit, shift=shift, force=force)
    except Exception as error:
        safeSave(wo, event=f"Start: failed - {error}")
        raise

    record = getRecord(wo) or {}
    if wasExisting:
        return {"wo": wo, "summary": summary, "ticketId": ticketId, "ask": True}

    if force:
        if not ticketId:
            return {"wo": wo, "summary": summary + " (Records not changed - Create wasn't clicked.)",
                    "ticketId": None, "ask": False}
        oldId = record.get("ticketId")
        try:
            startNewTicket(
                wo, event=f"Start: new ticket {ticketId} created (replaces {oldId or 'the existing one'})",
                startedAt=now(), submitted=True, ticketId=ticketId, startTicketId=ticketId, startType="cloud",
                region=defaultRegion, market=defaultMarket, driveShift=shift, folderName=buildFolderName(wo))
            summary += (f" Records now uses {ticketId}; {oldId} is kept under previous tickets."
                        if oldId else f" Records now uses {ticketId}.")
        except Exception as error:
            summary += f" Couldn't save to Records: {error}"
        return {"wo": wo, "summary": summary, "ticketId": ticketId, "ask": False}

    olderId = record.get("startTicketId")
    if ticketId and olderId and olderId != ticketId:
        summary += f" (Records had {olderId} for this WO before; now {ticketId}.)"
    saveError = safeSave(
        wo, event=f"Start: {'ticket created ' + ticketId if ticketId else 'form filled, Create not clicked'}",
        startedAt=now(), submitted=bool(ticketId), region=defaultRegion, market=defaultMarket,
        driveShift=shift, folderName=buildFolderName(wo), startType="cloud",
        **({"ticketId": ticketId, "startTicketId": ticketId} if ticketId else {}),
    )
    if saveError:
        summary += f" {saveError}"
    return {"wo": wo, "summary": summary, "ticketId": ticketId, "ask": False}


def useExistingTicket(wo, ticketId, summary=""):
    """The ticket already existed in TechInsights: record it as started today."""
    record = getRecord(wo) or {}
    if record.get("endedAt"):
        summary += f" Note: Records shows this WO was already completed {niceTime(record['endedAt'])}."
    saveError = safeSave(
        wo, event=f"Start: ticket {ticketId} already existed in TechInsights - marked as started",
        startedAt=now(), submitted=True, ticketId=ticketId, startTicketId=ticketId, startType="cloud",
        folderName=buildFolderName(wo))
    return (summary + (f" {saveError}" if saveError else "")).strip()


def chooseNewTicket(wo, ticketId):
    safeSave(wo, event=f"Start: {ticketId} exists - you chose to create a new ticket")


# ---------- import ----------
def importSheetFile(path, sourceName=None):
    """Read an Excel / CSV plan (columns found by their values; only your team's rows) and save
    it. Returns {count, added, updated, alreadyStarted, notes, source}."""
    sourceName = sourceName or Path(path).name
    rows, notes = readSheet(path, team=employeeId, knownWos=[r.get("wo", "") for r in searchRecords()])
    added, updated, alreadyStarted = importWorkOrders(rows, sourceName)
    return {"count": len(rows), "added": added, "updated": updated, "alreadyStarted": alreadyStarted,
            "notes": notes, "source": sourceName}


# ---------- End ----------
def endTicket(wo, post=lambda kind, value: None):
    """Find + verify the ticket ID (cloud) or skip that (local), copy GridSummary, upload EQ3/EQ6.
    post(kind, value): "ticket", "progress", "gridFile", "jobIds". Returns {"ok", "summary"}."""
    wo = cleanWorkOrder(wo)
    if not wo:
        raise WorkflowError("Enter a WO first.")
    startRecord = getRecord(wo) or {}
    startId = startRecord.get("startTicketId")
    if isLocalStart(startRecord):
        ticketId = startRecord.get("ticketId") or startId
        check = f"Local start {ticketId} - no ticket lookup"
        verified = False
    else:
        post("progress", "Searching TechInsights in your Chrome…")
        try:
            ticketId = lookupTicketId(wo, expectedId=startId)
        except Exception:
            if startId:
                safeSave(wo, event=f"End: Ticket {startId} not found in TechInsights - stopped")
            raise
        if startId and startId != ticketId:
            safeSave(wo, event=f"End: ticket ID mismatch (Start {startId}, TechInsights {ticketId}) - stopped")
            raise WorkflowError(f"Ticket ID check failed: Start Ticket saved {startId}, but TechInsights shows "
                                f"{ticketId} for this WO. Stopped before uploading - check which one is right.")
        check = (f"Ticket ID {ticketId} matches Start Ticket ✓" if startId
                 else f"Found Ticket ID {ticketId} (no Start Ticket record to check against)")
        verified = bool(startId)
    post("ticket", ticketId)
    post("progress", check)

    summaries, errors = [check], []
    saveError = safeSave(wo, event=f"End: {check}", ticketId=ticketId, endTicketId=ticketId,
                         ticketVerified=verified, folderName=buildFolderName(wo))
    if saveError:
        errors.append(saveError)

    post("progress", f"{check}. Copying {gridSummaryFile}…")
    try:
        copied, wasAlreadyThere = copyGridSummary(wo)
        post("gridFile", str(copied))
        summaries.append(f"GridSummary {'copy already there' if wasAlreadyThere else 'copied'}: {copied.name}")
        safeSave(wo, gridSummaryPath=str(copied))
    except Exception as error:
        errors.append(f"GridSummary: {error}")

    record = getRecord(wo) or {}
    alreadyDone = {equipment: record[equipment.lower()] for equipment in equipments if record.get(equipment.lower())}

    def onResult(equipment, jobId):
        safeSave(wo, event=f"End: {equipment} uploaded, Job ID {jobId}", **{equipment.lower(): jobId})
        post("jobIds", {equipment: jobId})

    def onTab(token):
        if token:
            tokens = (getRecord(wo) or {}).get("eqTabTokens") or []
            safeSave(wo, eqTabTokens=tokens + [token])

    try:
        uploadSummaries, uploadErrors, jobIds = prepareAllUploads(
            wo, onProgress=lambda text: post("progress", f"{check}. {text}"),
            onResult=onResult, onTab=onTab, alreadyDone=alreadyDone)
    except Exception as error:
        raise WorkflowError("\n".join(summaries + errors + [f"ActixOne: {error}"]))
    post("jobIds", jobIds)
    allUploaded = not uploadErrors and all(jobIds.get(equipment) for equipment in equipments)
    safeSave(wo, event=f"End: uploads {'done' if allUploaded else 'with problems - rerun to finish'}",
             uploadNotes=uploadSummaries + uploadErrors, **({"endedAt": now()} if allUploaded else {}))
    report = "\n".join(summaries + uploadSummaries + errors + uploadErrors)
    return {"ok": not (errors or uploadErrors), "summary": report, "ticketId": ticketId, "jobIds": jobIds}


def endAll(wos, post=lambda kind, value: None, send=None):
    """End Tickets: End each WO in turn (ticket check, GridSummary, EQ uploads - as End Ticket's
    button), then share on WhatsApp one by one - only the WOs whose End finished completely and that
    weren't shared yet (each share first looks in the chat, so nothing goes out twice).
    Returns {"ok", "summary", "ended", "shared", "failed"}."""
    from .chromeBridge import StoppedError
    progress = lambda text: post("progress", text)
    ended, failed, shared, notShared = [], [], [], []
    for number, wo in enumerate(wos, 1):
        tag = f"[{number}/{len(wos)}] {wo}"
        progress(f"{tag}: ending…")
        post("current", wo)
        try:
            result = endTicket(wo, post=lambda kind, value, tag=tag: post(kind, f"{tag}: {value}") if kind == "progress" else None)
        except StoppedError:
            raise
        except Exception as error:
            failed.append(f"{wo}: {error}")
            progress(f"{tag}: problem - {error}")
            continue
        record = getRecord(wo) or {}
        try:  # the report with the Ticket ID and EQ Job IDs, as End Ticket saves it after a run
            saveReportFields(reportFieldsFromRecord(record), event=None)
        except Exception:
            pass
        if result.get("ok") and record.get("endedAt"):
            ended.append(wo)
            progress(f"{tag}: uploads done")
        else:
            failed.append(f"{wo}: {result.get('summary', 'finished with problems').splitlines()[-1]}")
            progress(f"{tag}: finished with problems - not shared")
        post("ended", list(ended))

    toShare = []
    for wo in ended:
        record = getRecord(wo) or {}
        missing = [name for name, value in (("Ticket ID", record.get("ticketId")), ("GridSummary file", record.get("gridSummaryPath")),
                                            *((equipment, record.get(equipment.lower())) for equipment in equipments)) if not value]
        if record.get("whatsappSentAt"):
            notShared.append(f"{wo}: shared before")
        elif missing:
            notShared.append(f"{wo}: missing {', '.join(missing)}")
        else:
            toShare.append(wo)
    for number, wo in enumerate(toShare, 1):
        tag = f"WhatsApp [{number}/{len(toShare)}] {wo}"
        progress(f"{tag}: sharing…")
        post("current", wo)
        try:
            outcome = shareTicket(wo, reportFromRecord(getRecord(wo) or {}), send=send, checkFirst=True, woDone=False)
            shared.append(wo)
            progress(f"{tag}: {outcome['summary']}")
        except StoppedError:
            raise
        except Exception as error:
            notShared.append(f"{wo}: {error}")
            progress(f"{tag}: problem - {error}")
        post("shared", list(shared))

    doneLine = ""
    if shared:  # every summary is out: one "- Done" message with all of them in the WO group
        doneLine = sendWoDone(shared, send=send, progress=progress)
        if doneLine:
            progress(doneLine)
    lines = [f"Ended {len(ended)} of {len(wos)}" + (f", shared {len(shared)} on WhatsApp." if toShare else ".")]
    if doneLine:
        lines.append(doneLine)
    lines += [f"Not ended - {line}" for line in failed] + [f"Not shared - {line}" for line in notShared]
    return {"ok": not failed and len(shared) == len(toShare), "summary": "\n".join(lines),
            "ended": ended, "shared": shared, "failed": failed}


def saveReportFields(fields, event=None, **extra):
    """Keep the report and its fields in tickets.json. fields as for formatReport."""
    wo = cleanWorkOrder(fields.get("wo"))
    if not wo:
        raise WorkflowError("Enter the WO first.")
    fields = {**fields, "wo": wo}
    error = safeSave(wo, event=event, **extra, report=formatReport(fields), ticketId=fields.get("ticket") or None,
                     eq3=fields.get("eq3") or None, eq6=fields.get("eq6") or None,
                     totalGrids=str(fields.get("total") or ""), attempted=str(fields.get("attempted") or ""),
                     skipped=str(fields.get("skipped") or ""), status=fields.get("status") or None,
                     remarks=(fields.get("remarks") or "").strip(), folderName=buildFolderName(wo))
    if error:
        raise WorkflowError(error)
    return getRecord(wo)


def finishTicket(fields):
    """Done: save the report, mark completed, and let the EQ tabs close."""
    wo = cleanWorkOrder(fields.get("wo"))
    record = (getRecord(wo) or {}) if wo else {}
    saveReportFields(fields, event="End: done", **({} if record.get("endedAt") else {"endedAt": now()}))
    if record.get("eqTabTokens"):
        try:
            requestTabsClosed(record["eqTabTokens"])
            safeSave(wo, eqTabTokens=[])
        except Exception:
            pass  # tabs just stay open; never block Done
    return getRecord(wo)


def saveEqIds(wo, typed):
    """typed: {"EQ3": "AJO-...", "EQ6": ...} typed by hand - End Ticket won't upload those again."""
    wo = cleanWorkOrder(wo)
    typed = {equipment: (jobId or "").strip() for equipment, jobId in typed.items() if (jobId or "").strip()}
    if not wo:
        raise WorkflowError("Enter the WO first, then save its EQ Job IDs.")
    if not typed:
        raise WorkflowError("Type an EQ3 or EQ6 Job ID first.")
    error = safeSave(wo, event=f"End: {', '.join(typed)} Job ID saved by hand",
                     **{equipment.lower(): jobId for equipment, jobId in typed.items()})
    if error:
        raise WorkflowError(error)
    return (f"Saved {', '.join(f'{equipment} {jobId}' for equipment, jobId in typed.items())}. "
            "A rerun won't upload these again.")


def updateStatus(wo, total, attempted, skipped, status, remarks, source="Records"):
    """Status / grids / remarks only (End and Records save these as you change them); the report
    follows. EQ Job IDs are not touched - those are saved on their own."""
    record = getRecord(wo)
    if not record:
        raise WorkflowError("Not in Records yet - start the WO first.")
    if status not in statusOptions:
        raise WorkflowError("Pick a status first.")
    fields = {"totalGrids": str(total).strip(), "attempted": str(attempted), "skipped": str(skipped),
              "status": status, "remarks": (remarks or "").strip()}
    saved = {key: str(record.get(key) if record.get(key) is not None else "").strip() for key in fields}
    if fields == saved:
        return record  # nothing changed: no write, no history line
    report = formatReport({
        "wo": record.get("wo"), "ticket": record.get("ticketId"), "eq3": record.get("eq3"),
        "eq6": record.get("eq6"), "total": fields["totalGrids"], "attempted": fields["attempted"],
        "skipped": fields["skipped"], "status": status, "remarks": fields["remarks"]})
    changed = []  # the history line says what changed
    if fields["status"] != saved["status"]:
        changed.append(f"status {status}")
    if any(fields[key] != saved[key] for key in ("totalGrids", "attempted", "skipped")):
        changed.append(f"grids {fields['totalGrids']} / attempted {fields['attempted']} / skipped {fields['skipped']}")
    if fields["remarks"] != saved["remarks"]:
        changed.append(f"remarks: {fields['remarks']}" if fields["remarks"] else "remarks cleared")
    error = safeSave(record["wo"], event=f"{source}: {' · '.join(changed)}", report=report, **fields)
    if error:
        raise WorkflowError(error)
    return getRecord(wo)


# ---------- WhatsApp ----------
def doneMessage(wos):
    """What the WO group gets: "<WO> - Done", one line per WO."""
    return "\n".join(f"{wo} - Done" for wo in wos)


def sendWoDone(wos, send=None, progress=lambda text: None, onlyNew=True):
    """"<WO> - Done" (all of them in one message) to the WO group (WHATSAPP_GROUP_WO), for the WOs
    not done there yet (onlyNew=False: all of them, e.g. Sheets' whole list).
    Returns a summary line, or "" when there's no WO group / nothing to send."""
    from .config import whatsappSend, whatsappWoGroup
    from .whatsappShare import sendTextOnWhatsApp
    send = whatsappSend if send is None else send
    if onlyNew:
        wos = [wo for wo in wos if not (getRecord(wo) or {}).get("woDoneSentAt")]
    if not whatsappWoGroup or not wos:
        return ""
    progress(f"WhatsApp {whatsappWoGroup}: {', '.join(wos)} - Done…")
    try:
        summary, wasSent = sendTextOnWhatsApp(doneMessage(wos), whatsappWoGroup, send=send)
    except Exception as error:
        for wo in wos:
            safeSave(wo, event=f"WhatsApp {whatsappWoGroup}: \"- Done\" failed - {error}")
        return f"{whatsappWoGroup}: not sent - {error}"
    for wo in wos:
        safeSave(wo, event=f"WhatsApp: \"{wo} - Done\" {'sent' if wasSent else 'typed, not sent'} to {whatsappWoGroup}",
                 **({"woDoneSentAt": now()} if wasSent else {}))
    return summary


def shareTicket(wo, report, send=None, csvPath=None, progress=lambda text: None, checkFirst=False, woDone=True):
    """Share the renamed CSV + the report (Ticket ID blank for a local start) on WhatsApp, then (woDone)
    "<WO> - Done" in the WO group."""
    wo = cleanWorkOrder(wo)
    if not wo:
        raise WorkflowError("Enter a WO first.")
    from .config import whatsappGroup, whatsappSend
    send = whatsappSend if send is None else send
    csvPath = csvPath or (getRecord(wo) or {}).get("gridSummaryPath")
    progress("Sharing on WhatsApp… (waiting for WhatsApp to load fully)")
    try:
        summary, wasSent = shareOnWhatsApp(wo, whatsappCaption(wo, report), csvPath, send=send, checkFirst=checkFirst)
    except Exception as error:
        safeSave(wo, event=f"WhatsApp: failed - {error}")
        raise
    safeSave(wo, event=f"WhatsApp: {'sent' if wasSent else 'ready, not sent'} to {whatsappGroup}",
             **({"whatsappSentAt": now(), "whatsappGroup": whatsappGroup} if wasSent else {}))
    if wasSent and woDone:  # the summary is out: then "<WO> - Done" in the WO group
        done = sendWoDone([wo], send=send, progress=progress)
        if done:
            summary += f"\n{done}"
    return {"summary": summary, "sent": wasSent}


# ---------- Apeksha ----------
def sendLocation(wo):
    """Post the WO's Google Maps link to Apeksha (only when Apeksha is on in Settings)."""
    from .apeksha import mapsLink
    from .config import apekshaEnabled
    if not apekshaEnabled:
        raise WorkflowError("Apeksha is off (Settings → Web pages → Use Apeksha) - the QR icon shows a QR code instead.")
    record = getRecord(cleanWorkOrder(wo)) or {}
    lat, lon = latLong(record)
    if not (lat and lon):
        raise WorkflowError("No location saved for this WO, nothing to send.")
    reply = shareLocation(lat, lon)
    if reply.get("duplicate"):
        return f"{mapsLink(lat, lon)} is already the newest on Apeksha - nothing new saved."
    return f"Sent the Maps link to Apeksha ({lat}, {lon}) ✓"


# ---------- Close ----------
def closeState(record):
    """What Close Ticket shows for a record: can it be closed, and why not."""
    record = record or {}
    status = (record.get("status") or "").upper()
    isLocal = isLocalStart(record)
    canClose = bool(record) and status == "PASSED" and not isLocal
    if record.get("closedAt"):
        canClose = False  # done (by the close steps, or marked closed by hand)
    if not record:
        reason = "Not in Records - run Start / End Ticket for it first."
    elif record.get("closedAt"):
        reason = f"Already closed {niceTime(record['closedAt'])} - nothing to do."
    elif isLocal:
        reason = (f"This is a local start ({record.get('ticketId')}) - there's no TechInsights ticket to close. "
                  "Only the day's cloud ticket gets closed.")
    elif status != "PASSED":
        reason = f"Close TKT is only for PASSED tickets (this one is {status or 'not set'})."
    else:
        reason = "Ready. Close TKT runs the steps in TechInsights."
    steps = [{"field": field, "name": name, "what": what, "doneAt": record.get(field)}
             for field, name, what in closeSteps]
    return {"canClose": canClose, "reason": reason, "steps": steps, "closedAt": record.get("closedAt")}


def isReadyToClose(record):
    """PASSED cloud tickets not closed yet. Local starts never show (they have no ticket)."""
    return ((record.get("status") or "").upper() == "PASSED" and not isLocalStart(record)
            and not record.get("closedAt") and not all(record.get(field) for field, _, _ in closeSteps))


def closeTicket(wo, progress=lambda text: None):
    record = getRecord(cleanWorkOrder(wo)) or {}
    state = closeState(record)
    if not state["canClose"]:
        raise WorkflowError(state["reason"])
    wo = record["wo"]
    ticketId = record.get("ticketId")
    if not ticketId:
        raise ChromeBridgeError("No Ticket ID saved for this WO - run Find in End Ticket first.")
    stepNames = {int(name.split()[-1]): (field, what) for field, name, what in closeSteps}
    progress("Closing: opening TechInsights in your Chrome… (refreshes between steps)")
    try:
        csvPath = str(findRenamedCopy(wo, record.get("gridSummaryPath")))
    except Exception:
        csvPath = None  # Step 3 stops and says so, if the ticket gets that far
    logfile = {"eq3": record.get("eq3"), "eq6": record.get("eq6"), "total": record.get("totalGrids"),
               "tested": record.get("attempted"), "skipped": record.get("skipped"), "csvPath": csvPath}
    try:
        summary, stepsDone, alreadyDone, error = closeTicketSteps(wo, ticketId, logfile)
    except Exception as error:
        safeSave(wo, event=f"Close: stopped - {error}")
        raise
    saved = getRecord(wo) or {}
    for step in alreadyDone:
        field, what = stepNames.get(step, (f"closeStep{step}At", f"step {step}"))
        if not saved.get(field):
            safeSave(wo, event=f"Close: Step {step} was already done by hand - {what}", **{field: now()})
    for step in stepsDone:
        field, what = stepNames.get(step, (f"closeStep{step}At", f"step {step}"))
        safeSave(wo, event=f"Close: Step {step} done - {what}", **{field: now()})
    saved = getRecord(wo) or {}
    if all(saved.get(field) for field, _, _ in closeSteps) and not saved.get("closedAt"):
        safeSave(wo, event="Ticket closed - all close steps done", closedAt=now())
        summary = (summary or "Done.") + " 🔒 Ticket marked as Closed."
    if error:
        message = error + (f" (step {', '.join(map(str, stepsDone))} done and saved)" if stepsDone else "")
        safeSave(wo, event=f"Close: stopped - {message}")
        raise WorkflowError(message)
    return summary
