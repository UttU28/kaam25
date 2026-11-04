"""Read a WO sheet (.xlsx / .xlsm / .csv), whatever its headers say.

Each column is recognised by WHAT IS IN IT; header names are only a hint and a cross-check:

    WO        SO-HN_LM_136_ G23d_2U_102926_Nokia   (<name>_<script>_<variant>_<mmddyy>_<vendor>)
    Grid key  481990310001_00009_00003
    Lat/Long  decimal numbers; latitude is never beyond ±90, and here (north / west) latitude is
              the positive one and longitude the negative one. Headers are often swapped, so the
              VALUES decide and a header that disagrees is reported.
    Cluster   the start of the row's WO (SO-HN_LM_136); also headers "Cluster" / "GROUPING*"
    Team      N071; Market / Region / Name come from headers only

Works with or without a header row, several header rows (filters, "Format: mmddyy"), columns
in any order, merged cells (carried down), several sheets (the one with the most WOs wins),
and CSVs separated by , ; tab or |.

readSheet(path, team) returns (rows, notes): notes are short, readable lines about anything
unusual (swapped columns, other teams skipped, missing grid keys, duplicates...).

A plan with grid keys but no WO names gets them made up from its Grouping and date columns:
    SO-HN_LM_231 + 11/04/2026  ->  SO-HN_LM_231_G23e_2U_110426_Nokia
(the middle and the end - G23e_2U ... Nokia - copied from your latest WO; see nameParts).
"""

import csv
import io
import re
from datetime import date, datetime
from pathlib import Path
from statistics import median

# ---------- what values look like ----------
woPrefix = re.compile(r"^\s*(?:cloud\s*wo\s*-\s*|wo\s*:\s*)", re.IGNORECASE)
woPattern = re.compile(r"^[A-Za-z]{2,}[-_][A-Za-z0-9_\-]*?_[A-Za-z]\d+[A-Za-z]*_[A-Za-z0-9]+_\d{6}_[A-Za-z]+$")
gridKeyPattern = re.compile(r"^\d{10,15}_\d{4,6}_\d{4,6}$")
teamPattern = re.compile(r"^[A-Z]\d{3}$")
locationPairPattern = re.compile(r"^\s*\(?\s*(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*\)?\s*$")

# ---------- header words (hints only) ----------
headerWords = {
    "wo": {"wo", "woname", "workorder", "workordername"},
    "gridKey": {"gridkey", "grid", "gridid"},
    "lat": {"lat", "latitude", "testlat", "y"},
    "long": {"long", "lng", "lon", "longitude", "testlon", "testlong", "x"},
    "cluster": {"cluster", "grouping", "group"},
    "region": {"region"},
    "market": {"market"},
    "team": {"team"},
    "name": {"name", "drivername", "engineer"},
}
carriedDown = ("region", "market", "team", "name")  # usually merged cells in the sheet
fieldNames = {"wo": "WO", "gridKey": "Grid key", "lat": "Latitude", "long": "Longitude", "cluster": "Cluster",
              "region": "Region", "market": "Market", "team": "Team", "name": "Name"}


class SheetImportError(Exception):
    pass


# ---------- making WO names when the plan has none ----------
nameShape = re.compile(r"^(?P<cluster>.+?)_\s*(?P<script>[A-Za-z]\d+[A-Za-z]*)_(?P<variant>[A-Za-z0-9]+)_"
                       r"(?P<date>\d{6})_(?P<vendor>[A-Za-z]+)$")
groupingPattern = re.compile(r"^[A-Za-z]{2,}[-_][A-Za-z0-9_\-]*\d$")  # SO-HN_LM_231, CR-CB_RD_029
defaultParts = {"script": "G23e", "variant": "2U", "vendor": "Nokia"}


def nameParts(wos):
    """The middle and end of the newest WO name (by its mmddyy): {"script", "variant", "vendor"}."""
    best = None
    for wo in wos:
        match = nameShape.match(re.sub(r"\s+", "", wo or ""))
        if not match:
            continue
        mmddyy = match["date"]
        order = mmddyy[4:6] + mmddyy[0:4]  # yymmdd sorts by date
        if best is None or order > best[0]:
            best = (order, {key: match[key] for key in ("script", "variant", "vendor")})
    return best[1] if best else dict(defaultParts)


def planDate(text):
    """mmddyy from a plan date cell: 2026-11-04 / 11/4/2026 / 110426; '' if it isn't one."""
    text = str(text or "").strip()
    for pattern, order in ((r"(\d{4})-(\d{1,2})-(\d{1,2})", "ymd"), (r"(\d{1,2})/(\d{1,2})/(\d{2,4})", "mdy")):
        found = re.match(pattern, text)
        if found:
            parts = dict(zip(order, found.groups()))
            return f"{int(parts['m']):02d}{int(parts['d']):02d}{parts['y'][-2:]}"
    return text if re.fullmatch(r"(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{2}", text) else ""


def addWoNames(rows, parts):
    """A plan without WO names: adds a "WO" column made from Grouping + date. Returns
    (rows, note) or (None, "") when the sheet has no Grouping or date to make them from."""
    gridRows = [index for index, row in enumerate(rows) if any(isGridKey(value) for value in row)]
    if not gridRows:
        return None, ""
    width = max(len(rows[index]) for index in gridRows)
    headers = {column: headerTextFor(rows, gridRows[0], column) for column in range(width)}
    values = {column: [rows[index][column] if column < len(rows[index]) else "" for index in gridRows]
              for column in range(width)}
    groupings = [column for column in range(width)
                 if share(values[column], lambda value: bool(groupingPattern.match(value)) and not isGridKey(value)) >= 0.8]
    dates = [column for column in range(width) if share(values[column], lambda value: bool(planDate(value))) >= 0.8]
    if not groupings or not dates:
        return None, ""
    grouping = max(groupings, key=lambda column: headerScore(headers[column], "cluster"))
    dateColumn = max(dates, key=lambda column: "date" in headers[column].lower())
    out = [list(row) + [""] * (width - len(row)) for row in rows]
    for index in range(gridRows[0]):
        out[index].append("WO" if index == gridRows[0] - 1 else "")
    made = 0
    for index in gridRows:
        cluster, mmddyy = out[index][grouping].strip(), planDate(out[index][dateColumn])
        name = f"{cluster}_{parts['script']}_{parts['variant']}_{mmddyy}_{parts['vendor']}" if cluster and mmddyy else ""
        out[index].append(name)
        made += bool(name)
    note = (f"No WO names in this plan - made them from {headers[grouping] or 'the grouping'} + "
            f"{headers[dateColumn] or 'the date'} ({parts['script']}_{parts['variant']} and {parts['vendor']} "
            "copied from your latest WO), e.g. {example}.")
    return out, note


def squash(text):
    """Header text without spaces, symbols or case: "GROUPING*" -> "grouping"."""
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())


def cellText(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d") if value.time() == datetime.min.time() else value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def cleanWo(text):
    return woPrefix.sub("", text or "").strip()


def isWo(text):
    return bool(woPattern.match(re.sub(r"\s+", "", cleanWo(text))))


def isGridKey(text):
    return bool(gridKeyPattern.match(re.sub(r"\s+", "", text or "")))


def asNumber(text):
    """A decimal number like 30.48672 / "-94.17" -> float; anything else -> None."""
    text = str(text or "").strip()
    if not re.fullmatch(r"[-+]?\d+(\.\d+)?", text):
        return None
    return float(text)


def columnLetter(index):
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


# ---------- reading files ----------
def readCsv(path):
    raw = Path(path).read_bytes()
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    sample = text[:20000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [list(row) for row in csv.reader(io.StringIO(text), dialect)]


def readSheets(path):
    """[(sheet name, rows as lists of text)] - one entry for a CSV."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return [(path.name, [[cellText(value) for value in row] for row in readCsv(path)])]
    if suffix == ".xls":
        raise SheetImportError("Old .xls files can't be read - open it and save it as .xlsx or .csv.")
    try:
        from openpyxl import load_workbook
    except ImportError:
        raise SheetImportError("Reading Excel needs openpyxl: pip install -r requirements.txt")
    try:
        workbook = load_workbook(path, read_only=True, data_only=True)
    except Exception as error:
        raise SheetImportError(f"Couldn't open {path.name}: {error}")
    try:
        return [(sheet.title, [[cellText(value) for value in row] for row in sheet.iter_rows(values_only=True)])
                for sheet in workbook.worksheets]
    finally:
        workbook.close()


# ---------- finding the columns ----------
def headerTextFor(rows, firstDataRow, column):
    """Everything written above the data in this column (several header rows are joined)."""
    parts = [row[column] for row in rows[max(0, firstDataRow - 6):firstDataRow]
             if column < len(row) and row[column] and not isWo(row[column]) and not isGridKey(row[column])]
    return " ".join(parts)


def headerScore(header, field):
    """2 = the header is exactly that word, 1 = one of its words, 0 = no hint."""
    words = headerWords[field]
    if squash(header) in words:
        return 2
    tokens = set(re.findall(r"[a-z]+", str(header or "").lower()))
    return 1 if tokens & {word for word in words if len(word) > 2} else 0


def findWoColumn(rows):
    """(column, how many WO-looking cells) - the column with the most WO values."""
    counts = {}
    for row in rows:
        for column, value in enumerate(row):
            if value and isWo(value):
                counts[column] = counts.get(column, 0) + 1
    if not counts:
        return None, 0
    column = max(counts, key=lambda key: (counts[key], -key))
    return column, counts[column]


def share(values, test):
    filled = [value for value in values if value]
    return (sum(1 for value in filled if test(value)) / len(filled)) if filled else 0.0


def chooseLatLong(candidates, headers, columnValues, notes):
    """candidates: columns that hold decimal numbers in coordinate range. Returns (lat, long)
    columns or (None, None). The values decide; headers only break a tie."""
    stats = {}
    for column in candidates:
        numbers = [number for number in (asNumber(value) for value in columnValues[column]) if number is not None]
        stats[column] = {
            "beyond90": sum(1 for number in numbers if abs(number) > 90) / len(numbers),
            "positive": sum(1 for number in numbers if number > 0) / len(numbers),
            "negative": sum(1 for number in numbers if number < 0) / len(numbers),
            "latHint": headerScore(headers[column], "lat"),
            "longHint": headerScore(headers[column], "long"),
        }

    def pairEvidence(first, second):
        """How sure we are that first = lat and second = long (higher is surer), and why."""
        a, b = stats[first], stats[second]
        if b["beyond90"] >= 0.8 and a["beyond90"] == 0:
            return 3, "longitude values go beyond ±90"
        if a["positive"] >= 0.9 and b["negative"] >= 0.9:
            return 2, "latitude is the positive one, longitude the negative one (north / west)"
        if a["latHint"] and b["longHint"] and not a["longHint"] and not b["latHint"]:
            return 1, "headers"
        return 0, ""

    best = None
    for first in candidates:
        for second in candidates:
            if first == second:
                continue
            score, why = pairEvidence(first, second)
            # Prefer stronger evidence, then columns whose headers say lat / long, then neighbours.
            hints = stats[first]["latHint"] + stats[first]["longHint"] + stats[second]["latHint"] + stats[second]["longHint"]
            rank = (score, hints, -abs(first - second))
            if score and (best is None or rank > best[0]):
                best = (rank, first, second, why)
    if best is None:
        if len(candidates) >= 2:
            notes.append("Found number columns but couldn't tell latitude from longitude for sure - "
                         "location not imported. Check the sheet.")
        return None, None
    _, latColumn, longColumn, why = best
    if len(candidates) > 2:
        others = [f"{columnLetter(column)} ({headers[column] or 'no header'})" for column in candidates
                  if column not in (latColumn, longColumn)]
        notes.append(f"Other number columns ignored for location: {', '.join(others)}.")
    latHeader, longHeader = headers[latColumn], headers[longColumn]
    if headerScore(latHeader, "long") and not headerScore(latHeader, "lat") or \
            headerScore(longHeader, "lat") and not headerScore(longHeader, "long"):
        notes.append(f"Lat / Long headers are swapped in this sheet: column {columnLetter(latColumn)} "
                     f"(\"{latHeader}\") has the latitudes, column {columnLetter(longColumn)} (\"{longHeader}\") "
                     f"the longitudes. Imported them the right way round ({why}).")
    return latColumn, longColumn


def findColumns(rows, woColumn, dataRows, firstDataRow, notes):
    width = max(len(rows[index]) for index in dataRows)
    columnValues = {column: [rows[index][column] if column < len(rows[index]) else "" for index in dataRows]
                    for column in range(width)}
    headers = {column: headerTextFor(rows, firstDataRow, column) for column in range(width)}
    columns = {"wo": woColumn}
    taken = {woColumn}

    # Grid key: by value.
    gridShares = {column: share(values, isGridKey) for column, values in columnValues.items() if column not in taken}
    gridColumn = max(gridShares, key=lambda column: (gridShares[column], headerScore(headers[column], "gridKey")),
                     default=None)
    if gridColumn is not None and gridShares[gridColumn] >= 0.5:
        columns["gridKey"] = gridColumn
        taken.add(gridColumn)

    # One "lat, long" column instead of two?
    pairShares = {column: share(values, lambda value: bool(locationPairPattern.match(value)))
                  for column, values in columnValues.items() if column not in taken}
    pairColumn = max(pairShares, key=pairShares.get, default=None)

    # Lat / Long: decimal numbers within ±180 (whole numbers like a sequence or a date don't count).
    def isCoordinate(value):
        number = asNumber(value)
        return number is not None and abs(number) <= 180 and "." in str(value)

    candidates = [column for column, values in columnValues.items()
                  if column not in taken and share(values, isCoordinate) >= 0.8]
    if len(candidates) >= 2:
        latColumn, longColumn = chooseLatLong(candidates, headers, columnValues, notes)
        if latColumn is not None:
            columns["lat"], columns["long"] = latColumn, longColumn
            taken |= {latColumn, longColumn}
    elif pairColumn is not None and pairShares[pairColumn] >= 0.8:
        columns["location"] = pairColumn
        taken.add(pairColumn)
    elif candidates:
        notes.append(f"Only one coordinate column found ({columnLetter(candidates[0])}) - location not imported.")
    else:
        notes.append("No latitude / longitude columns found - location not imported.")

    # Cluster: the start of the row's WO (by value), or a "Cluster" / "Grouping" header.
    woValues = columnValues[woColumn]

    def clusterShare(column):
        pairs = [(value, wo) for value, wo in zip(columnValues[column], woValues) if value and wo]
        if not pairs:
            return 0.0
        hits = sum(1 for value, wo in pairs
                   if squash(wo).startswith(squash(value)) and len(squash(value)) >= 5 and squash(value) != squash(wo))
        return hits / len(pairs)

    clusterShares = {column: clusterShare(column) for column in columnValues if column not in taken}
    clusterColumn = max(clusterShares, key=lambda column: (clusterShares[column], headerScore(headers[column], "cluster")),
                        default=None)
    if clusterColumn is not None and clusterShares[clusterColumn] >= 0.6:
        columns["cluster"] = clusterColumn
    else:
        hinted = [column for column in columnValues if column not in taken and headerScore(headers[column], "cluster")]
        if hinted:
            columns["cluster"] = max(hinted, key=lambda column: headerScore(headers[column], "cluster"))
    if "cluster" in columns:
        taken.add(columns["cluster"])

    # Team: header, else values like N071.
    teamHinted = [column for column in columnValues if column not in taken and headerScore(headers[column], "team") == 2]
    if teamHinted:
        columns["team"] = teamHinted[0]
    else:
        teamShares = {column: share(values, lambda value: bool(teamPattern.match(value)))
                      for column, values in columnValues.items() if column not in taken}
        teamColumn = max(teamShares, key=teamShares.get, default=None)
        if teamColumn is not None and teamShares[teamColumn] >= 0.8:
            columns["team"] = teamColumn
    if "team" in columns:
        taken.add(columns["team"])

    # Region / Market / Name: headers only (an exact header word wins over a partial one).
    for field in ("region", "market", "name"):
        hinted = [(headerScore(headers[column], field), -column, column) for column in columnValues
                  if column not in taken and headerScore(headers[column], field)]
        if hinted:
            column = max(hinted)[2]
            if field == "name" and max(hinted)[0] < 2:
                continue  # "WO Name" etc. is not a person's name
            columns[field] = column
            taken.add(column)
    return columns, headers


# ---------- reading the rows ----------
def readSheet(path, team=None, knownWos=()):
    """Returns (rows, notes). rows: dicts with wo, gridKey, lat, long, cluster, region, market,
    team, name (only what the sheet has), in sheet order; a WO listed on several rows with
    different grid keys also gets gridKeys (all of them) and gridCount. team: e.g. "N071" - when the sheet has
    a Team column with that team in it, only those rows are imported. knownWos: WO names already
    in Records - a plan without WO names gets names shaped like the newest of them."""
    sheets = readSheets(path)
    found = [(name, rows, *findWoColumn(rows)) for name, rows in sheets]
    found.sort(key=lambda item: item[3], reverse=True)
    madeNote = ""
    if not found[0][3]:
        # No WO names anywhere: make them from Grouping + date (the sheet with the most grid keys).
        parts = nameParts(knownWos)
        for name, rows in sorted(sheets, key=lambda item: -sum(isGridKey(v) for row in item[1] for v in row)):
            made, madeNote = addWoNames(rows, parts)
            if made:
                found = [(name, made, *findWoColumn(made))]
                break
    sheetName, rows, woColumn, woCount = found[0]
    if not woCount:
        hint = ""
        allText = " ".join(value for _, rows, _, _ in found for row in rows[:5] for value in row)
        if any(isGridKey(value) for _, rows, _, _ in found for row in rows for value in row):
            hint = " It has grid keys but no WO names - the app needs the WO for each grid."
        raise SheetImportError(f"No WO names found (like SO-HN_LM_136_G23d_2U_102926_Nokia).{hint}")

    notes = [madeNote] if madeNote else []
    otherSheets = [name for name, _, _, count in found[1:] if count]
    if len(sheets) > 1:
        notes.append(f"Read sheet \"{sheetName}\"" +
                     (f" - other sheets with WOs were not imported: {', '.join(otherSheets)}." if otherSheets else "."))

    dataRows = [index for index, row in enumerate(rows) if woColumn < len(row) and isWo(row[woColumn])]
    firstDataRow = dataRows[0]
    columns, headers = findColumns(rows, woColumn, dataRows, firstDataRow, notes)

    # Rows that look like data but have no WO.
    noWo = [index + 1 for index, row in enumerate(rows)
            if index > firstDataRow and index not in dataRows
            and any(isGridKey(value) for value in row) and not (woColumn < len(row) and row[woColumn])]
    if noWo:
        notes.append(f"Skipped rows with a grid key but no WO: {formatRowNumbers(noWo)}.")
    oddWo = [index + 1 for index, row in enumerate(rows)
             if index > firstDataRow and index not in dataRows and woColumn < len(row) and row[woColumn]]
    if oddWo:
        notes.append(f"Skipped rows whose WO doesn't look like a WO name: {formatRowNumbers(oddWo)}.")

    workOrders, carried, seen = [], {}, {}
    duplicates, badGrid, noGrid, noLocation, swappedRows, badCluster = [], [], [], [], [], []
    for index in range(firstDataRow, len(rows)):
        row = rows[index]
        get = lambda field: row[columns[field]] if field in columns and columns[field] < len(row) else ""
        values = {field: get(field) for field in columns if field != "location"}
        for field in carriedDown:  # merged cells: empty means "same as above"
            if field in columns:
                if values.get(field):
                    carried[field] = values[field]
                else:
                    values[field] = carried.get(field, "")
        if index not in dataRows:
            continue
        number = index + 1
        values["wo"] = cleanWo(values["wo"])
        if "location" in columns:
            match = locationPairPattern.match(get("location"))
            values["lat"], values["long"] = (match.group(1), match.group(2)) if match else ("", "")

        # Location: each row checked on its own as well.
        lat, lon = asNumber(values.get("lat")), asNumber(values.get("long"))
        if lat is not None and lon is not None:
            if abs(lat) > 90 >= abs(lon) or lat < 0 < lon <= 90:
                values["lat"], values["long"] = values["long"], values["lat"]
                swappedRows.append(number)
        elif "lat" in columns or "location" in columns:
            values["lat"] = values["long"] = ""
            noLocation.append(number)

        if "gridKey" in columns:
            if not values.get("gridKey"):
                noGrid.append(number)
            elif not isGridKey(values["gridKey"]):
                badGrid.append(number)
        if values.get("cluster") and not squash(values["wo"]).startswith(squash(values["cluster"])):
            badCluster.append(number)

        key = squash(values["wo"])
        grid = values.get("gridKey", "")
        if key in seen:
            # Same WO again: another grid of a multi-grid WO (e.g. an RD route), or a repeated row.
            first = seen[key]
            if grid and grid not in first["gridKeys"]:
                first["gridKeys"].append(grid)
            else:
                duplicates.append(number)
            continue
        values["gridKeys"] = [grid] if grid else []
        values["_row"] = number
        seen[key] = values
        workOrders.append(values)

    for row in workOrders:
        if len(row["gridKeys"]) > 1:
            row["gridCount"] = str(len(row["gridKeys"]))  # first grid stays in gridKey (its location too)
        else:
            row.pop("gridKeys")

    # Location far from the rest of the same team's rows (a typo, or a row swapped differently).
    byTeam = {}
    for row in workOrders:
        lat, lon = asNumber(row.get("lat")), asNumber(row.get("long"))
        if lat is not None and lon is not None:
            byTeam.setdefault(row.get("team", ""), []).append((row, lat, lon))
    farAway = []
    for located in byTeam.values():
        if len(located) >= 3:
            middleLat, middleLong = median(lat for _, lat, _ in located), median(lon for _, _, lon in located)
            farAway += [row["_row"] for row, lat, lon in located
                        if abs(lat - middleLat) > 3 or abs(lon - middleLong) > 3]
    if farAway:
        notes.append(f"Location far from the others - please check: row {formatRowNumbers(sorted(farAway))}.")

    if swappedRows:
        notes.append(f"Lat / Long swapped on single rows, fixed: {formatRowNumbers(swappedRows)}.")
    if noLocation:
        notes.append(f"No location on rows {formatRowNumbers(noLocation)}.")
    if noGrid:
        notes.append(f"No grid key on rows {formatRowNumbers(noGrid)}.")
    if badGrid:
        notes.append(f"Grid key looks wrong on rows {formatRowNumbers(badGrid)} (imported as written).")
    if badCluster:
        notes.append(f"Cluster doesn't match the WO on rows {formatRowNumbers(badCluster)}.")
    if duplicates:
        notes.append(f"Repeated rows (same WO and grid) skipped: {formatRowNumbers(duplicates)}.")

    # Only your team's rows (EMPLOYEE_ID in .env). Other teams' WOs are never imported.
    if team and "team" in columns:
        team = team.strip().upper()
        mine = [row for row in workOrders if (row.get("team") or "").strip().upper() == team]
        others = sorted({(row.get("team") or "no team").strip().upper() for row in workOrders} - {team})
        if not mine:
            raise SheetImportError(f"No WOs for team {team} in this sheet (it has {', '.join(others)}). "
                                   "Nothing imported.")
        if len(mine) < len(workOrders):
            notes.append(f"Imported only team {team}'s {len(mine)} WOs; skipped {len(workOrders) - len(mine)} "
                         f"for {', '.join(others)}.")
        workOrders = mine
    elif team:
        notes.append(f"No Team column in this sheet, so it can't be filtered to {team} - imported all "
                     f"{len(workOrders)} WOs. Check they're yours.")

    if madeNote and workOrders:
        notes[0] = madeNote.replace("{example}", workOrders[0]["wo"])
    for row in workOrders:
        if row.get("gridCount"):
            notes.append(f"{row['wo']} has {row['gridCount']} grids (one per row) - all grid keys saved on it; "
                         "the first grid's location is used.")
        row.pop("_row", None)
    return [{field: value for field, value in row.items() if value} for row in workOrders], notes


def describeColumns(path, team=None):
    """For checking: which column was used for what (letter + header)."""
    sheets = readSheets(path)
    name, rows = max(sheets, key=lambda item: findWoColumn(item[1])[1])
    woColumn, _ = findWoColumn(rows)
    dataRows = [index for index, row in enumerate(rows) if woColumn < len(row) and isWo(row[woColumn])]
    columns, headers = findColumns(rows, woColumn, dataRows, dataRows[0], [])
    return {field: f"{columnLetter(column)} \"{headers[column]}\"" for field, column in columns.items()}


def formatRowNumbers(numbers):
    numbers = list(numbers)
    shown = ", ".join(map(str, numbers[:8]))
    return shown + (f" and {len(numbers) - 8} more" if len(numbers) > 8 else "")


def readWorkOrders(path, team=None):
    """Just the rows (see readSheet for the notes)."""
    return readSheet(path, team)[0]
