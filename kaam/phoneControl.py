"""Drive the test phones over adb: unlock, Service Mode + Speedtest split screen, airplane toggle,
speed test with its result, and which network (NR / LTE) the phone is on.

Phones are named in .env as  PHONES=TMO 1=<serial>,TMO 2=<serial>  (serials from `adb devices`).
The names should match the device names in Vysor, so deskLayout.py can find their windows.
The Live Testing page in the web app uses this; so do the .bat files:
    venv\\Scripts\\python.exe -m kaam.phoneControl fullTest            (every phone, one after another)
    venv\\Scripts\\python.exe -m kaam.phoneControl serviceMode "TMO 1"
    venv\\Scripts\\python.exe -m kaam.phoneControl airplane | speedtest [phone ...]
"""

import base64
import html
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

appDir = Path(__file__).resolve().parent.parent
load_dotenv(appDir / ".env", override=True)

noWindow = getattr(subprocess, "CREATE_NO_WINDOW", 0)


# ---------- progress messages and Stop ----------
# The web app shows these lines in its job panel; on the command line they're printed.
listeners = {}  # thread id -> callback(text)
stopCheck = None  # the web app sets this to a function that raises when you press Stop


def listenHere(callback):
    """Sends this thread's messages to callback (None = back to printing)."""
    if callback:
        listeners[threading.get_ident()] = callback
    else:
        listeners.pop(threading.get_ident(), None)


def say(text):
    callback = listeners.get(threading.get_ident())
    if callback:
        callback(text)
    else:
        print(text, flush=True)


def checkStop():
    if stopCheck:
        stopCheck()


# ---------- adb ----------

def vysorAppDir():
    """Newest  %LOCALAPPDATA%\\vysor\\app-x.y.z  folder, or None."""
    root = Path(os.environ.get("LOCALAPPDATA", "")) / "vysor"
    versions = sorted(root.glob("app-*"), key=lambda p: [int(n) for n in re.findall(r"\d+", p.name)])
    return versions[-1] if versions else None


def findAdb():
    """PHONE_ADB from .env, else adb on PATH, else the adb that ships with Vysor."""
    configured = (os.environ.get("PHONE_ADB") or "").strip()
    if configured:
        return os.path.expandvars(configured)
    onPath = shutil.which("adb")
    if onPath:
        return onPath
    vysor = vysorAppDir()
    if vysor:
        bundled = vysor / "resources" / "app.asar.unpacked" / "native" / "win32" / "adb.exe"
        if bundled.exists():
            return str(bundled)
    raise RuntimeError("adb not found. Install Vysor, or set PHONE_ADB=<path to adb.exe> in .env.")


adbPath = None


def runAdb(args, serial=None, timeout=30):
    global adbPath
    adbPath = adbPath or findAdb()
    command = [adbPath] + (["-s", serial] if serial else []) + list(args)
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout,
                            encoding="utf-8", errors="replace", creationflags=noWindow)
    return result.stdout.strip()


def adbShell(serial, command, timeout=30):
    return runAdb(["shell", command], serial=serial, timeout=timeout)


def connectedSerials():
    lines = runAdb(["devices"]).splitlines()[1:]
    return [line.split("\t")[0] for line in lines if line.endswith("\tdevice")]


# ---------- which phones ----------

def configuredPhones():
    """{'TMO 1': 'R5CY...', 'TMO 2': '...'} from PHONES in .env, in that order."""
    phones = {}
    for item in (os.environ.get("PHONES") or "").split(","):
        if "=" in item:
            name, serial = item.split("=", 1)
            if name.strip() and serial.strip():
                phones[name.strip()] = serial.strip()
    return phones


def normalName(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def phoneName(serial):
    for name, phoneSerial in configuredPhones().items():
        if phoneSerial == serial:
            return name
    return serial


def pickPhones(names=None):
    """Serials to act on. No names = every connected phone. Names may be 'TMO 1', 'tmo1', '1' or a serial."""
    connected = connectedSerials()
    if not names:
        if not connected:
            raise RuntimeError("No phone is connected over USB (adb devices shows none).")
        return connected
    phones = configuredPhones()
    serials = []
    for name in names:
        wanted = normalName(name)
        match = next((serial for phone, serial in phones.items()
                      if normalName(phone) == wanted or normalName(phone).endswith(wanted) and wanted.isdigit()),
                     None)
        serial = match or name
        if serial not in connected:
            raise RuntimeError(f"{name} ({serial}) is not connected. Connected: {', '.join(connected) or 'none'}.")
        serials.append(serial)
    return serials


def onEachPhone(action, serials):
    """Runs action(serial) on every phone at the same time; returns {serial: error or None}."""
    errors = {}
    parentListener = listeners.get(threading.get_ident())

    def worker(serial):
        listenHere(parentListener)
        try:
            action(serial)
            errors[serial] = None
        except Exception as error:
            errors[serial] = error
            say(f"[{phoneName(serial)}] failed: {error}")
        finally:
            listenHere(None)

    threads = [threading.Thread(target=worker, args=(serial,)) for serial in serials]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return errors


# ---------- airplane mode ----------

def isAirplaneOn(serial):
    return adbShell(serial, "cmd connectivity airplane-mode").strip().lower() == "enabled"


airplaneSeconds = float(os.environ.get("PHONE_AIRPLANE_SECONDS") or 5)


def toggleAirplane(serial, waitSeconds=None):
    """Airplane mode on, wait, off again (forces the phone to re-attach to the network).
    Runs as one command on the phone and returns once the phone is back online (or after 30s)."""
    name = phoneName(serial)
    waitSeconds = airplaneSeconds if waitSeconds is None else waitSeconds
    wakeAndUnlock(serial)
    say(f"[{name}] airplane mode ON for {waitSeconds:g}s")
    started = time.time()
    result = adbShell(serial, (
        f"cmd connectivity airplane-mode enable; sleep {waitSeconds:g}; cmd connectivity airplane-mode disable; "
        "echo OFF; i=0; while [ $i -lt 60 ]; do "
        "ping -c 1 -W 1 8.8.8.8 >/dev/null 2>&1 && { echo ONLINE; break; }; sleep 0.5; i=$((i+1)); done"),
        timeout=waitSeconds + 90)
    if "OFF" not in result:
        say(f"[{name}] WARNING: airplane mode may still be on")
    elif "ONLINE" in result:
        say(f"[{name}] airplane mode OFF, back online after {time.time() - started:.0f}s")
    else:
        say(f"[{name}] airplane mode OFF, but no internet yet")
    return "ONLINE" in result


startSpeedtestScript = """(() => {
  const button = [...document.querySelectorAll('a,button,[role=button]')]
    .find(e => /^(go|test again)$/i.test(e.textContent.trim()) && e.offsetParent !== null);
  if (!button) return '';
  button.click();
  return button.textContent.trim();
})()"""


speedtestResultScript = """(() => {
  const text = document.body.innerText;
  const visible = (re) => [...document.querySelectorAll('a,button,[role=button]')]
    .some(e => re.test(e.textContent.trim()) && e.offsetParent !== null);
  const id = text.match(/Result ID:\\s*(\\d+)/i);
  const result = text.match(/DOWNLOAD\\s+Mbps\\s+([\\d.]+)\\s+Ping\\s+ms\\s+([\\d.]+)(?:\\s+([\\d.]+))?/i);
  return { finished: visible(/^test again$/i), resultId: id ? id[1] : '',
           download: result ? result[1] : '', ping: result ? result[2] : '', pingLoaded: result && result[3] || '' };
})()"""


def evalOnSpeedtest(serial, script):
    """Runs JavaScript on the phone's Speedtest page. Raises if Speedtest isn't open."""
    port, pages = devtoolsPages(serial)
    try:
        for page in pages:
            if "speedtest.net" in page.get("url", "") and page.get("webSocketDebuggerUrl"):
                return devtoolsEval(page["webSocketDebuggerUrl"], script)
        raise RuntimeError("Speedtest isn't open on the phone (run the Service Mode setup first).")
    finally:
        runAdb(["forward", "--remove", f"tcp:{port}"], serial=serial)


def startSpeedtest(serial):
    """Presses GO (or Test Again after an earlier test) on the open Speedtest page. Returns True if pressed."""
    name = phoneName(serial)
    wakeAndUnlock(serial)
    closeSpeedtestPopup(serial, waitSeconds=0)  # the 'better with the app' popup would block GO
    for _ in range(10):  # the button can take a moment to show after the network comes back
        checkStop()
        pressed = evalOnSpeedtest(serial, startSpeedtestScript)
        if pressed:
            say(f"[{name}] speed test started ({pressed})")
            return True
        time.sleep(1)
    say(f"[{name}] WARNING: no GO / Test Again button on the Speedtest page")
    return False


def runSpeedtest(serial, timeout=180):
    """Starts a speed test and waits for its result: {download, ping, pingLoaded, resultId}."""
    name = phoneName(serial)
    before = evalOnSpeedtest(serial, speedtestResultScript) or {}
    if not startSpeedtest(serial):
        raise RuntimeError("Could not start the speed test.")
    network = readNetworkSettled(serial)  # what the phone is latched to while the test runs
    say(f"[{name}] on {networkText(network)}")
    say(f"[{name}] waiting for the result…")
    end = time.time() + timeout
    while time.time() < end:
        checkStop()
        time.sleep(2)
        now = evalOnSpeedtest(serial, speedtestResultScript) or {}
        if now.get("finished") and now.get("resultId") and now.get("resultId") != before.get("resultId"):
            loaded = f", {now['pingLoaded']} ms loaded" if now.get("pingLoaded") else ""
            say(f"[{name}] result: {now.get('download') or '?'} Mbps down, ping {now.get('ping') or '?'} ms{loaded}"
                f" (Result ID {now['resultId']})")
            if network.get("source") != "serviceMode":  # Service Mode wasn't ready at the start: try again
                later = readNetwork(serial)
                if later.get("source") == "serviceMode" and later.get("tech") == network.get("tech"):
                    network = later
                    say(f"[{name}] on {networkText(network)}")
            return {"phone": name, "network": network, **now}
    raise RuntimeError(f"No speed test result after {timeout}s.")


def failedResult(serial, reason):
    """A test that gave no speed (no service, no internet, page stuck) - still shown and saved."""
    network = readNetwork(serial)
    say(f"[{phoneName(serial)}] no speed: {reason} (network: {networkText(network)})")
    return {"phone": phoneName(serial), "network": network, "download": "", "ping": "", "pingLoaded": "",
            "resultId": f"none-{int(time.time())}", "error": reason}


def airplaneThenSpeedtest(serial):
    """airplaneToggle.bat: re-attach to the network, then start a test (doesn't wait for it)."""
    toggleAirplane(serial)
    startSpeedtest(serial)


def speedTest(serial):
    """Speed test on what's open now; a failure still gives a result (no speed + the network)."""
    try:
        return runSpeedtest(serial)
    except Exception as error:
        if type(error).__name__ == "StoppedError":  # Stop pressed: end everything
            raise
        return failedResult(serial, str(error))


def fullTest(serial):
    """One phone, start to end: Service Mode + Speedtest (only if not already up), airplane toggle,
    speed test, wait for the result. Returns the result (no speed + the network if it failed)."""
    checkStop()
    serviceModeSplit(serial)
    checkStop()
    if not toggleAirplane(serial):
        return failedResult(serial, "No internet after the airplane toggle")
    checkStop()
    return speedTest(serial)


techOrder = {"NR": 0, "LTE": 1}  # NR phones are tested first, then LTE, then no service / unknown


def nrFirst(serials):
    """The phones sorted NR first, then LTE, then the rest (same order as given within each)."""
    networks = {serial: readNetwork(serial) for serial in serials}
    ordered = sorted(serials, key=lambda serial: techOrder.get(networks[serial].get("tech"), 2))
    say("Test order: " + ", ".join(f"{phoneName(s)} ({networks[s].get('tech') or '?'})" for s in ordered))
    return ordered


def fullTestOneByOne(serials, onResult=None, onOrder=None):
    """fullTest on each phone in turn, NR phones first then LTE - never two speed tests at the same time.
    onOrder(names) gets the test order; onResult(result) is called as each phone finishes."""
    serials = nrFirst(serials)
    if onOrder:
        onOrder([phoneName(serial) for serial in serials])
    results = []
    for serial in serials:
        say(f"===== {phoneName(serial)} =====")
        results.append(fullTest(serial))
        if onResult:
            onResult(results[-1])
    return results


# ---------- screen helpers ----------

def resumedActivities(serial):
    """[(component, taskId)] of the apps on screen right now, focused one first."""
    text = adbShell(serial, "dumpsys activity activities | grep topResumedActivity")
    return [(component, int(task)) for component, task in re.findall(r"ActivityRecord\{\S+ u\d+ (\S+) t(\d+)", text)]


def waitForActivity(serial, needle, timeout=15):
    """Waits until an app whose component contains needle is on screen; returns its task id."""
    end = time.time() + timeout
    while time.time() < end:
        for component, taskId in resumedActivities(serial):
            if needle in component:
                return taskId
        time.sleep(0.5)
    raise RuntimeError(f"{needle} did not open within {timeout}s.")


screenLocks = {}  # serial -> lock: two screen dumps at once on one phone make one of them fail
screenLocksGuard = threading.Lock()


def dumpScreen(serial):
    """The phone's screen as uiautomator XML (both halves of a split screen); '' if it can't be read."""
    with screenLocksGuard:
        lock = screenLocks.setdefault(serial, threading.Lock())
    with lock:
        for _ in range(3):
            dump = adbShell(serial, "uiautomator dump --windows /sdcard/kaamUi.xml >/dev/null && cat /sdcard/kaamUi.xml")
            if "<hierarchy" in dump or "<displays" in dump:
                return dump
            time.sleep(1)
    return ""


def screenNodes(serial):
    """Every on-screen element (both halves of a split screen) as (text, contentDesc, centerX, centerY)."""
    dump = dumpScreen(serial)
    nodes = []
    for node in re.findall(r"<node [^>]*>", dump):
        text = re.search(r' text="([^"]*)"', node)
        desc = re.search(r' content-desc="([^"]*)"', node)
        bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
        if bounds:
            x1, y1, x2, y2 = map(int, bounds.groups())
            nodes.append((text.group(1) if text else "", desc.group(1) if desc else "", (x1 + x2) // 2, (y1 + y2) // 2))
    return nodes


def findNode(serial, test):
    """First on-screen element where test(text, contentDesc) is true, as (text, x, y); or None."""
    for text, desc, x, y in screenNodes(serial):
        if test(text, desc):
            return text or desc, x, y
    return None


def tapLabel(serial, label):
    """Taps the first element whose text or description contains label. Returns False if none."""
    wanted = label.lower()
    for text, desc, x, y in screenNodes(serial):
        if wanted in text.lower() or wanted in desc.lower():
            adbShell(serial, f"input tap {x} {y}")
            return True
    return False


def splitScreen(serial, command):
    return adbShell(serial, f"dumpsys activity service SystemUIService WMShell splitscreen {command}")


# ---------- Service Mode + Speedtest ----------

serviceModeCode = "*#0011#"
speedtestLabel = os.environ.get("PHONE_SPEEDTEST_LABEL") or "Speedtest"
speedtestUrl = "https://www.speedtest.net/"
splitRatio = float(os.environ.get("PHONE_SPLIT_RATIO") or 0.70)  # Service Mode's share of the screen


def screenBottom(serial):
    """Where the apps end: top of the navigation bar, else the bottom of the screen."""
    insets = adbShell(serial, "dumpsys window | grep -m1 'type=navigationBars frame='")
    found = re.search(r"frame=\[\d+,(\d+)\]\[\d+,\d+\].*sideHint=BOTTOM", insets)
    if found:
        return int(found.group(1))
    size = re.search(r"(\d+)x(\d+)", adbShell(serial, "wm size"))
    return int(size.group(2)) if size else 2340


def resizeSplit(serial, ratio=splitRatio):
    """Drags the split-screen divider so the top app gets `ratio` of the screen."""
    target = round(screenBottom(serial) * ratio)
    for _ in range(3):
        divider = findNode(serial, lambda text, desc: desc == "Split screen divider")
        if not divider:
            say(f"[{phoneName(serial)}] WARNING: split-screen divider not found, size left as it is")
            return
        _, x, y = divider
        if abs(y - target) <= 35:  # close enough; the phone ignores very small drags anyway
            return
        # Drags fall a little short, so aim past the target by a quarter of the gap.
        adbShell(serial, f"input swipe {x} {y} {x} {target + (target - y) // 4} 800")
        time.sleep(1.2)


def openActiveSim(serial, waitSeconds=5):
    """Taps the '[n] SIMn INFORMATION' row in Service Mode (the SIM that's in use; 1 or 2)."""
    for _ in range(max(1, int(waitSeconds * 2))):
        row = findNode(serial, lambda text, desc: re.search(r"SIM\d\s+INFORMATION", text, re.I))
        if row:
            text, x, y = row
            adbShell(serial, f"input tap {x} {y}")
            say(f"[{phoneName(serial)}] opened {text.strip()}")
            return
        time.sleep(0.5)
    if waitSeconds:
        say(f"[{phoneName(serial)}] WARNING: no active SIM row in Service Mode")


# ---------- which network the phone is on (NR / LTE / none) ----------

def serviceModeLines(serial):
    """The text lines Service Mode shows right now ([] when it isn't on screen)."""
    dump = dumpScreen(serial)
    return [html.unescape(text).strip() for text in
            re.findall(r'<node [^>]*?text="([^"]+)"[^>]*?package="com\.sec\.android\.RilServiceModeApp"', dump)]


def network(tech, band="", pci="", rsrp="", sinr="", source=""):
    return {"tech": tech, "band": band, "pci": pci, "rsrp": rsrp, "sinr": sinr, "source": source}


def parseServiceMode(lines):
    """Network from Service Mode's SIM page, or None when it shows nothing useful (e.g. its main menu).
    NR or LTE is what Service Mode calls the serving network ("Serving PLMN(...)-NR5G" / "-LTE")."""
    text = "\n".join(lines)
    if not text or re.search(r"SIM\d\s+INFORMATION", text, re.I):
        return None

    def find(pattern):
        found = re.search(pattern, text, re.I | re.M)
        return found.group(1) if found else ""

    serving = find(r"Serving PLMN\([\d-]+\)-(\w+)").upper()
    if serving.startswith("NR"):
        return network("NR", find(r"NR_BAND\s*:\s*(n?\d+)"), find(r"NR_PCI\s*:\s*(\d+)"),
                       find(r"NR5G_RSRP\s*:\s*(-?[\d.]+)"), find(r"NR5G_SINR\s*:\s*(-?[\d.]+)"), "serviceMode")
    if serving == "LTE":
        band = find(r"(?:^|\s)BAND\s*:\s*(\d+)")
        return network("LTE", f"B{band}" if band else "", find(r"Earfcn:\s*\d+,\s*PCI:\s*(\d+)"),
                       find(r"(?:^|\s)RSRP\s*:\s*(-?\d+)"), find(r"(?:^|\s)SNR\s*:\s*(-?[\d.]+)"), "serviceMode")
    if re.search(r"no service|out of service|OUT_OF_SERVICE|Service\((?!available)", text, re.I):
        return network("No service", source="serviceMode")
    return None


def networkFromAndroid(serial):
    """Fallback without Service Mode: the in-service SIM slot's radio (NR / LTE), no band or signal."""
    text = adbShell(serial, "dumpsys telephony.registry | grep -m2 'mServiceState='")
    for line in text.splitlines():
        if "mDataRegState=0(IN_SERVICE)" in line:
            radio = re.search(r"getRilDataRadioTechnology=\d+\((\w+)\)", line)
            name = radio.group(1) if radio else ""
            return network("NR" if name.startswith("NR") else "LTE" if name.startswith("LTE") else "Unknown",
                           source="android")
    return network("No service", source="android")


def readNetwork(serial):
    """{tech: NR / LTE / No service / Unknown, band, pci, rsrp, sinr} - Service Mode first, else Android."""
    try:
        if any("ServiceMode" in c for c, _ in resumedActivities(serial)):
            found = parseServiceMode(serviceModeLines(serial))
            if found:
                return found
        return networkFromAndroid(serial)
    except Exception as error:
        return {**network("Unknown"), "error": str(error)}


def readNetworkSettled(serial, tries=5):
    """readNetwork, waiting a few seconds for Service Mode to refresh (e.g. just after airplane mode)."""
    found = readNetwork(serial)
    for _ in range(tries - 1):
        if found.get("source") == "serviceMode":
            break
        time.sleep(1)
        found = readNetwork(serial)
    return found


def networkText(found):
    """'NR n41 · PCI 602 · RSRP -102 · SINR 13.0' style one-liner."""
    if not found:
        return "Unknown"
    parts = [" ".join(p for p in (found.get("tech"), found.get("band")) if p)]
    parts += [f"{label} {found[key]}" for key, label in (("pci", "PCI"), ("rsrp", "RSRP"), ("sinr", "SINR")) if found.get(key)]
    return " · ".join(parts)


# ---------- Chrome page control (DevTools over adb) ----------

def devtoolsPages(serial):
    """Forwards Chrome's debugging socket to a free local port; returns (port, [pages])."""
    port = int(runAdb(["forward", "tcp:0", "localabstract:chrome_devtools_remote"], serial=serial))
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5) as response:
        return port, json.loads(response.read())


def devtoolsEval(webSocketUrl, expression):
    """Runs JavaScript in a Chrome tab and returns its value (tiny WebSocket client, no extra packages)."""
    url = urllib.parse.urlparse(webSocketUrl)
    with socket.create_connection((url.hostname, url.port), timeout=10) as connection:
        key = base64.b64encode(os.urandom(16)).decode()
        connection.sendall((f"GET {url.path} HTTP/1.1\r\nHost: {url.hostname}:{url.port}\r\nUpgrade: websocket\r\n"
                            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        received = b""
        while b"\r\n\r\n" not in received:
            chunk = connection.recv(4096)
            if not chunk:
                raise RuntimeError("Chrome closed the debugging connection.")
            received += chunk
        received = received.split(b"\r\n\r\n", 1)[1]

        message = json.dumps({"id": 1, "method": "Runtime.evaluate",
                              "params": {"expression": expression, "returnByValue": True}}).encode()
        mask = os.urandom(4)
        length = len(message)
        header = bytes([0x81]) + (bytes([0x80 | length]) if length < 126 else bytes([0x80 | 126]) + struct.pack(">H", length))
        connection.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(message)))

        def take(count):
            nonlocal received
            while len(received) < count:
                chunk = connection.recv(65536)
                if not chunk:
                    raise RuntimeError("Chrome closed the debugging connection.")
                received += chunk
            part, received = received[:count], received[count:]
            return part

        while True:
            _, size = take(2)
            size &= 0x7F
            if size == 126:
                size = struct.unpack(">H", take(2))[0]
            elif size == 127:
                size = struct.unpack(">Q", take(8))[0]
            reply = json.loads(take(size))
            if reply.get("id") == 1:
                return reply.get("result", {}).get("result", {}).get("value")


continueOnWebScript = """(() => {
  const link = [...document.querySelectorAll('a,button')]
    .find(e => /^continue on the web$/i.test(e.textContent.trim()) && e.offsetParent !== null);
  if (!link) return false;
  link.click();
  return true;
})()"""


def closeSpeedtestPopup(serial, waitSeconds=8):
    """Clicks 'Continue on the web' on Speedtest's 'better with the app' popup, only if it shows up."""
    port = None
    try:
        end = time.time() + waitSeconds
        while True:
            port, pages = devtoolsPages(serial)
            for page in pages:
                if "speedtest.net" in page.get("url", "") and page.get("webSocketDebuggerUrl"):
                    if devtoolsEval(page["webSocketDebuggerUrl"], continueOnWebScript):
                        say(f"[{phoneName(serial)}] closed the Speedtest app popup (Continue on the web)")
                        return
            runAdb(["forward", "--remove", f"tcp:{port}"], serial=serial)
            port = None
            if time.time() >= end:
                return
            time.sleep(1)
    except Exception as error:
        say(f"[{phoneName(serial)}] could not check the Speedtest popup: {error}")
    finally:
        if port:
            runAdb(["forward", "--remove", f"tcp:{port}"], serial=serial)


def leaveSplitScreen(serial):
    onScreen = resumedActivities(serial)
    if len(onScreen) > 1:
        splitScreen(serial, f"exitSplitScreen {onScreen[0][1]}")
        time.sleep(1)


def openSpeedtest(serial):
    """Opens the Speedtest shortcut from the home screen; falls back to speedtest.net in Chrome."""
    adbShell(serial, "input keyevent KEYCODE_HOME")
    time.sleep(1.5)
    if tapLabel(serial, speedtestLabel):
        return waitForActivity(serial, "com.android.chrome")
    say(f"[{phoneName(serial)}] no '{speedtestLabel}' icon on the home screen, opening {speedtestUrl} in Chrome")
    adbShell(serial, f"am start -a android.intent.action.VIEW -d {speedtestUrl} -p com.android.chrome")
    return waitForActivity(serial, "com.android.chrome")


def wakeAndUnlock(serial):
    """Turns the screen on and dismisses a swipe lock screen. A PIN / pattern can't be skipped over adb."""
    adbShell(serial, "input keyevent KEYCODE_WAKEUP")
    if "isKeyguardShowing=true" not in adbShell(serial, "dumpsys window | grep -m1 isKeyguardShowing"):
        return
    adbShell(serial, "wm dismiss-keyguard")
    for _ in range(6):
        time.sleep(0.5)
        if "isKeyguardShowing=true" not in adbShell(serial, "dumpsys window | grep -m1 isKeyguardShowing"):
            say(f"[{phoneName(serial)}] unlocked the screen")
            return
    raise RuntimeError(f"{phoneName(serial)} is locked with a PIN or pattern - unlock it on the phone (or in Vysor) first.")


def openServiceMode(serial):
    """Opens the phone app and types *#0011#, which opens Service Mode."""
    adbShell(serial, "am start -a android.intent.action.DIAL")
    dialerTask = waitForActivity(serial, "dialer")
    time.sleep(1)
    adbShell(serial, f"input text '{serviceModeCode}'")
    taskId = waitForActivity(serial, "ServiceMode")
    # The Phone app has done its job: close it and take it out of the recent apps.
    adbShell(serial, f"am stack remove {dialerTask}; am force-stop com.samsung.android.dialer")
    return taskId


def serviceModeSplit(serial):
    """Service Mode on top, Speedtest below. If both are already on screen, nothing is reopened:
    only the split size, SIM page and Speedtest popup are checked."""
    name = phoneName(serial)
    wakeAndUnlock(serial)
    onScreen =[component for component, _ in resumedActivities(serial)]
    if any("ServiceMode" in c for c in onScreen) and any("chrome" in c for c in onScreen):
        say(f"[{name}] Service Mode and Speedtest already open, adjusting only")
        resizeSplit(serial)
        openActiveSim(serial, waitSeconds=0)  # only if Service Mode is on its main menu
        closeSpeedtestPopup(serial, waitSeconds=0)
        say(f"[{name}] ready: Service Mode on top ({round(splitRatio * 100)}%), Speedtest below")
        return
    # Service Mode closes itself as soon as it leaves the screen, so otherwise it's set up from scratch.
    leaveSplitScreen(serial)
    say(f"[{name}] opening Speedtest")
    speedtestTask = openSpeedtest(serial)
    say(f"[{name}] opening Service Mode ({serviceModeCode})")
    openServiceMode(serial)
    time.sleep(1)
    splitScreen(serial, f"moveToSideStage {speedtestTask} 1")  # 1 = bottom half
    time.sleep(1.5)
    components = [component for component, _ in resumedActivities(serial)]
    if not (any("ServiceMode" in c for c in components) and any("chrome" in c for c in components)):
        say(f"[{name}] WARNING: split screen may not have opened (on screen: {', '.join(components)})")
        return
    resizeSplit(serial)
    openActiveSim(serial)
    closeSpeedtestPopup(serial)
    say(f"[{name}] ready: Service Mode on top ({round(splitRatio * 100)}%), Speedtest below")


# ---------- command line ----------

# The .bat files use these; the Live Testing page in the web app does the same from buttons.
actions = {"airplane": airplaneThenSpeedtest, "speedtest": startSpeedtest,
           "serviceMode": serviceModeSplit, "fullTest": fullTest}


def main(argv):
    if not argv or argv[0] not in actions:
        print(f"Usage: python -m kaam.phoneControl {{{'|'.join(actions)}}} [phone name ...]")
        return 2
    serials = pickPhones(argv[1:])
    if argv[0] == "fullTest":  # one phone at a time, so two speed tests never share the network
        fullTestOneByOne(serials)
        return 0
    errors = onEachPhone(actions[argv[0]], serials)
    return 1 if any(errors.values()) else 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except RuntimeError as error:
        print(error)
        sys.exit(1)
