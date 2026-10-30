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


def shareOnWhatsApp(wo, caption, csvPath=None, group=whatsappGroup, send=whatsappSend,
                    retries=whatsappRetries, openUrl=openInChrome, startTimeout=40, timeout=8 * 60):
    """Returns (summary, wasSent)."""
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
