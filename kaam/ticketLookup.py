"""Find a ticket ID for a WO on TechInsights, using your normal Chrome."""

import urllib.parse
from pathlib import Path

from .chromeBridge import ChromeBridgeError, openInChrome, registerFiles, runInChrome

from datetime import datetime

from .config import (closeTabsWhenDone, defaultLogsUploadedPreviousDay, defaultMarket,  # from .env
                    defaultRegion, driveShiftPmFrom, ticketsUrl)


def currentDriveShift(moment=None):
    """PM from DRIVE_SHIFT_PM_FROM (2:00 PM) onwards, AM before - by local time right now."""
    moment = moment or datetime.now()
    return "PM" if moment.time() >= driveShiftPmFrom else "AM"

closeFlag = "1" if closeTabsWhenDone else "0"  # extension closes its own tab when the job is fully done


def lookupTicketId(wo, expectedId=None, url=ticketsUrl, openUrl=openInChrome, startTimeout=25, timeout=120):
    """Open the tickets page in Chrome and return the ticket ID for `wo`. With expectedId (the
    one saved at Start), only that ticket counts: a WO with an older ticket too never returns
    the old one - it fails instead, naming the IDs it saw."""
    wo = wo.strip()
    if not wo:
        raise ChromeBridgeError("Enter a WO first.")

    def buildUrl(requestId):
        return f"{url}#" + urllib.parse.urlencode({
            "kaamWo": wo, "kaamId": requestId, "kaamUrl": url, "kaamClose": closeFlag,
            "kaamTicket": expectedId or ""})

    message = runInChrome(
        buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
        timeoutMessage="Timed out waiting for the tickets page. Are you logged in to TechInsights?",
    )
    if message.get("ticketId"):
        return message["ticketId"]
    raise ChromeBridgeError(message.get("error") or "No ticket found for this WO.")



def openCreateTicketForm(wo, submit=True, region=defaultRegion, market=defaultMarket,
                         shift=None, logsPreviousDay=defaultLogsUploadedPreviousDay, force=False,
                         url=ticketsUrl, openUrl=openInChrome, startTimeout=25, timeout=180):
    """Open the tickets page. If a ticket for this WO already exists (e.g. made by hand), use it -
    unless force: then create a new one anyway (the new ID is checked not to be an older one).
    Otherwise click Create Ticket and fill New WO, Region, Market, Drive Shift (AM/PM by the time
    right now unless given) and Logs uploaded from previous day; with submit, also click Create
    and find the new ticket's ID.
    Returns (summary, ticketId, wasExisting) - ticketId is None when submit is off."""
    shift = shift or currentDriveShift()
    wo = wo.strip()
    if not wo:
        raise ChromeBridgeError("Enter a WO first.")

    def buildUrl(requestId):
        return f"{url}#" + urllib.parse.urlencode({
            "kaamWo": wo, "kaamId": requestId, "kaamUrl": url, "kaamMode": "create",
            "kaamRegion": region, "kaamMarket": market, "kaamShift": shift,
            "kaamSubmit": "1" if submit else "0", "kaamClose": closeFlag, "kaamLogsPrev": logsPreviousDay,
            "kaamForce": "1" if force else "0",
        })

    message = runInChrome(
        buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
        timeoutMessage="Timed out on the Create Ticket form. Check the TechInsights tab.",
    )
    if message.get("ticketId") and message.get("existing"):
        return (f"This WO already has Ticket ID {message['ticketId']} in TechInsights, "
                "so no new ticket was created. Marked it as started - it's ready for End Ticket."), \
            message["ticketId"], True
    if message.get("ticketId"):
        olderIds = message.get("olderIds") or []
        check = (f"Checked: it's not one of the older tickets for this WO ({', '.join(olderIds)})."
                 if olderIds else "Checked: it's the only ticket listed for this WO.")
        return f"Ticket created. Ticket ID {message['ticketId']}. {check}", message["ticketId"], False
    if message.get("ok"):
        return message.get("summary") or "Create Ticket form filled.", None, False
    error = message.get("error") or "Couldn't fill the Create Ticket form."
    if submit and error.startswith("No ticket found"):
        error = "Ticket was created, but its ID didn't show on the tickets page yet. Use End Ticket's Find later."
    raise ChromeBridgeError(error)


def closeTicketSteps(wo, ticketId=None, logfile=None, url=ticketsUrl, openUrl=openInChrome,
                     startTimeout=25, timeout=8 * 60):
    """Close a ticket in TechInsights: find it (by Ticket ID when known, else WO) and do its
    current task if it's one we know - Step 1 "Start Driving", Step 2 "Check Out" (Route Completion
    Status -> Completed) - each: Status -> Completed, Save, OK, then refresh and do the next.
    Step 3 "Upload Collection" (its Logfile Submittal section): EQ3/EQ6 Upload IDs, the GridSummary CSV and the grid counts,
    from logfile = {"eq3", "eq6", "total", "tested", "skipped", "csvPath"}; Status -> Completed,
    Save, OK.
    It starts at whatever task the ticket shows, so steps done by hand are skipped.
    Returns (summary, stepsDone, alreadyDone, error): error is None when it finished; stepsDone
    lists the steps completed in this run and alreadyDone the ones found done by hand before it,
    either way, so they can be saved even if a later one failed."""
    wo = wo.strip()
    if not wo:
        raise ChromeBridgeError("Enter a WO first.")

    logfile = logfile or {}
    csvPath = logfile.get("csvPath")

    def text(value):
        return "" if value is None else str(value).strip()

    def buildUrl(requestId):
        if csvPath:
            registerFiles(requestId, [Path(csvPath)])
        return f"{url}#" + urllib.parse.urlencode({
            "kaamWo": wo, "kaamId": requestId, "kaamUrl": url, "kaamMode": "close",
            "kaamTicket": ticketId or "", "kaamClose": closeFlag,
            "kaamEq3": text(logfile.get("eq3")), "kaamEq6": text(logfile.get("eq6")),
            "kaamGridsTotal": text(logfile.get("total")), "kaamGridsTested": text(logfile.get("tested")),
            "kaamGridsSkipped": text(logfile.get("skipped")), "kaamCsv": Path(csvPath).name if csvPath else "",
        })

    message = runInChrome(
        buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
        timeoutMessage="Timed out closing the ticket. Check the TechInsights tab.",
    )
    stepsDone = [int(step) for step in message.get("stepsDone") or []]
    alreadyDone = [int(step) for step in message.get("alreadyDone") or [] if int(step) not in stepsDone]
    if message.get("ok"):
        return message.get("summary") or "Done.", stepsDone, alreadyDone, None
    return None, stepsDone, alreadyDone, message.get("error") or "Couldn't close the ticket."


def closeStepStartDriving(wo, ticketId=None, url=ticketsUrl, openUrl=openInChrome, startTimeout=25, timeout=180):
    """Older single-step version (Step 1 only), kept for reference; the app uses closeTicketSteps."""
    wo = wo.strip()
    if not wo:
        raise ChromeBridgeError("Enter a WO first.")

    def buildUrl(requestId):
        return f"{url}#" + urllib.parse.urlencode({
            "kaamWo": wo, "kaamId": requestId, "kaamUrl": url, "kaamMode": "close",
            "kaamTicket": ticketId or "", "kaamClose": closeFlag,
        })

    message = runInChrome(
        buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
        timeoutMessage="Timed out closing the ticket. Check the TechInsights tab.",
    )
    if message.get("ok"):
        return message.get("summary") or "Step 1 done."
    raise ChromeBridgeError(message.get("error") or "Couldn't complete the Start Driving task.")


if __name__ == "__main__":
    import sys
    print(lookupTicketId(sys.argv[1]))
