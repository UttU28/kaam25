"""Talk to your normal Chrome through the Kaam25 extension (chromeExtension folder).

The app opens pages in your everyday Chrome profile (your own logins). The
extension does the work on the page and posts results back to a small
server on 127.0.0.1 that only this computer can reach.
"""

import base64
import json
import os
import secrets
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# From .env. bridgePort must match chromeExtension/background.js and manifest.json.
from .config import appDir, bridgePort, chromePaths, chromeUserDataDir, debugLogPath

extensionMissingMessage = (
    "Chrome didn't answer. Open chrome://extensions and click reload on Kaam25 Helper "
    "(and check it's turned on), then try again."
)
extensionOldMessage = (
    "The Kaam25 Helper extension in Chrome is out of date. Open chrome://extensions and "
    "click reload on it once; after that it updates itself."
)

extensionManifest = appDir / "chromeExtension" / "manifest.json"

pendingMessages = {}  # requestId -> latest message from the extension
pendingFiles = {}     # requestId -> local files the extension may fetch for that request
pendingItems = {}     # requestId -> extra JSON handed over with those files (a WhatsApp batch's WOs)
messagesCondition = threading.Condition()
bridgeServer = None
bridgeError = None    # why the bridge couldn't start (e.g. the port is taken), for status displays
tabsToClose = set()   # EQ tab tokens; handed to the extension on its next check-in (every 30 s)
lastContact = {"at": None, "version": None}  # the extension's latest message of any kind


def bridgeStatus():
    """For the web app's status light: is the bridge up, and when did the extension last check in."""
    return {"running": bridgeServer is not None, "error": bridgeError, "port": bridgePort,
            "lastContactAt": lastContact["at"], "extensionVersion": lastContact["version"],
            "diskVersion": getExtensionVersion()}


def requestTabsClosed(tokens):
    """Ask the extension to close these kept tabs (e.g. a ticket's EQ tabs after Done).
    The bridge must be running for the extension to pick this up."""
    startBridge()
    with messagesCondition:
        tabsToClose.update(token for token in tokens if token)


class ChromeBridgeError(Exception):
    pass


class ExtensionOutdatedError(ChromeBridgeError):
    pass


class StoppedError(ChromeBridgeError):
    """You pressed Stop in the app."""


# ---------- Stop ----------
stopRequested = threading.Event()
requestsToCancel = set()  # handed to the extension with its next message, so it drops those jobs


def stopAll():
    """Stop button: end the current wait at once, and tell the extension to drop the running
    job(s) so it skips anything not yet done (Create / Submit / Send are checked first)."""
    with messagesCondition:
        stopRequested.set()
        requestsToCancel.update(pendingMessages.keys())
        messagesCondition.notify_all()


def resetStop():
    """Called when a new run starts."""
    stopRequested.clear()


def raiseIfStopped():
    if stopRequested.is_set():
        raise StoppedError("Stopped by you.")


def getExtensionVersion():
    """Version of the extension files on disk (what Chrome should be running)."""
    try:
        return json.loads(extensionManifest.read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        return None


def isExtensionOutdated(message):
    """True when Chrome runs older extension code than what's on disk. Newer code reports
    its own "build"; a message without one comes from an old saved copy Chrome kept
    running (seen after a Chrome restart), even if its manifest version looks current."""
    sentVersion = message.get("version")
    if not sentVersion:
        return False  # too old to reload itself; handled by extensionOldMessage
    diskVersion = getExtensionVersion()
    return sentVersion != diskVersion or message.get("build") != diskVersion


def writeDebugLog(message):
    build = message.get("build")
    version = message.get("version", "?")
    versionText = version if not build or build == version else f"{version}/code {build}"
    line = (f"{time.strftime('%H:%M:%S')} v{versionText} "
            f"[{message.get('url', '')[:80]}] {message.get('text', '')}\n")
    try:
        with open(debugLogPath, "a", encoding="utf-8") as logFile:
            logFile.write(line)
    except OSError:
        pass


# Where the TEMS test is, as the TEMS tab's watcher last said (it repeats every 20 s while it watches):
# "started", "stationary" (running), "mobility" (stationary done), "complete" (all done:
# Submit / Discard / Suspend showing), "closed" (one of those pressed). Live Testing reads it.
temsStage = {"stage": "", "wo": "", "at": 0.0}


# Stationary test failures in this run, from the TEMS tab: fails = "Stationary test failed" seen,
# waiting = TEMS asks to start the stationary test again (not pressed - Live Testing asks you),
# ack = the fails count you already answered (Cancel / Redo).
stationaryAlert = {"wo": "", "fails": 0, "waiting": False, "ack": 0, "at": 0.0}


def resetStationaryAlert(wo=""):
    stationaryAlert.update(wo=wo, fails=0, waiting=False, ack=0, at=0.0)


def noteStationary(event, wo=""):
    if wo and stationaryAlert["wo"] and wo.lower() != stationaryAlert["wo"].lower():
        resetStationaryAlert(wo)  # another WO's run: count from 0
    stationaryAlert["wo"] = wo or stationaryAlert["wo"]
    if event == "stationaryFailed":
        stationaryAlert["fails"] += 1
    else:
        stationaryAlert["waiting"] = True
    stationaryAlert["at"] = time.time()


def setTemsStage(stage, wo=""):
    temsStage.update(stage=stage, wo=wo or temsStage.get("wo", ""), at=time.time())


def registerFiles(requestId, paths, items=None):
    """Let the extension fetch these files (and only these) for this request. items: extra JSON
    handed over with them (a WhatsApp batch: each WO's caption and which files are its)."""
    with messagesCondition:
        pendingFiles[requestId] = [Path(p) for p in paths]
        if items is not None:
            pendingItems[requestId] = items


class BridgeHandler(BaseHTTPRequestHandler):
    def sendJson(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # /whatsapp#... and /tems#... -> a tiny page; the extension reads the #... and hands the
        # job to your open WhatsApp Web / TEMS Paragon tab (or turns this tab into one).
        triggerPages = {"/whatsapp": ("WhatsApp", "Sending to WhatsApp…"), "/tems": ("TEMS", "Opening TEMS…")}
        page = triggerPages.get(self.path.split("?")[0].split("#")[0])
        if self.path.split("?")[0].split("#")[0] == "/app":
            # /app#url=... -> the extension switches to your open Kaam25 tab (pinned or not) and closes
            # this one. No extension (or no Kaam25 tab): this page becomes the app after 3 s.
            body = ("<!doctype html><meta charset='utf-8'><title>Kaam25: 13 Bhai gaadi chalayega</title>"
                    "<body style='background:#0f1115;color:#8a91a0;font:14px Segoe UI;padding:40px'>Opening Kaam25…"
                    "<script>const u=new URLSearchParams(location.hash.slice(1)).get('url');"
                    "if(u&&/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/?$/.test(u))setTimeout(()=>location.replace(u),3000);</script>"
                    "</body>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if page:
            body = (f"<!doctype html><meta charset='utf-8'><title>Kaam25: 13 Bhai gaadi chalayega - {page[0]}</title>"
                    "<body style='background:#0f1115;color:#8a91a0;font:14px Segoe UI;padding:40px'>"
                    f"{page[1]}</body>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # /files/<requestId> -> the registered files, base64-encoded.
        parts = self.path.strip("/").split("/")
        with messagesCondition:
            paths = pendingFiles.get(parts[1]) if len(parts) == 2 and parts[0] == "files" else None
            items = pendingItems.get(parts[1]) if paths is not None else None
        if paths is None:
            self.sendJson({"error": "unknown request"}, 404)
            return
        try:
            files = [{
                "name": path.name,
                "lastModified": int(path.stat().st_mtime * 1000),
                "data": base64.b64encode(path.read_bytes()).decode("ascii"),
            } for path in paths]
        except OSError as error:
            self.sendJson({"error": f"Couldn't read log files: {error}"}, 500)
            return
        self.sendJson({"files": files, **({"items": items} if items is not None else {})})

    def do_POST(self):
        if self.path != "/result":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            message = json.loads(self.rfile.read(length))
            requestId = message.get("requestId")
        except (ValueError, AttributeError):
            self.send_response(400)
            self.end_headers()
            return

        lastContact.update(at=time.time(), version=message.get("version"))
        if message.get("stage") == "log":
            writeDebugLog(message)
        elif message.get("stage") == "ping":
            pass  # the extension checking in; the reply below tells it to reload if it's out of date
        elif message.get("stage") == "temsStage":
            setTemsStage(message.get("temsStage") or "", message.get("wo") or "")
            if message.get("event") in ("stationaryFailed", "stationaryAsk"):
                noteStationary(message["event"], message.get("wo") or "")
            if message.get("event") == "gridEntered":  # TEMS: "Entered target grid cell ..." -> check-in
                from .gridWatch import fromTemsPopup
                threading.Thread(target=fromTemsPopup, args=(message.get("eventText") or "", message.get("wo") or ""),
                                 daemon=True).start()
        else:
            with messagesCondition:
                if requestId in pendingMessages:  # ignore anything we didn't ask for
                    pendingMessages[requestId] = message
                    messagesCondition.notify_all()

        # Tell an out-of-date extension to reload itself from the files on disk, and hand over
        # any tabs waiting to be closed.
        reply = {"reload": isExtensionOutdated(message)}
        with messagesCondition:
            if tabsToClose:
                reply["closeTabs"] = sorted(tabsToClose)
                tabsToClose.clear()
            if requestsToCancel:
                reply["cancel"] = sorted(requestsToCancel)
                requestsToCancel.clear()
        self.sendJson(reply)

    def log_message(self, *args):
        pass


class ExclusiveServer(ThreadingHTTPServer):
    """Refuses to share the port, so a second copy of the app fails loudly instead of
    silently stealing the extension's messages (Windows allows sharing by default)."""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def startBridge():
    global bridgeServer, bridgeError
    if bridgeServer:
        return
    busyMessage = (f"Port {bridgePort} is busy. Is another copy of Kaam25 already running? "
                   "Close it and try again.")
    try:
        socket.create_connection(("127.0.0.1", bridgePort), timeout=0.3).close()
        bridgeError = busyMessage
        raise ChromeBridgeError(busyMessage)  # something is already listening
    except OSError:
        pass
    try:
        bridgeServer = ExclusiveServer(("127.0.0.1", bridgePort), BridgeHandler)
    except OSError:
        bridgeError = busyMessage
        raise ChromeBridgeError(busyMessage)
    bridgeError = None
    threading.Thread(target=bridgeServer.serve_forever, daemon=True).start()


def findChrome():
    for path in chromePaths:
        if os.path.exists(path):
            return path
    raise ChromeBridgeError("Couldn't find chrome.exe. Is Google Chrome installed?")


def getLastUsedProfile():
    """The Chrome profile you used most recently, e.g. 'Default' or 'Profile 1'."""
    try:
        localState = json.loads((chromeUserDataDir / "Local State").read_text(encoding="utf-8"))
        return localState.get("profile", {}).get("last_used") or "Default"
    except (OSError, ValueError):
        return "Default"


def openInChrome(url):
    """Open a new tab in your normal Chrome, reusing the window that's already open."""
    subprocess.Popen([findChrome(), f"--profile-directory={getLastUsedProfile()}", url])


def waitForStage(requestId, stage, timeout, onProgress=None):
    """Wait until the extension reports `stage` (or 'done') for this request. onProgress(message)
    gets each "progress" report on the way (outside the lock)."""
    deadline = time.time() + timeout
    lastSeq = None
    while time.time() < deadline:
        raiseIfStopped()
        fresh = None
        with messagesCondition:
            message = pendingMessages.get(requestId) or {}
            if message.get("stage") in (stage, "done"):
                return message
            if message.get("stage") == "progress" and message.get("seq") != lastSeq:
                fresh = message
            else:
                messagesCondition.wait(max(0.05, min(1.0, deadline - time.time())))
        if fresh:
            lastSeq = fresh.get("seq")
            if onProgress:
                try:
                    onProgress(fresh)
                except Exception:
                    pass  # showing progress must never break the run
    raiseIfStopped()
    return None


def runInChrome(buildUrl, openUrl=openInChrome, startTimeout=25, timeout=70, timeoutMessage="Timed out.",
                onProgress=None):
    """Open buildUrl(requestId) in Chrome and return the extension's final message.

    If the extension was out of date it reloads itself, so try once more."""
    try:
        return runOnce(buildUrl, openUrl, startTimeout, timeout, timeoutMessage, onProgress)
    except ExtensionOutdatedError:
        time.sleep(3)  # give the extension time to reload
        return runOnce(buildUrl, openUrl, startTimeout, timeout, timeoutMessage, onProgress)


def runOnce(buildUrl, openUrl, startTimeout, timeout, timeoutMessage, onProgress=None):
    raiseIfStopped()  # Stop pressed between steps: don't open anything new
    startBridge()
    requestId = secrets.token_hex(8)
    with messagesCondition:
        pendingMessages[requestId] = {}
    try:
        openUrl(buildUrl(requestId))
        started = waitForStage(requestId, "started", startTimeout)
        if not started:
            raise ChromeBridgeError(extensionMissingMessage)
        if not started.get("version"):
            raise ChromeBridgeError(extensionOldMessage)  # too old to update itself
        if isExtensionOutdated(started):
            raise ExtensionOutdatedError("Extension was out of date; it reloaded itself.")
        message = waitForStage(requestId, "done", timeout, onProgress)
        if not message or message.get("stage") != "done":
            raise ChromeBridgeError(timeoutMessage)
        return message
    finally:
        with messagesCondition:
            pendingMessages.pop(requestId, None)
            pendingFiles.pop(requestId, None)
            pendingItems.pop(requestId, None)
