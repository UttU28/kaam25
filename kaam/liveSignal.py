"""Live signal from the test phones, for the Live Testing page.

While a Live Testing page is open (it asks every ~0.7 s), two background loops per phone keep
reading what the phone is latched to (NR / LTE / no service, band, PCI, RSRP, SINR):
  - Android's own reading (dumpsys, ~0.2 s): never blocked, so it keeps going during a speed test
  - Service Mode's screen (uiautomator, ~2 s): has the PCI, but the screen read waits for the
    phone to be still, so it stalls while Speedtest's gauge is moving
The newest Service Mode reading wins while it's fresh; otherwise Android's reading is shown,
with the PCI (and anything else Android lacks) taken from the last Service Mode reading on the
same network. The loops stop by themselves when no page has asked for a while.
"""
import threading
import time

from . import phoneControl

watchSeconds = 20     # keep reading this long after a page last asked
androidPause = 0.3    # between Android readings
screenPause = 0.1     # between Service Mode screen reads
screenFresh = 4       # a Service Mode reading this new is shown as it is
fillFresh = 30        # PCI etc. from Service Mode are borrowed this long (same tech and band)

latest = {}   # serial -> merged network dict + "at" (epoch seconds)
android = {}  # serial -> last Android reading + "at"
screen = {}   # serial -> last Service Mode reading + "at"
asked = {}    # serial -> when a page last asked
loops = {}    # (serial, kind) -> thread
lock = threading.Lock()


def watching(serial):
    return time.time() - asked.get(serial, 0) < watchSeconds


def merge(serial):
    """The reading to show: fresh Service Mode, else Android filled in from recent Service Mode."""
    now = time.time()
    sm, an = screen.get(serial), android.get(serial)
    if sm and now - sm["at"] < screenFresh:
        merged = {**sm, "live": "serviceMode"}
        if an and now - an["at"] < screenFresh and an.get("bars") is not None:
            merged["bars"] = an["bars"]  # Service Mode has no bars: the status bar's, from Android
        if an and now - an["at"] < screenFresh and an.get("tech") == sm.get("tech"):
            for key in ("bw", "band"):  # Service Mode's NR page has no bandwidth: Android's
                if not merged.get(key) and an.get(key):
                    merged[key] = an[key]
        return merged
    if not an:
        return sm
    merged = dict(an)
    if sm and now - sm["at"] < fillFresh and sm.get("tech") == an.get("tech") and \
            (not an.get("band") or sm.get("band") == an.get("band")):
        for key in ("band", "bw", "pci", "rsrp", "sinr"):
            if not merged.get(key) and sm.get(key):
                merged[key] = sm[key]
    merged["live"] = "android"
    return merged


def publish(serial):
    found = merge(serial)
    if found:
        latest[serial] = found


def androidLoop(serial):
    while watching(serial):
        try:
            found = phoneControl.networkFromAndroid(serial)
        except Exception as error:
            found = {**phoneControl.network("Unknown"), "error": str(error)}
        android[serial] = {**found, "at": time.time()}
        publish(serial)
        time.sleep(androidPause)


def screenLoop(serial):
    while watching(serial):
        try:
            if any("ServiceMode" in c for c, _ in phoneControl.resumedActivities(serial)):
                found = phoneControl.parseServiceMode(phoneControl.serviceModeLines(serial, tries=1))
                if found:
                    screen[serial] = {**found, "at": time.time()}
                    publish(serial)
                time.sleep(screenPause)
            else:
                time.sleep(1)  # Service Mode isn't open: Android's reading is all there is
        except Exception:
            time.sleep(1)


def run(serial, kind, target):
    try:
        target(serial)
    finally:
        with lock:
            if loops.get((serial, kind)) is threading.current_thread():
                loops.pop((serial, kind), None)


def signals(serials):
    """Latest reading per serial (None until the first one); starts the loops a phone is missing."""
    now = time.time()
    with lock:
        for serial in serials:
            asked[serial] = now
            for kind, target in (("android", androidLoop), ("screen", screenLoop)):
                if (serial, kind) not in loops:
                    thread = threading.Thread(target=run, args=(serial, kind, target), daemon=True,
                                              name=f"signal {kind} {serial}")
                    loops[(serial, kind)] = thread
                    thread.start()
    return {serial: latest.get(serial) for serial in serials}
