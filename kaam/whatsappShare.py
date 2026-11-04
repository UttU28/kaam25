"""Share a ticket on WhatsApp Web: the renamed CSV with the report as its caption.

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
                       startTimeout=40, timeout=3 * 60):
    """A plain message (no file) to `group`: typed in its message box and sent. Every try first looks
    in the chat for our own message with this text, so it never goes out twice. Returns (summary, wasSent)."""
    attempts = 1 + retries
    for attempt in range(1, attempts + 1):
        def buildUrl(requestId, attempt=attempt):
            return f"http://127.0.0.1:{bridgePort}/whatsapp#" + urllib.parse.urlencode({
                "kaamId": requestId, "kaamGroup": group, "kaamCaption": "", "kaamText": text,
                "kaamSend": "1" if send else "0", "kaamAttempt": str(attempt), "kaamCheckFirst": "1",
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


def shareOnWhatsApp(wo, caption, csvPath=None, group=whatsappGroup, send=whatsappSend,
                    retries=whatsappRetries, openUrl=openInChrome, startTimeout=40, timeout=5 * 60,
                    checkFirst=False):
    """Returns (summary, wasSent). A retry (and checkFirst) first looks in the chat for this WO's
    file: if our earlier try did send it (but its "sent" never came back), it isn't sent twice."""
    try:
        csvFile = findRenamedCopy(wo, csvPath)
    except Exception as error:
        raise ChromeBridgeError(str(error))

    attempts = 1 + retries
    for attempt in range(1, attempts + 1):
        def buildUrl(requestId, attempt=attempt):
            registerFiles(requestId, [csvFile])
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
