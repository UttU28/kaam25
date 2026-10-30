"""Send a WO's location to Apeksha (your codeShare site), which turns "lat long" into a
Google Maps link you can open on your phone.

    POST <APEKSHA_URL>/codeShare   {"content": "30.235641 -93.949268"}   (just the coordinates)
"""

import json
import urllib.error
import urllib.request

from .config import apekshaUrl  # from .env (optional, has a default)


class ApekshaError(Exception):
    pass


def shareLocation(lat, lon, name=None, timeout=10):
    """Returns the site's reply, e.g. {"ok": true, "duplicate": false, "mapsLink": true, ...}.
    Raises ApekshaError with a short, readable reason."""
    text = f"{str(lat).strip()} {str(lon).strip()}".strip()
    if not str(lat).strip() or not str(lon).strip():
        raise ApekshaError("No location saved for this WO.")
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
