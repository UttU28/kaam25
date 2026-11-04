"""Duplicate a WO's GridSummary.csv under the name the app's folder-name line shows.

WorkOrderOutput folder names have no spaces and are often cut short, e.g.
  WO:     SO-LM-HN-02-4_G23d_2U_102326_NOKIA
  folder: CloudWO-SO-LM-HN-02-4_G23d_2U_102326_NOK
A folder matches when (spaces removed, case ignored) it is the start of the WO or the
WO is the start of it, and it includes the WO's date (102326), so a cut-off name can't
match a different day.
"""

import os
import re
import time
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from .config import employeeId, folderNamePrefix, gridSummaryFile, workOrderOutputDir  # from .env
from .logFiles import findLatestRunFolder

cloudWoPrefix = re.compile(r"^cloudwo-?")
datePattern = re.compile(r"_(\d{6})_")


class GridSummaryError(Exception):
    pass


def buildFolderName(wo, today=None):
    """e.g. 10272026_N071_Cloud WO - SO-LM-HN-02-2_G23d_2U_102126_NOKIA"""
    today = today or datetime.now()
    return f"{today.strftime('%m%d%Y')}_{employeeId}_{folderNamePrefix}{wo}"


def squash(text):
    """Lowercase, no spaces, no leading 'Cloud WO -'."""
    return cloudWoPrefix.sub("", re.sub(r"\s+", "", text).lower())


def findWorkOrderFolder(wo, baseDir=workOrderOutputDir):
    if not baseDir.is_dir():
        raise GridSummaryError(f"Folder not found: {baseDir}")
    target = squash(wo)
    dateMatch = datePattern.search(target)

    candidates = []
    for folder in baseDir.iterdir():
        if not folder.is_dir():
            continue
        name = squash(folder.name)
        if not name or not (target.startswith(name) or name.startswith(target)):
            continue
        if dateMatch and dateMatch.group(1) not in name:
            continue
        # Prefer the longest (least cut-off) name, then the newest folder.
        candidates.append((len(name), folder.stat().st_mtime, str(folder), folder))
    if not candidates:
        raise GridSummaryError(f"No folder for {wo} in {baseDir}")
    return max(candidates)[3]


readyCache = {}  # wo -> (checkedAt, ready)


def resultReady(wo, cacheSeconds=5):
    """True once TEMS has written this WO's result - GridSummary.csv in its newest run folder, or
    our renamed copy of it. Until then the WO is still being driven (Live Testing), not ready to End."""
    hit = readyCache.get(wo)
    if hit and time.time() - hit[0] < cacheSeconds:
        return hit[1]
    try:
        runFolder = findLatestRunFolder(findWorkOrderFolder(wo))
        ready = (runFolder / gridSummaryFile).is_file() or             any(runFolder.glob(f"*_{employeeId}_{folderNamePrefix}{wo}.csv"))
    except Exception:
        ready = False
    readyCache[wo] = (time.time(), ready)
    return ready


def copyGridSummary(wo):
    """Copy GridSummary.csv in the newest numbered folder. Returns (path, wasAlreadyThere)."""
    runFolder = findLatestRunFolder(findWorkOrderFolder(wo))
    source = runFolder / gridSummaryFile
    target = runFolder / f"{buildFolderName(wo)}.csv"
    if not source.is_file():
        if target.is_file():
            return target, True  # done before (e.g. renamed by hand)
        raise GridSummaryError(f"No {gridSummaryFile} in {runFolder}")
    shutil.copy2(source, target)
    return target, False


def findRenamedCopy(wo, knownPath=None):
    """The renamed CSV for this WO: the known path if it still exists, else the newest
    <date>_<employee>_Cloud WO - <WO>.csv in the WO's newest folder (any date)."""
    if knownPath and Path(knownPath).is_file():
        return Path(knownPath)
    runFolder = findLatestRunFolder(findWorkOrderFolder(wo))
    copies = sorted(runFolder.glob(f"*_{employeeId}_{folderNamePrefix}{wo}.csv"), key=lambda path: path.stat().st_mtime)
    if not copies:
        raise GridSummaryError(f"No renamed CSV in {runFolder} yet. Run End Ticket first.")
    return copies[-1]


def showInExplorer(wo, knownPath=None):
    """Open Explorer with the renamed CSV selected. Falls back to the WO's newest
    folder if the copy isn't there yet. Returns what was opened."""
    target = Path(knownPath) if knownPath else None
    if not (target and target.is_file()):
        runFolder = findLatestRunFolder(findWorkOrderFolder(wo))
        target = runFolder / f"{buildFolderName(wo)}.csv"
        if not target.is_file():
            os.startfile(runFolder)
            return runFolder
    subprocess.Popen(f'explorer /select,"{target}"')
    return target


if __name__ == "__main__":
    import sys
    print(findWorkOrderFolder(sys.argv[1]))
