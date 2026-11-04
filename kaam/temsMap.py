"""Live TEMS Paragon map data, read-only.

TEMS's own map (localhost:8080, Map tab) draws from a data service on this PC (TEMS_DATA_URL,
default http://localhost:8181). We read the same data so the Live Testing page can draw the
same map, on this PC or on a tablet: grid square + stationary point, planned route + waypoints,
the drive track and the car position. Only GET requests that TEMS's own screens make - nothing
in TEMS changes.
"""
import json
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

dataUrl = os.environ.get("TEMS_DATA_URL", "http://localhost:8181").rstrip("/")
appUrl = os.environ.get("TEMS_URL", "http://localhost:8080/").rstrip("/")

parts = {
    "grid": dataUrl + "/api/dataprovider/grid/getgrid",
    "gridState": dataUrl + "/api/dataprovider/grid/getlastevent",
    "route": dataUrl + "/api/dataprovider/plannedroute/getplannedroute",
    "routeState": dataUrl + "/api/dataprovider/plannedroute/getplannedroutestate",
    "track": dataUrl + "/api/dataprovider/track/currentsessiontrack",
    "position": dataUrl + "/api/dataprovider/currentposition/get",
    "view": dataUrl + "/api/map/state",
    "woEvent": appUrl + "/probe/lastworkorderevent",
    "wos": appUrl + "/probe/workorderinformations",
}
previousTrackUrl = dataUrl + "/api/dataprovider/track/previoussessiontrack"


class TemsOffline(Exception):
    pass


def value(url, timeout=4):
    """The `value` of a TEMS reply ({success, error, value}); None when TEMS says no."""
    with urllib.request.urlopen(url, timeout=timeout) as response:
        data = json.load(response)
    return data.get("value") if data.get("success") else None


def point(p):
    return [round(p["latitude"], 7), round(p["longitude"], 7)] if p else None


def insideCell(p, corners):
    """Is point p ({latitude, longitude}) inside the cell (TEMS matches stationary points this way)."""
    inside = False
    for n in range(len(corners)):
        a, b = corners[n], corners[n - 1]
        if (a["latitude"] > p["latitude"]) != (b["latitude"] > p["latitude"]) and \
                p["longitude"] < (b["longitude"] - a["longitude"]) * (p["latitude"] - a["latitude"]) / \
                (b["latitude"] - a["latitude"]) + a["longitude"]:
            inside = not inside
    return inside


def woName(event, wos):
    """The WO TEMS ran last ('Cloud WO - X' -> X) and whether it's running now."""
    if not event:
        return "", False
    wid = event.get("workOrderIdentity")
    name = next((w.get("name", "") for w in wos or [] if w.get("workOrderIdentity") == wid), "")
    name = name.split(" - ", 1)[1] if name.startswith(("Cloud WO - ", "Local WO - ")) else name
    return name.strip(), bool(event.get("workOrderRuntimeState"))


# TEMS's work order runtime states (its WorkOrderRuntimeState), by number.
runtimeStates = ["None", "Opening", "Opened", "Closing", "Closed", "Validating", "Validated", "Executing",
                 "Executed", "Pausing", "Paused", "Failed", "Recovering", "RecoveryFailed"]
playable = (6, 10)   # Validated / Paused: the Control page's play button starts / resumes it
executing = 7


def workOrderState():
    """The open WO and where it is: {wo, state (number), stateName, error}. Read-only."""
    event = value(parts["woEvent"]) or {}
    try:
        wos = value(parts["wos"]) or []
    except Exception:
        wos = []
    wo, _ = woName(event, wos)
    state = event.get("workOrderRuntimeState")
    state = state if isinstance(state, int) else 0
    error = (event.get("errorInfo") or {}).get("error") or ""
    name = runtimeStates[state] if 0 <= state < len(runtimeStates) else str(state)
    return {"wo": wo, "state": state, "stateName": name, "error": error}


def readMap(trackFrom=0):
    """Everything the map draws. The track is sent from point `trackFrom` on (the page keeps
    what it already has); when the track got shorter (new session) it is sent whole."""
    with ThreadPoolExecutor(len(parts) + 1) as pool:
        futures = {name: pool.submit(value, url) for name, url in parts.items()}
        if trackFrom == 0:
            futures["previousTrack"] = pool.submit(value, previousTrackUrl)
        results = {}
        for name, future in futures.items():
            try:
                results[name] = future.result()
            except Exception as error:
                results[name] = error

    mapParts = [name for name in parts if name not in ("woEvent", "wos")]
    errors = [results[name] for name in mapParts if isinstance(results[name], Exception)]
    if len(errors) == len(mapParts):
        raise TemsOffline(f"TEMS map data isn't reachable at {dataUrl} - is TEMS Paragon running? ({errors[0]})")
    ok = {name: (None if isinstance(r, Exception) else r) for name, r in results.items()}

    gridValue = ok["grid"] or {}
    gridState = (ok["gridState"] or {}).get("gridState") or {}
    # TEMS keys both states by the stationary point's id: the cell is filled half with the
    # stationary state's colour and half with the mobility state's colour.
    stationaryStates = {s["id"]: s["state"] for s in gridState.get("stationaryStates") or []}
    mobilityStates = {s["id"]: s["state"] for s in gridState.get("mobilityStates") or []}
    indexOf = {x["id"]: x["index"] for x in gridValue.get("localIndexLookup") or []}
    stations = gridValue.get("stationaryLocations") or []
    cells = []
    for c in (gridValue.get("grid") or {}).get("cells") or []:
        corners = c.get("corners") or []
        station = next((s for s in stations if s.get("point") and insideCell(s["point"], corners)), None)
        cells.append({
            "id": c["id"], "index": indexOf.get(c["id"]), "corners": [point(p) for p in corners],
            "station": point(station["point"]) if station else None,
            "stationaryState": stationaryStates.get(station["id"], 0) if station else None,
            "mobilityState": mobilityStates.get(station["id"], 0) if station else None,
        })

    routeState = ok["routeState"] or {}
    waypointStates = routeState.get("waypointStates") or {}
    route = [{"at": point(p), "state": waypointStates.get(str(n), waypointStates.get(n, 0))}
             for n, p in enumerate(ok["route"] or [])]

    track = [point(p) for p in ok["track"] or []]
    if trackFrom > len(track):
        trackFrom = 0
    view = (ok["view"] or {}).get("viewport") or {}
    wo, running = woName(ok["woEvent"], ok["wos"])
    data = {
        "wo": wo, "running": running,
        "cells": cells, "targetCell": gridState.get("targetCellId"), "forcePending": gridState.get("forcePending"),
        "route": route, "targetWaypoint": routeState.get("targetWaypointIndex", -1),
        "trackFrom": trackFrom, "track": track[trackFrom:], "trackTotal": len(track),
        "position": point(ok["position"]),
        "center": point(view.get("center")), "zoom": view.get("zoom"),
        "partial": [name for name, r in results.items() if isinstance(r, Exception)],
    }
    if "previousTrack" in ok:
        data["previousTrack"] = [point(p) for p in ok["previousTrack"] or []]
    return data
