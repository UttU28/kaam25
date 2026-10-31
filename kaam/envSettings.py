"""Read, check and save .env from the Settings page.

Only the lines of settings you changed are rewritten; comments, order and anything else in
.env stay as they are. A copy of the old .env goes to backups/ first. The app reads .env once
at start, so the web app restarts itself after a save.
"""

import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

from dotenv import dotenv_values

from .config import apekshaUrl, appDir, envPath, temsProject, temsUrl

# (key, group, label, type, help, extra). type: text url email bool int time choice dir path list readonly
# extra: optional=True (may be empty: the app uses its default), keepSpaces=True, options=[...], min/max.
fields = [
    # ---------- You ----------
    ("EMPLOYEE_ID", "You", "Employee / team ID", "text", "Only your team's rows are imported from the day's plan, e.g. N071.", {}),
    ("MICROSOFT_ACCOUNT", "You", "Microsoft account", "email", "Picked on Microsoft's \"Pick an account\" page when signing in to ActixOne.", {}),
    ("ACTIX_EXTRA_EMAIL", "You", "Extra email on ActixOne uploads", "email", "Added on the ActixOne upload page.", {}),
    # ---------- Start Ticket ----------
    ("DEFAULT_REGION", "Start Ticket", "Region", "text", "Region on the Create Ticket form.", {}),
    ("DEFAULT_MARKET", "Start Ticket", "Market", "text", "Market on the Create Ticket form.", {}),
    ("DEFAULT_LOGS_UPLOADED_PREVIOUS_DAY", "Start Ticket", "Logs uploaded from previous day", "choice", "Dropdown on the Create Ticket form.", {"options": ["Yes", "No"]}),
    ("DRIVE_SHIFT_PM_FROM", "Start Ticket", "PM shift from", "time", "Drive Shift is PM from this time (24h), AM before it.", {}),
    ("DEFAULT_SUBMIT", "Start Ticket", "Click Create", "bool", "On: clicks Create and finds the new Ticket ID. Off: only fills the form.", {}),
    # ---------- End Ticket report ----------
    ("DEFAULT_TOTAL_GRIDS", "End Ticket report", "Total grids", "int", "", {"min": 0, "max": 999}),
    ("DEFAULT_ATTEMPTED", "End Ticket report", "Grids attempted", "choice", "", {"options": ["0", "1"]}),
    ("DEFAULT_SKIPPED", "End Ticket report", "Grids skipped", "choice", "", {"options": ["0", "1"]}),
    ("DEFAULT_STATUS", "End Ticket report", "Status", "choice", "", {"options": ["PASSED", "SKIPPED", "FAILED"]}),
    ("FOLDER_NAME_PREFIX", "End Ticket report", "Folder name prefix", "text", "Folder name: <MMDDYYYY>_<ID>_<prefix><WO>. Spaces are kept.", {"keepSpaces": True}),
    # ---------- Files ----------
    ("LOG_ROOT_DIR", "Files", "Drive logs folder", "dir", "Logs come from <folder>\\<EQ>\\Cloud WO - <WO>\\<newest run>.", {}),
    ("EQUIPMENTS", "Files", "Equipments", "list", "Comma-separated, uploaded in this order, e.g. EQ3,EQ6.", {}),
    ("WORK_ORDER_OUTPUT_DIR", "Files", "Work order output folder", "dir", "TEMS WorkOrderOutput folder that holds GridSummary.csv.", {}),
    ("GRID_SUMMARY_FILE", "Files", "GridSummary file name", "text", "", {}),
    ("TICKET_STORE_FILE", "Files", "Records file", "path", "Where all records are saved. Relative = inside the app folder.", {}),
    ("DEBUG_LOG_FILE", "Files", "Debug log", "path", "Relative = inside the app folder.", {}),
    # ---------- Automation ----------
    ("ACTIX_SUBMIT", "Automation", "ActixOne: click Submit", "bool", "On: submits and saves the Job ID. Off: stops before Submit.", {}),
    ("CLOSE_TABS_WHEN_DONE", "Automation", "Close tabs when done", "bool", "Close a tab the app opened once its job fully finished.", {}),
    # ---------- TEMS ----------
    ("TEMS_PROJECT", "TEMS", "TEMS Cloud project", "text", "Project that lists the WOs to reserve (changes each month).", {"optional": True, "default": temsProject}),
    ("TEMS_URL", "TEMS", "TEMS Paragon address", "url", "The extension only works on http://localhost:8080/.", {"optional": True, "default": temsUrl}),
    # ---------- WhatsApp ----------
    ("WHATSAPP_GROUP", "WhatsApp", "Group name", "text", "Chat name exactly as it shows in WhatsApp.", {}),
    ("WHATSAPP_SEND", "WhatsApp", "Press Send", "bool", "On: presses Send in WhatsApp. Off: fills the message, you press Send. End's Send switch starts here (saving this resets it).", {}),
    ("WHATSAPP_AUTO_SHARE", "WhatsApp", "Share by itself after End", "bool",
     "On: once Find in Chrome / Upload has the Ticket ID, both EQ Job IDs and the renamed GridSummary, End shares on WhatsApp by itself. Off: you press WhatsApp.",
     {"optional": True, "default": "true"}),
    ("WHATSAPP_RETRIES", "WhatsApp", "Retries", "int", "Extra tries when a share fails (5 s apart).", {"min": 0, "max": 10}),
    # ---------- Web pages ----------
    ("TICKETS_URL", "Web pages", "TechInsights tickets page", "url", "", {}),
    ("ACTIX_UPLOAD_URL", "Web pages", "ActixOne upload page", "url", "", {}),
    ("APEKSHA_URL", "Web pages", "Apeksha site", "url", "Where Send location posts coordinates.", {"optional": True, "default": apekshaUrl}),
    # ---------- Chrome ----------
    ("CHROME_PATHS", "Chrome", "chrome.exe paths", "text", "First one that exists is used. Separate with ;", {}),
    ("CHROME_USER_DATA_DIR", "Chrome", "Chrome user data folder", "dir", "Used to find your last-used Chrome profile.", {}),
    ("BRIDGE_PORT", "Chrome", "Extension port", "readonly", "Also set in the Chrome extension, so change it only in .env and the extension together.", {}),
]
fieldsByKey = {f[0]: f for f in fields}


class SettingsError(Exception):
    pass


def expandPath(value):
    path = Path(os.path.expandvars(value.strip()))
    return path if path.is_absolute() else appDir / path


def currentValues():
    saved = dotenv_values(envPath) if envPath.exists() else {}
    return {key: (saved.get(key) or "") for key in fieldsByKey}


def describe():
    """Fields with their current values, for the Settings page."""
    values = currentValues()
    return [{"key": key, "group": group, "label": label, "type": kind, "help": help, "value": values[key], **extra}
            for key, group, label, kind, help, extra in fields]


def check(key, value):
    """(clean value, error or None, warning or None)."""
    _, _, label, kind, _, extra = fieldsByKey[key]
    value = value if extra.get("keepSpaces") else str(value).strip()
    if not value.strip():
        return value, None if extra.get("optional") or kind == "readonly" else f"{label} can't be empty.", None
    if kind == "url" and not re.match(r"^https?://\S+$", value):
        return value, f"{label} must start with http:// or https://", None
    if kind == "email" and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", value):
        return value, f"{label} isn't an email address.", None
    if kind == "bool":
        if value.lower() not in ("true", "false"):
            return value, f"{label} must be true or false.", None
        return value.lower(), None, None
    if kind == "int":
        if not re.fullmatch(r"\d+", value) or not extra.get("min", 0) <= int(value) <= extra.get("max", 10 ** 6):
            return value, f"{label} must be a whole number from {extra.get('min', 0)} to {extra.get('max', 10 ** 6)}.", None
    if kind == "time":
        try:
            value = datetime.strptime(value, "%H:%M").strftime("%H:%M")
        except ValueError:
            return value, f"{label} must look like 14:00.", None
    if kind == "choice" and value not in extra["options"]:
        upper = value.upper()
        if upper in extra["options"]:
            value = upper
        else:
            return value, f"{label} must be one of {', '.join(extra['options'])}.", None
    if kind == "list":
        items = [item.strip() for item in value.split(",") if item.strip()]
        if not items:
            return value, f"{label} needs at least one item.", None
        value = ",".join(items)
    if kind == "dir" and not expandPath(value).is_dir():
        return value, None, f"{label}: folder not found ({expandPath(value)}) - saved anyway."
    return value, None, None


def formatValue(value):
    """How a value is written in .env: quoted only when it has to be (spaces at the ends, #, quotes)."""
    if value != value.strip() or "#" in value or '"' in value or "'" in value:
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def save(changes):
    """changes: {KEY: new value}. Checks everything first; writes nothing if anything is wrong.
    Returns {"changed": [keys], "warnings": [...]}."""
    old = currentValues()
    clean, errors, warnings = {}, [], []
    for key, value in (changes or {}).items():
        if key not in fieldsByKey:
            errors.append(f"Unknown setting {key}.")
            continue
        if fieldsByKey[key][3] == "readonly":
            continue
        value, error, warning = check(key, "" if value is None else str(value))
        if error:
            errors.append(error)
        elif value != old.get(key, ""):
            clean[key] = value
            if warning:
                warnings.append(warning)
    if errors:
        raise SettingsError(" ".join(errors))
    if not clean:
        return {"changed": [], "warnings": warnings}

    text = envPath.read_text(encoding="utf-8") if envPath.exists() else ""
    if envPath.exists():
        backups = appDir / "backups"
        backups.mkdir(exist_ok=True)
        shutil.copy2(envPath, backups / f"env.backup-{datetime.now():%Y%m%d%H%M%S}.env")
    lines = text.splitlines()
    pending = dict(clean)
    for n, line in enumerate(lines):
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if match and match.group(1) in pending:
            key = match.group(1)
            lines[n] = f"{key}={formatValue(pending.pop(key))}"
    if pending:  # settings not in .env yet (e.g. the optional TEMS ones)
        lines += ["", "# ---------- Added from the Settings page ----------"]
        lines += [f"{key}={formatValue(value)}" for key, value in pending.items()]
    envPath.write_text("\n".join(lines) + "\n", encoding="utf-8")
    stamp = datetime.now().isoformat(timespec="seconds")
    changes = [{"at": stamp, "key": key, "label": fieldsByKey[key][2], "old": old.get(key, ""), "new": value}
               for key, value in clean.items()]
    logChanges(changes)
    return {"changed": list(clean), "changes": changes, "warnings": warnings}


# ---------- change history (backups/settingsChanges.json, newest first, kept out of git) ----------
maxHistory = 300


def historyFile():
    return appDir / "backups" / "settingsChanges.json"


def readHistory(limit=100):
    try:
        return json.loads(historyFile().read_text(encoding="utf-8"))[:limit]
    except (OSError, ValueError):
        return []


def logChanges(changes):
    history = changes[::-1] + readHistory(maxHistory)
    historyFile().parent.mkdir(exist_ok=True)
    historyFile().write_text(json.dumps(history[:maxHistory], indent=2, ensure_ascii=False), encoding="utf-8")
