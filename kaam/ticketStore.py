"""Local record of every ticket, saved in tickets.json (path from .env).

One record per WO. Start Ticket and End Ticket each add what they did, plus a short
history line, so you can look up a ticket's IDs, EQ Job IDs, file names or report later.
"""

import copy
import json
import re
import threading
from datetime import datetime

from .config import ticketStoreFile  # from .env

storeLock = threading.Lock()
maxHistory = 50
# The file is only parsed again when it changed on disk (time + size).
fileCache = {"stamp": None, "tickets": {}}


class TicketStoreError(Exception):
    pass


def now():
    return datetime.now().isoformat(timespec="seconds")


def woKey(wo):
    return re.sub(r"\s+", "", wo or "").upper()


def fileStamp():
    try:
        stat = ticketStoreFile.stat()
    except FileNotFoundError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def readFile():
    """All records as {woKey: record}. Returns a copy, so callers can change it freely."""
    stamp = fileStamp()
    if stamp is None:
        return {}
    if stamp != fileCache["stamp"]:
        try:
            data = json.loads(ticketStoreFile.read_text(encoding="utf-8"))
        except ValueError:
            # Keep the broken file for reference and start a fresh one instead of crashing.
            broken = ticketStoreFile.with_name(f"{ticketStoreFile.stem}.broken-{datetime.now():%Y%m%d%H%M%S}.json")
            ticketStoreFile.replace(broken)
            fileCache.update(stamp=None, tickets={})
            return {}
        tickets = data.get("tickets") if isinstance(data, dict) else None
        fileCache.update(stamp=stamp, tickets=tickets if isinstance(tickets, dict) else {})
    return copy.deepcopy(fileCache["tickets"])


def writeFile(tickets):
    ticketStoreFile.parent.mkdir(parents=True, exist_ok=True)
    temporary = ticketStoreFile.with_suffix(".tmp")
    temporary.write_text(json.dumps({"tickets": tickets}, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(ticketStoreFile)  # all-or-nothing, so a crash can't leave half a file
    fileCache.update(stamp=fileStamp(), tickets=copy.deepcopy(tickets))


def saveRecord(wo, event=None, **fields):
    """Add or update fields on the WO's record (None values are skipped). Returns the record."""
    key = woKey(wo)
    if not key:
        raise TicketStoreError("Can't save a record without a WO.")
    with storeLock:
        tickets = readFile()
        record = tickets.get(key) or {"wo": wo.strip(), "createdAt": now(), "history": []}
        record.update({name: value for name, value in fields.items() if value is not None})
        record["updatedAt"] = now()
        if event:
            record.setdefault("history", []).append({"at": now(), "event": event})
            record["history"] = record["history"][-maxHistory:]
        tickets[key] = record
        writeFile(tickets)
        return dict(record)


# What belongs to one ticket (not to the WO). A new ticket for the same WO starts these fresh;
# the old values are kept under "previousTickets".
ticketFields = (
    "ticketId", "startTicketId", "endTicketId", "ticketVerified", "startedAt", "submitted", "driveShift",
    "startType", "localGridNumber",
    "folderName", "endedAt", "eq3", "eq6", "status", "totalGrids", "attempted", "skipped", "remarks",
    "gridSummaryPath", "whatsappSentAt", "closeStep1At", "closeStep2At", "closeStep3At", "closedAt",
)


def startNewTicket(wo, event=None, **fields):
    """A new ticket for a WO that already had one (e.g. not finished yesterday). The WO's own
    details (grid key, location, cluster...) stay; the old ticket's progress moves to
    "previousTickets" and is cleared, so End/Close work on the new ticket only (e.g. EQ uploads
    aren't skipped because of the old ticket's Job IDs). Then `fields` are saved. Returns the record."""
    key = woKey(wo)
    if not key:
        raise TicketStoreError("Can't save a record without a WO.")
    with storeLock:
        tickets = readFile()
        record = tickets.get(key) or {"wo": wo.strip(), "createdAt": now(), "history": []}
        old = {name: record.pop(name) for name in ticketFields if name in record}
        if old.get("ticketId"):
            old["replacedAt"] = now()
            record.setdefault("previousTickets", []).append(old)
        record.update({name: value for name, value in fields.items() if value is not None})
        record["updatedAt"] = now()
        if event:
            record.setdefault("history", []).append({"at": now(), "event": event})
            record["history"] = record["history"][-maxHistory:]
        tickets[key] = record
        writeFile(tickets)
        return dict(record)


# ---------- cloud / local start ----------
# One "cloud" start a day creates the real TechInsights ticket. Every other WO that day is a
# "local" start: no ticket, its Ticket ID is "LM_2_10292026", "LM_3_10292026"... (number, then the
# start date MMDDYYYY, so every ID is unique and traceable). 1 is the day's cloud ticket, so local
# numbers start at 2 (counting restarts daily).
localTicketPrefix = "LM"
firstLocalNumber = 2
localIdPattern = re.compile(r"^LM(_\d+_\d{8}| Grid No \d+)$")  # also the older "LM Grid No X"


def localTicketId(number, day=None):
    return f"{localTicketPrefix}_{number}_{(day or datetime.now()).strftime('%m%d%Y')}"


def isLocalStart(record):
    return (record or {}).get("startType") == "local"


def startedToday(record):
    return ((record or {}).get("startedAt") or "").startswith(datetime.now().date().isoformat())


def cloudStartToday():
    """Today's cloud-started record (the one with the real ticket), or None."""
    with storeLock:
        records = list(readFile().values())
    cloud = [record for record in records if startedToday(record) and record.get("startType") == "cloud"]
    return min(cloud, key=lambda record: record["startedAt"]) if cloud else None


def nextLocalNumber(tickets=None):
    """The N for the next "LM_N_MMDDYYYY" today (2 for the first local start)."""
    if tickets is None:
        with storeLock:
            tickets = readFile()
    numbers = [record.get("localGridNumber") or 0 for record in tickets.values()
               if isLocalStart(record) and startedToday(record)]
    return max(numbers + [firstLocalNumber - 1]) + 1


def startLocal(wo, event=None, **fields):
    """Mark the WO as started without a TechInsights ticket; it gets the next "LM_N_MMDDYYYY".
    Already local-started today: nothing changes. Started before (another day, or a cloud
    start): that ticket moves to "previousTickets", like startNewTicket.
    Returns (record, isNew)."""
    key = woKey(wo)
    if not key:
        raise TicketStoreError("Can't save a record without a WO.")
    with storeLock:
        tickets = readFile()
        record = tickets.get(key) or {"wo": wo.strip(), "createdAt": now(), "history": []}
        if isLocalStart(record) and startedToday(record):
            return dict(record), False
        number = nextLocalNumber(tickets)
        old = {name: record.pop(name) for name in ticketFields if name in record}
        if old.get("ticketId"):
            old["replacedAt"] = now()
            record.setdefault("previousTickets", []).append(old)
        ticketId = localTicketId(number)
        record.update({name: value for name, value in fields.items() if value is not None})
        record.update(startType="local", localGridNumber=number, ticketId=ticketId, startTicketId=ticketId,
                      startedAt=now(), submitted=False, updatedAt=now())
        record.setdefault("history", []).append({"at": now(), "event": event or f"Start: local start as {ticketId}"})
        record["history"] = record["history"][-maxHistory:]
        tickets[key] = record
        writeFile(tickets)
        return dict(record), True


def deleteRecord(wo):
    """Remove a WO's record. A copy goes to tickets.deleted.json next to tickets.json, so a
    mistake can be recovered by hand. Returns True if there was a record to delete."""
    key = woKey(wo)
    with storeLock:
        tickets = readFile()
        record = tickets.pop(key, None)
        if record is None:
            return False
        trash = ticketStoreFile.with_name(f"{ticketStoreFile.stem}.deleted.json")
        try:
            deleted = json.loads(trash.read_text(encoding="utf-8")) if trash.exists() else []
        except ValueError:
            deleted = []
        if not isinstance(deleted, list):
            deleted = []
        deleted.append({"deletedAt": now(), "record": record})
        trash.write_text(json.dumps(deleted, indent=2, ensure_ascii=False), encoding="utf-8")
        writeFile(tickets)
    return True


def getRecord(wo):
    with storeLock:
        return readFile().get(woKey(wo))


def importWorkOrders(rows, sourceName):
    """Save sheet rows (wo, gridKey, lat, long, cluster, ...) in one write. Existing records
    keep their progress; only the sheet's fields are added or refreshed.
    Returns (added, updated, alreadyStarted) counts."""
    added = updated = alreadyStarted = 0
    with storeLock:
        tickets = readFile()
        stamp = now()
        for order, row in enumerate(rows):
            key = woKey(row.get("wo"))
            if not key:
                continue
            record = tickets.get(key)
            if record is None:
                record = {"wo": row["wo"].strip(), "createdAt": stamp, "history": []}
                added += 1
            else:
                updated += 1
                if record.get("startedAt"):
                    alreadyStarted += 1
            record.update({field: value for field, value in row.items() if field != "wo" and value})
            record.update(importedAt=stamp, importSource=sourceName, importOrder=order, updatedAt=stamp)
            record.setdefault("history", []).append({"at": stamp, "event": f"Imported from {sourceName}"})
            record["history"] = record["history"][-maxHistory:]
            tickets[key] = record
        writeFile(tickets)
    return added, updated, alreadyStarted


def moveToToday(wos):
    """Bring not-started WOs (e.g. left over from an earlier day's plan) to today: they show under
    today in Records and at the top of Start's "To start" list, ready to start as cloud or local.
    Saves "movedToDayAt"; nothing else changes. Started WOs are skipped. One write.
    Returns how many were moved."""
    moved = 0
    with storeLock:
        tickets = readFile()
        stamp = now()
        for wo in wos:
            record = tickets.get(woKey(wo))
            if record is None or record.get("startedAt"):
                continue
            record["movedToDayAt"] = stamp
            record["updatedAt"] = stamp
            record.setdefault("history", []).append({"at": stamp, "event": "Moved to today in Records"})
            record["history"] = record["history"][-maxHistory:]
            moved += 1
        if moved:
            writeFile(tickets)
    return moved


def notStartedRecords():
    """Imported but not started yet, in sheet order (latest import first) - Start Ticket's list.
    A WO moved to today counts as imported at that moment, so it sits with today's plan."""
    with storeLock:
        records = list(readFile().values())
    waiting = [record for record in records if record.get("importedAt") and not record.get("startedAt")]

    def listedAt(record):
        return max(record["importedAt"], record.get("movedToDayAt") or "")

    return sorted(waiting, key=lambda record: (-datetime.fromisoformat(listedAt(record)).timestamp(),
                                               record.get("importOrder", 0)))


def recordGridKeys(record):
    """All grid keys of a record (a multi-grid WO has "gridKeys"), squashed for comparing."""
    keys = [record.get("gridKey")] + list(record.get("gridKeys") or [])
    return {re.sub(r"\s+", "", str(key)).lower() for key in keys if key}


def findByGridKey(text):
    """The record whose grid key matches (spaces / case ignored), or None. The same grid can be
    on several WOs (driven again another day): prefer one not started yet, newest import first."""
    key = re.sub(r"\s+", "", text or "").lower()
    if not key:
        return None
    with storeLock:
        records = list(readFile().values())
    matches = [record for record in records if key in recordGridKeys(record)]
    matches.sort(key=lambda record: record.get("importedAt") or record.get("updatedAt") or "", reverse=True)
    matches.sort(key=lambda record: bool(record.get("startedAt")))  # stable: not-started first
    return matches[0] if matches else None


def findRecord(text):
    """Look a record up by its WO, grid key or Ticket ID (exact; spaces and case ignored).
    Returns (record, matchedBy) with matchedBy "wo" / "gridKey" / "ticketId", or (None, None).
    Several matches: one not started yet wins, then the most recent."""
    key = re.sub(r"\s+", "", text or "").lower()
    if not key:
        return None, None
    with storeLock:
        tickets = readFile()
    if woKey(text) in tickets:
        return tickets[woKey(text)], "wo"
    squash = lambda value: re.sub(r"\s+", "", str(value or "")).lower()
    for field in ("gridKey", "ticketId"):
        matches = [record for record in tickets.values()
                   if squash(record.get(field)) == key
                   or (field == "gridKey" and key in recordGridKeys(record))
                   or (field == "ticketId" and (
                       squash(record.get("startTicketId")) == key
                       or any(squash(old.get("ticketId")) == key for old in record.get("previousTickets") or [])))]
        if matches:
            matches.sort(key=lambda record: record.get("updatedAt") or "", reverse=True)
            matches.sort(key=lambda record: bool(record.get("startedAt")))  # stable: not-started first
            return matches[0], field
    return None, None


def openTicketsToday():
    """Started today and not completed yet, newest first - what End Ticket offers to pick."""
    today = datetime.now().date().isoformat()
    with storeLock:
        records = list(readFile().values())
    openToday = [record for record in records
                 if (record.get("startedAt") or "").startswith(today) and not record.get("endedAt")]
    return sorted(openToday, key=lambda record: record.get("startedAt", ""), reverse=True)


def searchRecords(query=""):
    """Newest first. Matches WO, Ticket ID, EQ Job IDs, file names - any saved text."""
    with storeLock:
        records = list(readFile().values())
    records.sort(key=lambda record: record.get("updatedAt", ""), reverse=True)
    needle = re.sub(r"\s+", "", query or "").lower()
    if not needle:
        return records

    def matches(record):
        text = " ".join(str(value) for name, value in record.items() if name != "history")
        return needle in re.sub(r"\s+", "", text).lower()

    return [record for record in records if matches(record)]
