"""TEMS Paragon (http://localhost:8080) in your Chrome: Cloud tab and TEMS Cloud login, then one of

  find - before a ticket is made: is the WO in the Cloud project's list, or already on Assign?
  go   - prod, after the ticket: Reserve it in Cloud (if it's there), then Open it on Assign.
  test - TEMS test mode: find Reserve for cloudWo and Open for assignWo, click nothing.
  play - Live Testing's Start Stationary: the Control page, press its play button (only when TEMS says
         the WO is Validated / Paused - never while it runs, that would pause it), "I understand".

Uses your open TEMS tab (like WhatsApp), reloads it once if TEMS isn't showing, else opens a new one.
"""

import urllib.parse

from .chromeBridge import ChromeBridgeError, bridgePort, openInChrome, runInChrome
from .config import temsProject, temsUrl  # from .env (TEMS_*), with defaults

actions = ("find", "go", "test", "play", "openWo", "suspend", "discard", "submit", "listWos")
# openWo  - Start Stationary when the WO isn't open: Assign -> the WO -> Open.
# suspend / discard - on TEMS's finished-test page: Suspend (OK the "summary created") / Discard (Yes).
# submit  - for now: Chrome full window, Suspend, the WO's details on Assign scrolled to the bottom,
#           a picture of the page (returned as "screenshot"), Open it again, Cancel the stationary test.
# listWos - the plan check: every WO name in the Cloud project and on Assign ("cloudNames", "assignNames").


def runTems(action, wo="", cloudWo="", assignWo="", project=temsProject, url=temsUrl,
            openUrl=openInChrome, startTimeout=40, timeout=8 * 60, canPlay=False):
    """Returns the extension's result: {"ok", "summary" / "error", "found", "notFound", ...}.
    Raises ChromeBridgeError only when Chrome / the extension / TEMS can't be reached."""
    if action not in actions:
        raise ValueError(f"Unknown TEMS action {action}")

    def buildUrl(requestId):
        return f"http://127.0.0.1:{bridgePort}/tems#" + urllib.parse.urlencode({
            "kaamId": requestId, "kaamUrl": url, "kaamAction": action, "kaamWo": wo or "",
            "kaamProject": project or "", "kaamCloudWo": cloudWo or "", "kaamAssignWo": assignWo or "",
            "kaamCanPlay": "1" if canPlay else "0",
        })

    message = runInChrome(
        buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
        timeoutMessage="TEMS didn't finish. Check the TEMS tab and its login window.",
    )
    keys = ("ok", "summary", "error", "found", "notFound", "reserved", "opened", "mapShown", "suggestions", "matchedWo",
            "played", "controlShown", "screenshot", "cloudNames", "assignNames")
    result = {key: message.get(key) for key in keys if key in message}
    if not result.get("ok") and not result.get("error"):
        result["error"] = "TEMS didn't say what happened. Check the TEMS tab."
    return result
