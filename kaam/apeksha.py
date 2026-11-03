"""Send a WO's location to Apeksha (your codeShare site), to open on your phone: the preview
(WO / Grid Key / Location), then a Google Maps link on the next line.

    POST <APEKSHA_URL>/codeShare   {"content": "<preview>\\n<Google Maps link>"}
"""

import json
import urllib.error
import urllib.request

from .config import apekshaUrl  # from .env (optional, has a default)


class ApekshaError(Exception):
    pass


def mapsLink(lat, lon):
    """A Google Maps link that opens the pin at these coordinates."""
    return f"https://www.google.com/maps/search/?api=1&query={str(lat).strip()},{str(lon).strip()}"


def shareLocation(lat, lon, name=None, preview="", timeout=10):
    """Sends the preview (e.g. WO / Grid Key / Location lines), then the Maps link on its own line.
    Returns the site's reply, e.g. {"ok": true, "duplicate": false, ...}.
    Raises ApekshaError with a short, readable reason."""
    if not str(lat).strip() or not str(lon).strip():
        raise ApekshaError("No location saved for this WO.")
    text = "\n".join(part for part in (str(preview or "").strip(), mapsLink(lat, lon)) if part)
    body = {"content": text}
    if name:
        body["name"] = name
    request = urllib.request.Request(
        f"{apekshaUrl}/codeShare", data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "Kaam25"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            reply = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        try:
            reason = json.loads(error.read().decode("utf-8")).get("error")
        except Exception:
            reason = None
        raise ApekshaError(f"Apeksha said {error.code}: {reason or error.reason}")
    except urllib.error.URLError as error:
        raise ApekshaError(f"Couldn't reach Apeksha: {error.reason}")
    except (TimeoutError, OSError) as error:
        raise ApekshaError(f"Couldn't reach Apeksha: {error}")
    except ValueError:
        raise ApekshaError("Apeksha sent back something that isn't JSON.")
    if not reply.get("ok"):
        raise ApekshaError(reply.get("error") or "Apeksha didn't accept it.")
    return reply
