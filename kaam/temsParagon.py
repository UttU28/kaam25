"""TEMS Paragon (http://localhost:8080) in your Chrome: Cloud tab, TEMS Cloud login, then the WO.

Uses your open TEMS tab (like WhatsApp) or opens one. When TEMS Cloud says "Please log in",
the extension clicks Log in; in the login popup Chrome fills your saved password and the
extension clicks Continue. With a WO it then opens the project (TEMS_PROJECT), finds the WO in
its list, opens it and checks the Reserve button; then on the Assign tab it opens the WO
(TEMS_ASSIGN_WO while testing) and checks its Open button. For now it clicks NEITHER.
"""

import urllib.parse

from .chromeBridge import ChromeBridgeError, bridgePort, openInChrome, runInChrome
from .config import temsAssignWo, temsProject, temsUrl  # from .env (TEMS_*), with defaults


def assignWoFor(wo, setting=temsAssignWo):
    """The WO to open on the Assign tab: the test WO from .env, or the reserved one ("same")."""
    return wo if setting.lower() == "same" else setting


def openTemsCloud(wo="", project=temsProject, url=temsUrl, openUrl=openInChrome, startTimeout=40, timeout=6 * 60):
    """Cloud: reserve check for `wo`; then Assign: open the assign WO and check Open (nothing clicked).
    Returns a one-line summary. Raises ChromeBridgeError when it can't get there."""
    def buildUrl(requestId):
        return f"http://127.0.0.1:{bridgePort}/tems#" + urllib.parse.urlencode({
            "kaamId": requestId, "kaamUrl": url, "kaamWo": wo or "", "kaamProject": project or "",
            "kaamAssignWo": assignWoFor(wo) if wo else "",
        })

    message = runInChrome(
        buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
        timeoutMessage="TEMS didn't finish. Check the TEMS tab and its login window.",
    )
    if not message.get("ok"):
        raise ChromeBridgeError(message.get("error") or "Couldn't open TEMS Cloud.")
    return message.get("summary") or "TEMS Cloud is ready."
