"""Find the drive log files to upload for a WO.

Layout: C:\\TemsParagon\\Logfiles\\<EQ3|EQ6>\\Cloud WO - <WO>\\001, 002, ... -> newest
numbered folder wins, and every file in it is uploaded.
"""

import re

from .config import equipments, logRootDir  # from .env


class LogFilesError(Exception):
    pass


def squash(text):
    """Lowercase with all whitespace removed, so 'LM_143_ G23e' matches 'LM_143_G23e'."""
    return re.sub(r"\s+", "", text or "").lower()


def findWoFolder(wo, baseDir):
    wo = squash(wo)
    if not baseDir.is_dir():
        raise LogFilesError(f"Log folder not found: {baseDir}")
    folders = [d for d in baseDir.iterdir() if d.is_dir()]
    matches = [d for d in folders if squash(d.name).endswith(wo)] or \
              [d for d in folders if wo in squash(d.name)]
    if not matches:
        raise LogFilesError(f"No folder for {wo.upper()} in {baseDir}")
    return max(matches, key=lambda d: d.stat().st_mtime)


def findLatestRunFolder(woFolder):
    """001, 002, 003 -> 003. Falls back to the newest folder if names aren't numbers."""
    runs = [d for d in woFolder.iterdir() if d.is_dir()]
    if not runs:
        return woFolder  # files sit directly in the WO folder
    numbered = [d for d in runs if d.name.isdigit()]
    if numbered:
        return max(numbered, key=lambda d: int(d.name))
    return max(runs, key=lambda d: d.stat().st_mtime)


def removeSpaces(path):
    """ActixOne rejects file names with spaces: rename 'LM_143_ G23e_x.trp' to 'LM_143_G23e_x.trp' on disk."""
    cleanName = re.sub(r"\s+", "", path.name)
    if cleanName == path.name:
        return path
    target = path.with_name(cleanName)
    if target.exists():
        raise LogFilesError(f"Can't rename {path.name}: {cleanName} already exists in {path.parent}")
    return path.rename(target)


def findLatestLogFiles(wo, equipment="EQ3", rootDir=logRootDir):
    runFolder = findLatestRunFolder(findWoFolder(wo, rootDir / equipment))
    files = sorted(removeSpaces(f) for f in runFolder.iterdir() if f.is_file())
    if not files:
        raise LogFilesError(f"No files in {runFolder}")
    return files


if __name__ == "__main__":
    import sys
    for equipment in equipments:
        for path in findLatestLogFiles(sys.argv[1], equipment):
            print(path)
