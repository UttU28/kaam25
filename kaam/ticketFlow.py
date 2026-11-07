"""One ticket's drive, step by step - everything tied to the ticket, never to an older one.

ticketCreationTime  the ticket was made (Start Ticket)
checkInTime         the car entered the grid for the first time (any direction; later visits don't count)
checkOutTime        the ticket was submitted in TEMS (the grid is done)
clicks              every button pressed for this WO (Start Stationary, Submit, Discard, phone buttons...)

Anything saved before this ticket was created belongs to an older ticket and is ignored, so a new
ticket never shows the last one's stationary test or results.
"""
import threading

from .ticketStore import getRecord, now, saveRecord

maxClicks = 200
lock = threading.Lock()
listeners = []  # callbacks(wo, kind, info) - e.g. the server runs Set up desk on "checkIn"


def ticketStart(record):
    """When this ticket was created ("" for a WO that was never started)."""
    record = record or {}
    return record.get("ticketCreationTime") or record.get("startedAt") or ""


def mine(record, field):
    """The field's time if it belongs to this ticket (saved at or after the ticket was created)."""
    value = (record or {}).get(field) or ""
    start = ticketStart(record)
    return value if value and (not start or value >= start) else ""


def logClick(wo, button, note=""):
    """A button pressed for this WO, saved on its ticket (and in its history)."""
    if not wo or not getRecord(wo):
        return
    try:
        with lock:
            record = getRecord(wo) or {}
            clicks = (record.get("clicks") or [])[-(maxClicks - 1):]
            clicks.append({"at": now(), "button": button, **({"note": note} if note else {})})
            saveRecord(wo, event=f"Pressed {button}" + (f" ({note})" if note else ""), clicks=clicks)
    except Exception:
        pass  # a log line never stops the button


def notify(wo, kind, info=None):
    for listener in list(listeners):
        try:
            listener(wo, kind, info or {})
        except Exception:
            pass


def checkIn(wo, source):
    """The car is in the grid. Only the first time counts. Returns True when this was the first."""
    with lock:
        record = getRecord(wo)
        if not record or not ticketStart(record) or mine(record, "checkInTime"):
            return False
        saveRecord(wo, event=f"Entered the grid ({source}) - check-in", checkInTime=now(), checkInSource=source)
    notify(wo, "checkIn", {"source": source})
    return True


def checkOut(wo, how="Submit"):
    """The grid is done: the ticket was submitted. The first submit counts."""
    record = getRecord(wo)
    if not record or mine(record, "checkOutTime"):
        return
    saveRecord(wo, event=f"Check-out ({how})", checkOutTime=now())


def runStarted(wo, how):
    """This ticket's TEMS run started (pressed here, or found running in TEMS)."""
    saveRecord(wo, event=f"TEMS run started ({how})", temsRunStartedAt=now(), temsRunStartHow=how,
               stationaryDoneAt=None, testCompleteAt=None)


def currentRun(record):
    """This ticket's TEMS run start time, "" when there's none (or only an older ticket's)."""
    return mine(record, "temsRunStartedAt")


def noteStage(wo, stage):
    """The run moved on: stationary done (mobility) / both done (complete)."""
    record = getRecord(wo) or {}
    run = currentRun(record)
    if not run:
        return
    fields = {}
    after = lambda field: (record.get(field) or "") >= run  # this run's, not an earlier run's
    if stage in ("mobility", "complete") and not after("stationaryDoneAt"):
        fields["stationaryDoneAt"] = now()
    if stage == "complete" and not after("testCompleteAt"):
        fields["testCompleteAt"] = now()
    if fields:
        saveRecord(wo, event="TEMS: stationary done" if stage == "mobility" else "TEMS: test complete", **fields)


# The ticket's steps in order. A step not done while a later one is = skipped (done by hand
# outside the app, or not at all).
steps = [
    ("created", "Ticket created"),
    ("checkIn", "Entered grid"),
    ("started", "Test started"),
    ("stationary", "Stationary done"),
    ("complete", "Test complete"),
    ("submitted", "Submitted"),
    ("ended", "Ended"),
    ("shared", "Shared"),
    ("closed", "Closed"),
]


def flow(record):
    """[{key, label, at, how, state}] - state: done / skipped / current / todo."""
    record = record or {}
    submit = record.get("temsSubmit") or {}
    run = currentRun(record)
    afterRun = lambda field: (mine(record, field) if run and (record.get(field) or "") >= run else "")
    ended = mine(record, "temsRunEndedAt")
    submitted = mine(record, "submittedAt") or mine(record, "checkOutTime") or \
        (ended if record.get("temsRunEnd") == "submit" else "")
    found = {
        "created": (ticketStart(record), ""),
        "checkIn": (mine(record, "checkInTime"), record.get("checkInSource") or ""),
        "started": (run, record.get("temsRunStartHow") or ""),
        "stationary": (afterRun("stationaryDoneAt"), ""),
        "complete": (afterRun("testCompleteAt"), ""),
        "submitted": (submitted, "by hand" if submit.get("byHand") else ""),
        "ended": (mine(record, "endedAt"), ""),
        "shared": (mine(record, "whatsappSentAt"), ""),
        "closed": (mine(record, "closedAt"), ""),
    }
    last = max((n for n, (key, _) in enumerate(steps) if found[key][0]), default=-1)
    out = []
    for n, (key, label) in enumerate(steps):
        at, how = found[key]
        state = "done" if at else "skipped" if n < last else "current" if n == last + 1 else "todo"
        out.append({"key": key, "label": label, "at": at, "how": how, "state": state})
    skipped = mine(record, "stationarySkippedAt")
    for step in out:  # failed 3 times and skipped on purpose
        if step["key"] == "stationary" and step["state"] != "done" and skipped:
            step.update(state="skipped", at=skipped, how=f"failed {record.get('stationaryFails') or '?'}x, skipped")
    return out
