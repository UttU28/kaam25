"""Every path and default value, read from the .env file next to this one.

If a setting is missing, the app stops with a message naming it, instead of
quietly using an old value.
"""

import os
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

appDir = Path(__file__).resolve().parent.parent  # the project folder (where .env is)
envPath = appDir / ".env"
load_dotenv(envPath, override=True)


class ConfigError(Exception):
    pass


def getSetting(name):
    value = os.environ.get(name)
    if value is None or not value.strip():
        raise ConfigError(f"{name} is missing from {envPath}. Add it and restart the app.")
    return value


def getPath(name):
    """Expands %NAME% parts; relative paths are inside the app folder."""
    path = Path(os.path.expandvars(getSetting(name).strip()))
    return path if path.is_absolute() else appDir / path


def getList(name, separator=","):
    return [item.strip() for item in getSetting(name).split(separator) if item.strip()]


def getInt(name):
    try:
        return int(getSetting(name))
    except ValueError:
        raise ConfigError(f"{name} in {envPath} must be a number.")


def getBool(name):
    return getSetting(name).strip().lower() in ("1", "true", "yes", "on")


# ---------- web pages ----------
ticketsUrl = getSetting("TICKETS_URL").strip()
actixUploadUrl = getSetting("ACTIX_UPLOAD_URL").strip()
# TEMS Paragon on this computer. The extension may only work on http://localhost:8080 (manifest.json).
temsUrl = (os.environ.get("TEMS_URL") or "http://localhost:8080/").strip()
# The TEMS Cloud project whose list holds the WOs to reserve (changes with the month).
temsProject = (os.environ.get("TEMS_PROJECT") or "SR_Y6_Oct_26_LM_Nokia").strip()
# Testing: the WO opened on TEMS's Assign tab (until reserving is live it can't be the reserved one).
# Set TEMS_ASSIGN_WO=same in .env to use the WO you reserve.
temsAssignWo = (os.environ.get("TEMS_ASSIGN_WO") or "SO-LM-HN-02-9_G23d_2U_102326_NOKIA").strip()

# ---------- you ----------
employeeId = getSetting("EMPLOYEE_ID").strip()
microsoftAccount = getSetting("MICROSOFT_ACCOUNT").strip()
actixExtraEmail = getSetting("ACTIX_EXTRA_EMAIL").strip()

# ---------- Start Ticket defaults ----------
defaultRegion = getSetting("DEFAULT_REGION").strip()
defaultMarket = getSetting("DEFAULT_MARKET").strip()
defaultLogsUploadedPreviousDay = getSetting("DEFAULT_LOGS_UPLOADED_PREVIOUS_DAY").strip()
try:
    driveShiftPmFrom = datetime.strptime(getSetting("DRIVE_SHIFT_PM_FROM").strip(), "%H:%M").time()
except ValueError:
    raise ConfigError(f"DRIVE_SHIFT_PM_FROM in {envPath} must look like 14:00.")
defaultSubmit = getBool("DEFAULT_SUBMIT")

# ---------- End Ticket report defaults ----------
defaultTotalGrids = getSetting("DEFAULT_TOTAL_GRIDS").strip()
defaultAttempted = getSetting("DEFAULT_ATTEMPTED").strip()
defaultSkipped = getSetting("DEFAULT_SKIPPED").strip()
defaultStatus = getSetting("DEFAULT_STATUS").strip().upper()
folderNamePrefix = getSetting("FOLDER_NAME_PREFIX")  # not stripped: keeps its trailing space

# ---------- drive log files ----------
logRootDir = getPath("LOG_ROOT_DIR")
equipments = getList("EQUIPMENTS")

# ---------- GridSummary copy ----------
workOrderOutputDir = getPath("WORK_ORDER_OUTPUT_DIR")
gridSummaryFile = getSetting("GRID_SUMMARY_FILE").strip()

# ---------- ActixOne upload ----------
actixSubmit = getBool("ACTIX_SUBMIT")

# ---------- local ticket records ----------
ticketStoreFile = getPath("TICKET_STORE_FILE")

# ---------- WhatsApp sharing ----------
whatsappGroup = getSetting("WHATSAPP_GROUP").strip()
whatsappSend = getBool("WHATSAPP_SEND")
whatsappRetries = max(0, getInt("WHATSAPP_RETRIES"))

# ---------- Apeksha (share a location to your site) ----------
# Optional in .env; defaults to your site.
apekshaUrl = (os.environ.get("APEKSHA_URL") or "https://apekshaapi.thatinsaneguy.com").strip().rstrip("/")

# ---------- tabs ----------
closeTabsWhenDone = getBool("CLOSE_TABS_WHEN_DONE")

# ---------- Chrome ----------
chromePaths = [os.path.expandvars(path) for path in getList("CHROME_PATHS", ";")]
chromeUserDataDir = getPath("CHROME_USER_DATA_DIR")

# ---------- app <-> extension ----------
bridgePort = getInt("BRIDGE_PORT")
debugLogPath = getPath("DEBUG_LOG_FILE")
