"""TEMS pictures: one per WO, all in one folder (kaam25/pictures).

A picture comes from Live Testing's Submit (a screenshot of TEMS's WO details) or is added by
hand on End Ticket (pick a file or drag it in). It is required for the WhatsApp share: the renamed
CSV, the report as its caption, and this picture go out in one message.

The WO's record keeps where it is (picturePath), when (pictureAt) and how it came (pictureSource),
so it can be found any time. A new picture for the same WO replaces the old one.
"""
import re
from pathlib import Path

from .config import appDir

picturesDir = Path(appDir) / "pictures"
allowed = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


class PictureError(Exception):
    pass


def fileStem(wo):
    """The WO name, safe as a file name (it already carries the WO number, e.g. ..._LM_234_...)."""
    return re.sub(r"[^\w.-]+", "_", (wo or "").strip()).strip("._") or "picture"


def kindOf(name="", data=b""):
    """png / jpg / webp from the file name, else from the first bytes."""
    ext = Path(name or "").suffix.lower().lstrip(".")
    if ext in allowed:
        return "jpg" if ext == "jpeg" else ext
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    raise PictureError("That isn't a picture (PNG, JPG or WEBP).")


def savePicture(wo, data, name="", source="added by hand"):
    """Saves the WO's picture (replacing any earlier one) and records where it is.
    Returns (path, replaced)."""
    from .workflows import cleanWorkOrder, safeSave
    from .ticketStore import getRecord, now
    wo = cleanWorkOrder(wo)
    if not wo:
        raise PictureError("Enter a WO first.")
    if not data:
        raise PictureError("The picture is empty.")
    if len(data) > 25 * 1024 * 1024:
        raise PictureError("The picture is over 25 MB.")
    kind = kindOf(name, data)
    picturesDir.mkdir(parents=True, exist_ok=True)
    path = picturesDir / f"{fileStem(wo)}.{kind}"
    record = getRecord(wo) or {}
    old = Path(record["picturePath"]) if record.get("picturePath") else None
    replaced = bool(old and old.is_file()) or path.is_file()
    path.write_bytes(data)
    if old and old != path and old.is_file() and old.parent == picturesDir:
        old.unlink()  # same WO, other file type: keep just the new one
    if record:
        safeSave(wo, event=f"TEMS picture {'replaced' if replaced else 'saved'} ({source}): {path}",
                 picturePath=str(path), pictureAt=now(), pictureSource=source)
    return path, replaced


def pictureOf(record):
    """The WO's picture file if it's still there, else None."""
    path = (record or {}).get("picturePath")
    if path and Path(path).is_file():
        return Path(path)
    # Saved before the WO was in Records (or the record lost it): look in the folder by name.
    for kind in ("png", "jpg", "webp"):
        guess = picturesDir / f"{fileStem((record or {}).get('wo', ''))}.{kind}"
        if (record or {}).get("wo") and guess.is_file():
            return guess
    return None


def pictureInfo(record):
    """What a page shows: {path, at, source, exists}."""
    path = pictureOf(record)
    return {"path": str(path) if path else (record or {}).get("picturePath") or "",
            "at": (record or {}).get("pictureAt") or "", "source": (record or {}).get("pictureSource") or "",
            "exists": bool(path)}
