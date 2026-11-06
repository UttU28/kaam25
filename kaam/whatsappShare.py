"""Share a ticket on WhatsApp Web: the renamed CSV (report as its caption), then the TEMS picture as
a photo.

Uses your open WhatsApp Web tab (e.g. a pinned one) if there is one, else opens one.
With WHATSAPP_SEND=false it stops before Send so you press it yourself.
A failed share is tried again WHATSAPP_RETRIES more times, unless retrying can't help or
could send twice.
"""

import time
import urllib.parse

from .chromeBridge import ChromeBridgeError, bridgePort, openInChrome, registerFiles, runInChrome
from .config import whatsappGroup, whatsappRetries, whatsappSend  # from .env
from .gridSummary import findRenamedCopy

retryPauseSeconds = 5
# Failures where another try can't help, or could send the message twice.
notRetryable = ("logged out", "pressed send", "is busy. is another copy", "renamed csv", "stopped by you")


def isRetryable(error):
    return not any(marker in error.lower() for marker in notRetryable)


def sendTextOnWhatsApp(text, group, send=whatsappSend, retries=whatsappRetries, openUrl=openInChrome,
                       startTimeout=40, timeout=3 * 60, checkFirst=True):
    """A plain message (no file) to `group` (a group or a person): typed in its message box and sent.
    checkFirst: the first try looks in the chat for our own message with this text and doesn't send
    it again (a retry always looks). Returns (summary, wasSent)."""
    attempts = 1 + retries
    for attempt in range(1, attempts + 1):
        def buildUrl(requestId, attempt=attempt):
            return f"http://127.0.0.1:{bridgePort}/whatsapp#" + urllib.parse.urlencode({
                "kaamId": requestId, "kaamGroup": group, "kaamCaption": "", "kaamText": text,
                "kaamSend": "1" if send else "0", "kaamAttempt": str(attempt),
                "kaamCheckFirst": "1" if checkFirst else "0",
            })
        try:
            message = runInChrome(buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
                                  timeoutMessage="WhatsApp didn't finish in time. Check the WhatsApp tab.")
            if message.get("ok"):
                return message.get("summary") or "Sent on WhatsApp.", bool(message.get("sent"))
            error = message.get("error") or "Couldn't send on WhatsApp."
        except ChromeBridgeError as bridgeError:
            error = str(bridgeError)
        if attempt == attempts or not isRetryable(error) or "unsent draft" in error:
            raise ChromeBridgeError(error + (f" (gave up after {attempt} tries)" if attempt > 1 else ""))
        time.sleep(retryPauseSeconds)


def shareManyOnWhatsApp(items, group=whatsappGroup, retries=whatsappRetries, openUrl=openInChrome,
                        startTimeout=40, onResult=None, checkFirst=True):
    """End Tickets: several WOs in one WhatsApp run - the chat is opened once, then each WO's CSV
    (report as caption) and TEMS picture go out back to back, and Send is pressed. A WO whose CSV is
    already in the chat isn't sent again. items: [{wo, caption, csvPath, picturePath}].
    onResult(result) is called as each WO finishes ({wo, ok, sent, summary / error, seconds}).
    Returns {wo: result} for every item. A failed run is tried again for the WOs that didn't go.
    checkFirst=False (a test to another group only): the first try sends even what's in the chat."""
    results, prepared = {}, []

    def note(result):
        if result.get("wo") and result["wo"] not in results:
            results[result["wo"]] = result
            if onResult:
                onResult(result)

    for item in items:
        try:
            prepared.append({**item, "csvFile": findRenamedCopy(item["wo"], item.get("csvPath"))})
        except Exception as error:
            note({"wo": item["wo"], "ok": False, "sent": False, "error": str(error)})

    attempts = 1 + retries
    for attempt in range(1, attempts + 1):
        # Not tried yet, or failed before anything went out (a WO whose CSV went is never resent).
        remaining = [p for p in prepared if p["wo"] not in results]
        if not remaining:
            break

        def buildUrl(requestId, remaining=remaining, attempt=attempt):
            paths, batch = [], []
            for p in remaining:
                files = [p["csvFile"]] + ([p["picturePath"]] if p.get("picturePath") else [])
                batch.append({"wo": p["wo"], "caption": p["caption"], "checkFirst": checkFirst or attempt > 1,
                              "files": list(range(len(paths), len(paths) + len(files)))})
                paths += files
            registerFiles(requestId, paths, batch)
            return f"http://127.0.0.1:{bridgePort}/whatsapp#" + urllib.parse.urlencode({
                "kaamId": requestId, "kaamGroup": group, "kaamCaption": "", "kaamSend": "1",
                "kaamAttempt": str(attempt), "kaamBatch": "1",
            })

        def onProgress(message):
            for result in message.get("items") or []:
                note(result)

        error = ""
        try:
            message = runInChrome(buildUrl, openUrl=openUrl, startTimeout=startTimeout,
                                  timeout=90 + 90 * len(remaining), onProgress=onProgress,
                                  timeoutMessage="WhatsApp didn't finish in time. Check the WhatsApp tab.")
            onProgress(message)
            error = message.get("error") or ""
        except ChromeBridgeError as bridgeError:
            error = str(bridgeError)
        # Failed before going out: may try again (dropped so the next try picks them up).
        retryable = [wo for wo, r in results.items() if not r.get("ok") and not r.get("sent")
                     and isRetryable(r.get("error") or "") and "stopped" not in (r.get("error") or "").lower()]
        stop = (error and not isRetryable(error)) or attempt == attempts
        if stop:
            for p in remaining:
                if p["wo"] not in results:
                    note({"wo": p["wo"], "ok": False, "sent": False, "error": error or "WhatsApp didn't get to it."})
            break
        for wo in retryable:
            results.pop(wo, None)
        if not [p for p in prepared if p["wo"] not in results]:
            break
        time.sleep(retryPauseSeconds)
    return results


def shareOnWhatsApp(wo, caption, csvPath=None, group=whatsappGroup, send=whatsappSend,
                    retries=whatsappRetries, openUrl=openInChrome, startTimeout=40, timeout=5 * 60,
                    checkFirst=False, picturePath=None):
    """Returns (summary, wasSent). picturePath: the TEMS picture, sent as a photo right after the CSV.
    A retry (and checkFirst) first looks in the chat for this WO's file: if our earlier try did send
    it (but its "sent" never came back), it isn't sent twice."""
    try:
        csvFile = findRenamedCopy(wo, csvPath)
    except Exception as error:
        raise ChromeBridgeError(str(error))

    attempts = 1 + retries
    for attempt in range(1, attempts + 1):
        def buildUrl(requestId, attempt=attempt):
            registerFiles(requestId, [csvFile] + ([picturePath] if picturePath else []))
            return f"http://127.0.0.1:{bridgePort}/whatsapp#" + urllib.parse.urlencode({
                "kaamId": requestId, "kaamGroup": group, "kaamCaption": caption,
                "kaamSend": "1" if send else "0", "kaamAttempt": str(attempt),
                "kaamCheckFirst": "1" if checkFirst else "0",
            })

        try:
            message = runInChrome(
                buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
                timeoutMessage="WhatsApp didn't finish in time. Check the WhatsApp tab.",
            )
            if message.get("ok"):
                summary = message.get("summary") or "Shared on WhatsApp."
                if attempt > 1:
                    summary += f" (worked on try {attempt} of {attempts})"
                return summary, bool(message.get("sent"))
            error = message.get("error") or "Couldn't share on WhatsApp."
        except ChromeBridgeError as bridgeError:
            error = str(bridgeError)

        if attempt == attempts or not isRetryable(error):
            raise ChromeBridgeError(error + (f" (gave up after {attempt} tries)" if attempt > 1 else ""))
        time.sleep(retryPauseSeconds)
