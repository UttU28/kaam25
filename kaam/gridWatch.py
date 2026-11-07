"""Check-in: the first time the car is inside the WO's grid (any cell, from any direction).

While Live Testing is open on a WO (the page asks every few seconds), a background loop reads
the grid TEMS has open and where the car is - TEMS's own position (the scanner's GPS), else the
phones' GPS - and checks in the WO the first time the car is inside a cell. TEMS's "Entered target
grid cell" pop-up checks in too (the TEMS tab reports it). Only the WO TEMS has open is checked:
another WO's grid says nothing about this one.
"""
import threading
import time

from . import temsMap, ticketFlow
from .ticketStore import getRecord

watchSeconds = 30   # keep checking this long after the page last asked
pauseSeconds = 3    # between checks
phoneEvery = 10     # phone GPS (adb) at most this often, only when TEMS has no position

state = {"wo": "", "asked": 0.0, "thread": None, "phoneAt": 0.0, "last": ""}
lock = threading.Lock()


def sameWo(a, b):
    import re

    def norm(text):
        return re.sub(r"(g\d+)[de]", r"\1", re.sub(r"[^a-z0-9]", "", (text or "").lower()))
    return bool(a) and norm(a) == norm(b)


def watch(wo):
    """Live Testing has this WO up: keep checking it (starts the loop if needed)."""
    if not wo:
        return
    with lock:
        state.update(wo=wo, asked=time.time())
        if not (state["thread"] and state["thread"].is_alive()):
            state["thread"] = threading.Thread(target=loop, daemon=True, name="gridWatch")
            state["thread"].start()


def loop():
    while time.time() - state["asked"] < watchSeconds:
        try:
            checkOnce(state["wo"])
        except Exception as error:
            state["last"] = f"error: {error}"
        time.sleep(pauseSeconds)


def cornersOf(gridValue):
    return [c.get("corners") or [] for c in ((gridValue or {}).get("grid") or {}).get("cells") or [] if c.get("corners")]


def inGrid(spot, cells):
    return any(temsMap.insideCell(spot, corners) for corners in cells)


def checkOnce(wo):
    """One look: the car inside this WO's grid -> check-in (first time only)."""
    record = getRecord(wo) or {}
    if not record or ticketFlow.mine(record, "checkInTime") or not ticketFlow.ticketStart(record):
        state["last"] = "checked in already" if record else "not in Records"
        return
    event = temsMap.value(temsMap.parts["woEvent"]) or {}
    temsWo, _ = temsMap.woName(event, temsMap.value(temsMap.parts["wos"]))
    if not sameWo(temsWo, wo):
        state["last"] = f"TEMS has {temsWo or 'no WO'} open"
        return
    cells = cornersOf(temsMap.value(temsMap.parts["grid"]))
    if not cells:
        state["last"] = "no grid in TEMS"
        return
    spot, source = temsMap.value(temsMap.parts["position"]), "TEMS position"
    if not spot and time.time() - state["phoneAt"] > phoneEvery:
        state["phoneAt"] = time.time()
        from .phoneControl import phoneLocation
        fix = phoneLocation(maxAgeSeconds=60)  # fresh and close enough only
        if fix and fix["acc"] <= 100:
            spot, source = {"latitude": fix["lat"], "longitude": fix["lon"]}, f"{fix.get('phone') or 'phone'} GPS"
    if not spot:
        state["last"] = "no position"
        return
    inside = inGrid(spot, cells)
    state["last"] = f"{'inside' if inside else 'outside'} ({source})"
    if inside:
        ticketFlow.checkIn(wo, source)


def fromTemsPopup(text, wo=""):
    """TEMS said "Entered target grid cell <WO>": check that WO in (first time only)."""
    target = state["wo"] if not wo or sameWo(wo, state["wo"]) else wo  # the page's spelling of it
    if target and getRecord(target):
        ticketFlow.checkIn(target, "TEMS pop-up")
