"""Kaam25 desktop dashboard (the older CustomTkinter UI; the web app in web/ is the main one).

- Start Ticket: create the TechInsights ticket for a WO and get its ID.
- End Ticket: find + verify the ticket ID, copy GridSummary, upload EQ3/EQ6, build the report.
- Records: everything Start / End Ticket saved (tickets.json), searchable, copyable.
"""

import ctypes
import queue
import re
import sys
import threading
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox

import customtkinter as ctk

# Run from anywhere: the project folder (with kaam/ and .env) is one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kaam.actixLogin import prepareAllUploads
from kaam.apeksha import shareLocation
from kaam.chromeBridge import ChromeBridgeError, requestTabsClosed, resetStop, stopAll
from kaam.config import (defaultAttempted, defaultLogsUploadedPreviousDay, defaultMarket,  # from .env
                    defaultRegion, driveShiftPmFrom, equipments,
                    defaultSkipped, defaultStatus, defaultSubmit, defaultTotalGrids, employeeId,
                    gridSummaryFile, ticketStoreFile, whatsappGroup, whatsappSend)
from kaam.gridSummary import buildFolderName, copyGridSummary, findRenamedCopy, showInExplorer
from kaam.ticketLookup import closeTicketSteps, currentDriveShift, lookupTicketId, openCreateTicketForm
from kaam.sheetImport import readSheet
from kaam.ticketStore import deleteRecord as deleteTicketRecord
from kaam.ticketStore import moveToToday, startNewTicket
from kaam.ticketStore import cloudStartToday, isLocalStart, localIdPattern, localTicketId, nextLocalNumber, startLocal
from kaam.ticketStore import (findByGridKey, findRecord, getRecord, importWorkOrders, notStartedRecords, now,
                         openTicketsToday, saveRecord, searchRecords, woKey)
from kaam.whatsappShare import shareOnWhatsApp

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

# Colors
bgColor = "#0f1115"
cardColor = "#181b22"
fieldColor = "#20242d"
borderColor = "#2c313c"
textColor = "#e6e8ee"
mutedColor = "#8a91a0"
accentColor = "#4f8cff"
greenColor = "#2fbf71"
greenHoverColor = "#27a862"
redColor = "#e5534b"
amberColor = "#d8a03a"
purpleColor = "#a371f7"
whatsappColor = "#25d366"
whatsappHoverColor = "#1fb457"
cardHoverColor = "#1e222b"
selectedColor = "#232a38"
darkTextColor = "#0b1410"

statusOptions = ["PASSED", "SKIPPED", "FAILED"]
statusColors = {"PASSED": greenColor, "SKIPPED": amberColor, "FAILED": redColor}
fieldHeight = 30
rowGap = 4

# "Cloud WO - X", "WO: X", "WO:X" -> "X"
woPrefixPattern = re.compile(r"^\s*(?:cloud\s*wo\s*-\s*|wo\s*:\s*)", re.IGNORECASE)


def cleanWorkOrder(text):
    return woPrefixPattern.sub("", text).strip()


def formatReport(fields):
    """The text that gets copied. fields: wo, ticket, eq3, eq6, total, attempted, skipped,
    status, remarks. REMARKS is left out when empty."""
    get = lambda key: (fields.get(key) or "").strip()
    report = (
        f"WO: {get('wo')}\n"
        f"Ticket ID: {get('ticket')}\n"
        f"\n"
        f"EQ3: {get('eq3')}\n"
        f"EQ6: {get('eq6')}\n"
        f"\n"
        f"TOTAL GRIDS: {get('total')}\n"
        f"GRIDS ATTEMPTED: {get('attempted')}\n"
        f"GRIDS SKIPPED: {get('skipped')}\n"
        f"STATUS : {get('status')}"
    )
    if get("remarks"):
        report += f"\n\nREMARKS: {get('remarks')}"
    return report


matchedByNames = {"gridKey": "Grid key", "ticketId": "Ticket ID"}


def resolveWorkOrder(text):
    """What's in a WO box -> (wo, record, matchedBy). Accepts a WO, grid key or Ticket ID;
    anything unknown comes back as typed (cleaned), with record None."""
    cleaned = cleanWorkOrder(text)
    try:
        record, matchedBy = findRecord(cleaned)
    except Exception:
        record, matchedBy = None, None
    return (record["wo"] if record else cleaned), record, matchedBy


def latLong(record):
    """(lat, long) as saved text, in the right order. Some sheets have the Lat and Long columns
    swapped (lat -93.9, long 30.2); here latitude is the positive one (north) and longitude the
    negative one (west), so a swapped pair is put back. ("", "") when there's no location."""
    lat, lon = str((record or {}).get("lat") or "").strip(), str((record or {}).get("long") or "").strip()
    try:
        latValue, lonValue = float(lat), float(lon)
    except ValueError:
        return lat, lon
    if abs(latValue) > 90 or (latValue < 0 < lonValue):
        return lon, lat
    return lat, lon


def formatLocationPreview(wo, record=None):
    """Start Ticket's copyable preview:
        WO: ...
        Grid Key: ...
        Location: <lat>, <long>"""
    record = record or {}
    lat, lon = latLong(record)
    location = f"{lat}, {lon}" if lat or lon else ""
    return f"WO: {wo or record.get('wo', '')}\nGrid Key: {record.get('gridKey') or ''}\nLocation: {location}"


def reportFromRecord(record):
    return record.get("report") or formatReport({
        "wo": record.get("wo"), "ticket": record.get("ticketId"),
        "eq3": record.get("eq3"), "eq6": record.get("eq6"),
        "total": record.get("totalGrids"), "attempted": record.get("attempted"),
        "skipped": record.get("skipped"), "status": record.get("status"),
        "remarks": record.get("remarks"),
    })


def safeSave(wo, event=None, **fields):
    """Save to tickets.json; a disk problem is reported, never fatal. Returns an error or None."""
    try:
        saveRecord(wo, event=event, **fields)
        return None
    except Exception as error:
        return f"Couldn't save to {ticketStoreFile.name}: {error}"


def parseTime(isoText):
    try:
        return datetime.fromisoformat(isoText)
    except (TypeError, ValueError):
        return None


def recordDay(record):
    """The day a ticket belongs to: when it was completed, else when it started. "Move to
    today" in Records can push it later (never earlier)."""
    day = datetime.min
    for key in ("endedAt", "startedAt", "createdAt", "updatedAt"):
        moment = parseTime(record.get(key))
        if moment:
            day = moment
            break
    moved = parseTime(record.get("movedToDayAt"))
    return max(day, moved) if moved else day


def dayLabel(moment):
    days = (datetime.now().date() - moment.date()).days
    if days == 0:
        return "TODAY"
    if days == 1:
        return "YESTERDAY"
    return f"{moment.strftime('%a, %b').upper()} {moment.day}" if moment != datetime.min else "UNDATED"


def clockTime(isoText):
    moment = parseTime(isoText)
    return moment.strftime("%I:%M %p").lstrip("0") if moment else ""


def niceTime(isoText):
    try:
        moment = datetime.fromisoformat(isoText)
    except (TypeError, ValueError):
        return isoText or ""
    return f"{moment.strftime('%b')} {moment.day}, {moment.strftime('%I:%M %p').lstrip('0')}"


def smallFont(weight="normal"):
    return ctk.CTkFont(size=12, weight=weight)


def runInBackground(widget, work, onDone):
    """Run work() off the UI thread, then onDone(ok, resultOrErrorText) back on it."""
    results = queue.Queue()

    def runWork():
        try:
            results.put((True, work()))
        except Exception as error:
            results.put((False, str(error) or error.__class__.__name__))

    def poll():
        try:
            ok, value = results.get_nowait()
        except queue.Empty:
            widget.after(150, poll)
            return
        onDone(ok, value)

    threading.Thread(target=runWork, daemon=True).start()
    widget.after(150, poll)


def makeWhatsappButton(parent, command, height=36):
    return ctk.CTkButton(
        parent, text="💬  WhatsApp", height=height, width=128, corner_radius=8,
        fg_color=whatsappColor, hover_color=whatsappHoverColor, text_color=darkTextColor,
        font=ctk.CTkFont(size=13, weight="bold"), command=command,
    )


def makeWhatsappSendSwitch(parent, sendVar):
    """The WhatsApp Send switch. End Ticket and Records share one sendVar, so flipping
    either switch flips both (labels included)."""
    switch = ctk.CTkSwitch(
        parent, text="", variable=sendVar, progress_color=whatsappColor, button_color=textColor,
        button_hover_color=textColor, fg_color=borderColor, switch_width=40, switch_height=20,
        font=smallFont("bold"), text_color=textColor,
    )

    def updateLabel(*_):
        if not switch.winfo_exists():
            return
        switch.configure(text="WhatsApp: Send ON - presses Send" if sendVar.get()
                         else "WhatsApp: Send OFF - waits for you to press Send")

    sendVar.trace_add("write", updateLabel)
    updateLabel()
    return switch


def makeWhatsappPill(parent, record):
    """Small WhatsApp marker: green once the report was sent, grey while it's still pending."""
    if record.get("whatsappSentAt"):
        return ctk.CTkLabel(parent, text=" W ", fg_color=whatsappColor, text_color=darkTextColor,
                            corner_radius=9, height=18, font=ctk.CTkFont(size=10, weight="bold"))
    return ctk.CTkLabel(parent, text=" W ", fg_color=borderColor, text_color=mutedColor,
                        corner_radius=9, height=18, font=ctk.CTkFont(size=10, weight="bold"))


navigateIcon = "🧭"


def makeIconButton(parent, icon, command):
    """Small square icon button (copy / navigate)."""
    return ctk.CTkButton(
        parent, text=icon, width=32, height=28, corner_radius=7, fg_color=fieldColor, hover_color=borderColor,
        border_width=1, border_color=borderColor, text_color=textColor, font=ctk.CTkFont(size=14),
        command=command)


def flashIcon(button, icon, ok):
    button.configure(text="✓" if ok else "✗", fg_color=greenColor if ok else redColor)
    button.after(1400, lambda: button.configure(text=icon, fg_color=fieldColor))


def hasLocation(record):
    return all(latLong(record))


def sendLocation(widget, button, record, onMessage):
    """Navigate icon: send "lat long" to Apeksha in the background, then say how it went."""
    if not hasLocation(record):
        onMessage("No location saved for this WO, nothing to send.", amberColor)
        return
    lat, lon = latLong(record)
    button.configure(state="disabled", text="…")
    result = []

    def work():
        try:
            result.append((True, shareLocation(lat, lon)))  # just "lat long", nothing else
        except Exception as error:
            result.append((False, str(error) or error.__class__.__name__))

    def poll():
        if not result:
            widget.after(120, poll)
            return
        ok, value = result[0]
        button.configure(state="normal")
        flashIcon(button, navigateIcon, ok)
        if not ok:
            onMessage(f"Couldn't send the location: {value}", redColor)
        elif value.get("duplicate"):
            onMessage(f"Location {lat} {lon} is already the newest on Apeksha - nothing new saved.", accentColor)
        else:
            onMessage(f"Sent {lat} {lon} to Apeksha" + (" as a Maps link ✓" if value.get("mapsLink") else " ✓"),
                      greenColor)

    threading.Thread(target=work, daemon=True).start()
    widget.after(120, poll)


class LocationPreview(ctk.CTkFrame):
    """The "WO / Grid Key / Location" preview with copy and navigate (send to Apeksha) icons.
    show(wo) refreshes it from Records."""

    def __init__(self, master, title="WO · Grid Key · Location", **kwargs):
        super().__init__(master, fg_color=kwargs.pop("fg_color", "transparent"), **kwargs)
        self.record = None
        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x")
        ctk.CTkLabel(top, text=title, text_color=mutedColor, font=smallFont("bold")).pack(side="left")
        self.status = ctk.CTkLabel(top, text="", text_color=mutedColor, font=ctk.CTkFont(size=11), anchor="w")
        self.status.pack(side="left", padx=(10, 0), fill="x", expand=True)
        self.copyButton = makeQuietButton(top, "Copy", self.copy, width=62, height=28)  # the whole preview
        self.copyButton.pack(side="right")
        self.navigateButton = makeIconButton(top, navigateIcon, self.navigate)
        self.navigateButton.pack(side="right", padx=(0, 6))
        self.box = ctk.CTkTextbox(
            self, height=64, fg_color=bgColor, text_color=textColor, corner_radius=8, border_width=1,
            border_color=borderColor, font=ctk.CTkFont(family="Consolas", size=12), wrap="none",
        )
        self.box.pack(fill="x", pady=(4, 0))
        self.text = ""
        self.show("")

    def show(self, wo, record=None):
        wo = (wo or "").strip()
        if record is None and wo:
            try:
                record = getRecord(wo)
            except Exception:
                record = None
        if woKey(wo) != woKey((self.record or {}).get("wo")):
            self.status.configure(text="")  # a note about another WO doesn't belong here
        self.record = record
        self.text = formatLocationPreview(wo, record)
        self.box.configure(state="normal")
        self.box.delete("1.0", "end")
        self.box.insert("1.0", self.text)
        self.box.configure(state="disabled")
        self.copyButton.configure(state="normal" if wo else "disabled")
        self.navigateButton.configure(state="normal" if hasLocation(record) else "disabled")

    def copy(self):
        copyText(self, self.text)
        flashCopied(self.copyButton, "Copy", fieldColor)

    def navigate(self):
        sendLocation(self, self.navigateButton, self.record,
                     lambda text, color: self.status.configure(text=text, text_color=color))


ticketLinePattern = re.compile(r"^(Ticket ID:)[ \t]*(.*)$", re.MULTILINE)


def whatsappCaption(wo, report):
    """The report as shared on WhatsApp: a local start has no real ticket, so its "Ticket ID:"
    line goes out blank (the LM_N_date ID stays in Records and the copied report)."""
    try:
        record, _ = findRecord(wo)
    except Exception:
        record = None
    match = ticketLinePattern.search(report or "")
    if match and (isLocalStart(record) or localIdPattern.match(match.group(2).strip())):
        report = ticketLinePattern.sub(r"\1", report, count=1)
    return report


def shareTicket(widget, button, wo, caption, csvPath, onMessage, send=None):
    """Shared by End Ticket and Records: share on WhatsApp, report back, save to Records.
    send: True / False from End Ticket's switch; None = WHATSAPP_SEND from .env."""
    if not wo:
        onMessage("Enter a WO first.", redColor)
        return
    caption = whatsappCaption(wo, caption)
    button.configure(state="disabled", text="Sharing…")
    resetStop()  # an earlier Stop must not cancel this new share
    onMessage("Sharing on WhatsApp… (waiting for WhatsApp to load fully)", mutedColor)

    def onDone(ok, value):
        button.configure(state="normal", text="💬  WhatsApp")
        if ok:
            summary, wasSent = value
            safeSave(wo, event=f"WhatsApp: {'sent' if wasSent else 'ready, not sent'} to {whatsappGroup}",
                     **({"whatsappSentAt": now(), "whatsappGroup": whatsappGroup} if wasSent else {}))
            if hasattr(widget, "refresh"):
                widget.refresh()  # Records: the WhatsApp marker turns green straight away
            onMessage(summary, greenColor)
        else:
            safeSave(wo, event=f"WhatsApp: failed - {value}")
            onMessage(value, redColor)
        recordsChanged(widget)
        bringToFront(widget)

    runInBackground(widget, lambda: shareOnWhatsApp(
        wo, caption, csvPath, send=whatsappSend if send is None else send), onDone)


def recordsChanged(widget):
    """Tell the window to update anything that shows record counts (the nav bar chip)."""
    window = widget.winfo_toplevel()
    if hasattr(window, "refreshOpenCount"):
        window.refreshOpenCount()


def bringToFront(widget):
    """Switch back to the app (from Chrome) when a run finishes."""
    window = widget.winfo_toplevel()
    try:
        window.deiconify()
        window.lift()
        window.attributes("-topmost", True)
        window.after(500, lambda: window.attributes("-topmost", False))
        if sys.platform == "win32":
            # Windows won't let a background app take focus; a quick Alt tap is the usual way round it.
            user32 = ctypes.windll.user32
            altKey, keyUp = 0x12, 0x0002
            user32.keybd_event(altKey, 0, 0, 0)
            user32.SetForegroundWindow(int(window.wm_frame(), 16))
            user32.keybd_event(altKey, 0, keyUp, 0)
        window.focus_force()
    except Exception:
        pass  # never let this break the app


def copyText(widget, text):
    widget.clipboard_clear()
    widget.clipboard_append(text)
    widget.update()  # keep clipboard contents after the app closes


def flashCopied(button, text, color):
    button.configure(text="Copied ✓", fg_color=greenColor)
    button.after(1400, lambda: button.configure(text=text, fg_color=color))


saveLabel = "💾  Save"


def setSaveEnabled(button, isChanged):
    """A Save button is only clickable when something differs from what Records has."""
    if button.cget("text") == saveLabel:  # leave a "Saved ✓" flash alone
        button.configure(state="normal" if isChanged else "disabled")


def flashSaved(button, isChanged):
    """After saving: "Saved ✓" for a moment, then back to Save (disabled - nothing new yet)."""
    button.configure(text="Saved ✓", fg_color=greenColor, state="disabled")
    button.after(1400, lambda: (button.configure(text=saveLabel, fg_color=fieldColor),
                                setSaveEnabled(button, isChanged())))


def addPlaceholder(entry, variable, text):
    """Grey hint text inside an entry while it's empty. CustomTkinter's own placeholder_text
    never shows on an entry that has a textvariable, so this draws it instead."""
    if not text:
        return
    hint = ctk.CTkLabel(entry, text=text, text_color=mutedColor, fg_color=entry.cget("fg_color"),
                        font=entry.cget("font"), height=10, anchor="w", cursor="xterm")
    hint.bind("<Button-1>", lambda _: entry.focus_set())

    def update(*_):
        if variable.get():
            hint.place_forget()
        else:
            hint.place(x=10, rely=0.5, anchor="w")

    variable.trace_add("write", update)
    update()


def capPageWidth(page, maxWidth=1200, minPad=20):
    """Keep a page's content at most maxWidth wide, centered, so forms don't stretch across
    a maximized window."""
    def update(_=None):
        pad = max(minPad, (page.winfo_width() - maxWidth) // 2)
        for child in page.pack_slaves():
            child.pack_configure(padx=pad)

    page.bind("<Configure>", update, add="+")


def makeCopyWoButton(parent, variable, height=fieldHeight):
    """"Copy" next to a WO box: copies the WO that's in it."""
    def copy():
        wo = variable.get().strip()
        if wo:
            copyText(parent, wo)
            flashCopied(button, "Copy", fieldColor)

    button = makeQuietButton(parent, "Copy", copy, width=62, height=height)
    return button


def makeQuietButton(parent, text, command, width=70, height=fieldHeight):
    return ctk.CTkButton(
        parent, text=text, height=height, width=width, corner_radius=7,
        fg_color=fieldColor, hover_color=borderColor, border_width=1, border_color=borderColor,
        text_color=textColor, font=smallFont("bold"), command=command,
    )


def makeBackButton(parent, onBack):
    return makeQuietButton(parent, "← Home", onBack, width=80, height=28)


def makePageHeader(parent, title, subtitle, color, onBack, onDone=None, onClear=None):
    """Back button, colored dot, title, subtitle, a Clear button (when onClear is given)
    and a Done button (hidden until shown). Returns (header, doneButton, clearButton)."""
    header = ctk.CTkFrame(parent, fg_color="transparent")  # going back is the top nav bar's job
    ctk.CTkFrame(header, width=10, height=10, corner_radius=5, fg_color=color).pack(side="left", padx=(0, 8))
    ctk.CTkLabel(header, text=title, text_color=textColor,
                 font=ctk.CTkFont(size=19, weight="bold")).pack(side="left")
    ctk.CTkLabel(header, text=subtitle, text_color=mutedColor,
                 font=smallFont()).pack(side="left", padx=(12, 0), pady=(4, 0))
    doneButton = ctk.CTkButton(
        header, text="✓  Done", height=30, width=112, corner_radius=8,
        fg_color=greenColor, hover_color=greenHoverColor, text_color=darkTextColor,
        font=ctk.CTkFont(size=13, weight="bold"), command=onDone or (lambda: None),
    )
    clearButton = None
    if onClear:
        # Packed first, so it sits at the far right with Done appearing just left of it.
        clearButton = makeQuietButton(header, "⟲  Clear", onClear, width=96, height=30)
        clearButton.pack(side="right", padx=(8, 0))
    return header, doneButton, clearButton


def makeStopButton(header, command):
    """Red ⏹ Stop for the page header; shown only while a run is going."""
    return ctk.CTkButton(
        header, text="⏹  Stop", height=30, width=96, corner_radius=8,
        fg_color=redColor, hover_color="#c9443d", text_color="#ffffff",
        font=ctk.CTkFont(size=13, weight="bold"), command=command,
    )


def showStopButton(button):
    button.configure(state="normal", text="⏹  Stop")
    button.pack(side="right", padx=(8, 0))


def pressStop(button, onMessage):
    """Stop the current run: the app stops waiting, the extension skips Create / Submit / Send."""
    stopAll()
    button.configure(state="disabled", text="Stopping…")
    onMessage("Stopping… anything already saved stays saved. Rerun, or fill in the rest by hand.", amberColor)


class EndTicketPage(ctk.CTkFrame):
    """Find + verify the ticket ID, copy GridSummary, upload EQ3/EQ6 and build the report."""

    def __init__(self, master, onBack, whatsappSendVar):
        super().__init__(master, fg_color=bgColor)
        self.onBack = onBack
        self.whatsappSendVar = whatsappSendVar  # shared with Records: flip one, both follow

        self.fieldVars = {}
        self.entries = {}
        self.toggles = {}
        self.lookupResults = queue.Queue()
        self.isLookupBusy = False
        self.gridFilePath = None
        self.grid_columnconfigure(0, weight=1, uniform="col")
        self.grid_columnconfigure(1, weight=1, uniform="col")
        self.grid_rowconfigure(1, weight=1)

        self.buildHeader()
        self.buildForm()
        self.buildPreview()
        self.bindShortcuts()
        self.updatePreview()

    # ---------- layout ----------
    def smallFont(self, weight="normal"):
        return ctk.CTkFont(size=12, weight=weight)

    def buildHeader(self):
        header, self.doneButton, self.clearButton = makePageHeader(
            self, "End Ticket", "Report updates live · Ctrl+Enter copies it", greenColor,
            onBack=self.onBack, onDone=self.finishAndGoHome, onClear=self.clearForNext)
        header.grid(row=0, column=0, columnspan=2, sticky="ew", padx=20, pady=(12, 2))
        self.stopButton = makeStopButton(header, lambda: pressStop(
            self.stopButton, lambda text, color: self.lookupMessage.configure(text=text, text_color=color)))

    def clearForNext(self):
        """Empty the page for the next ticket, staying here. Saves the report first."""
        if self.isLookupBusy:
            return
        self.saveReport()
        self.doneButton.pack_forget()
        self.clearForm()
        self.refreshOpenTickets()
        self.entries["wo"].focus_set()

    def finishAndGoHome(self):
        wo = self.getValue("wo")
        record = (getRecord(wo) or {}) if wo else {}
        isCompleted = bool(record.get("endedAt"))
        self.saveReport(event="End: done", **({} if isCompleted else {"endedAt": now()}))
        # Ticket done: now the EQ tabs can close (the extension does it within ~30 s).
        if record.get("eqTabTokens"):
            try:
                requestTabsClosed(record["eqTabTokens"])
                safeSave(wo, eqTabTokens=[])
            except Exception:
                pass  # tabs just stay open; never block Done
        self.doneButton.pack_forget()
        self.clearForm()
        self.onBack()

    def makeCard(self, column, title):
        card = ctk.CTkFrame(self, fg_color=cardColor, corner_radius=12, border_width=1, border_color=borderColor)
        padX = (20, 8) if column == 0 else (8, 20)
        card.grid(row=1, column=column, sticky="nsew", padx=padX, pady=(6, 16))
        ctk.CTkLabel(
            card, text=title, text_color=textColor, font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(anchor="w", padx=16, pady=(10, 2))
        return card

    def makeLabel(self, parent, text):
        return ctk.CTkLabel(parent, text=text, text_color=mutedColor, font=self.smallFont(), height=18)

    def makeEntry(self, parent, key, label, placeholder="", default=""):
        box = ctk.CTkFrame(parent, fg_color="transparent")
        self.makeLabel(box, label).pack(anchor="w")
        fieldVar = ctk.StringVar(value=default)
        fieldVar.trace_add("write", lambda *_: self.updatePreview())
        entry = ctk.CTkEntry(
            box, textvariable=fieldVar, placeholder_text=placeholder, height=fieldHeight,
            fg_color=fieldColor, border_color=borderColor, text_color=textColor, corner_radius=7,
        )
        entry.pack(fill="x")
        addPlaceholder(entry, fieldVar, placeholder)
        self.fieldVars[key] = fieldVar
        self.entries[key] = entry
        return box

    def makeToggle(self, parent, key, label, default):
        """A 0 / 1 switch."""
        box = ctk.CTkFrame(parent, fg_color="transparent")
        self.makeLabel(box, label).pack(anchor="w")
        fieldVar = ctk.StringVar(value=default)
        fieldVar.trace_add("write", lambda *_: self.updatePreview())
        toggle = ctk.CTkSegmentedButton(
            box, values=["0", "1"], variable=fieldVar, height=fieldHeight,
            font=self.smallFont("bold"), command=lambda value: self.onToggle(key, value),
            fg_color=fieldColor, selected_color=accentColor, selected_hover_color=accentColor,
            unselected_color=fieldColor, unselected_hover_color=borderColor,
        )
        toggle.pack(fill="x")
        self.fieldVars[key] = fieldVar
        self.toggles[key] = toggle
        return box

    def buildForm(self):
        card = self.makeCard(0, "Details")
        body = ctk.CTkFrame(card, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=16, pady=(0, 12))

        woRow = ctk.CTkFrame(body, fg_color="transparent")
        woRow.pack(fill="x", pady=rowGap)
        self.makeEntry(woRow, "wo", "WO", "Paste a WO or grid key, then Enter").pack(
            side="left", fill="x", expand=True)
        self.entries["wo"].bind("<Return>", lambda _: self.findTicket())
        self.fieldVars["wo"].trace_add("write", lambda *_: self.onWoChange())
        self.copyWoButton = makeCopyWoButton(woRow, self.fieldVars["wo"])
        self.copyWoButton.pack(side="left", padx=(8, 0), anchor="s")
        # Today's started-but-not-completed WOs: pick one instead of pasting.
        self.openTicketMap = {}
        self.openTicketsMenu = ctk.CTkOptionMenu(
            woRow, values=["-"], width=160, height=fieldHeight, corner_radius=7, dynamic_resizing=False,
            command=self.onPickOpenTicket, fg_color=fieldColor, button_color=borderColor,
            button_hover_color=accentColor, text_color=amberColor, font=self.smallFont("bold"),
            dropdown_fg_color=cardColor, dropdown_hover_color=selectedColor, dropdown_text_color=textColor,
            dropdown_font=ctk.CTkFont(size=12),
        )
        self.openTicketsMenu.pack(side="left", padx=(8, 0), anchor="s")
        self.refreshOpenTickets()

        ticketRow = ctk.CTkFrame(body, fg_color="transparent")
        ticketRow.pack(fill="x", pady=rowGap)
        self.makeEntry(ticketRow, "ticket", "Ticket ID", "Found automatically, or type it").pack(side="left", fill="x", expand=True)
        self.findButton = ctk.CTkButton(
            ticketRow, text="Find in Chrome", height=fieldHeight, width=130, corner_radius=7,
            fg_color=accentColor, font=self.smallFont("bold"), command=self.findTicket,
        )
        self.findButton.pack(side="left", padx=(8, 0), anchor="s")
        self.lookupMessage = ctk.CTkLabel(
            body, text="Type the WO and press Enter to look up the Ticket ID.",
            text_color=mutedColor, font=ctk.CTkFont(size=11), anchor="w", justify="left", wraplength=420,
        )
        self.lookupMessage.pack(fill="x")

        eqRow = ctk.CTkFrame(body, fg_color="transparent")
        eqRow.pack(fill="x", pady=rowGap)
        eqRow.grid_columnconfigure((0, 1), weight=1, uniform="eq")
        self.makeEntry(eqRow, "eq3", "EQ3", "EQ3 Job ID (AJO-TX-…)").grid(row=0, column=0, sticky="ew", padx=(0, 6))
        self.makeEntry(eqRow, "eq6", "EQ6", "EQ6 Job ID (AJO-TX-…)").grid(row=0, column=1, sticky="ew", padx=(6, 0))
        # Typed in by hand (e.g. reading one failed): saved like an uploaded one, so a rerun skips it.
        self.saveEqButton = makeQuietButton(eqRow, "💾 Save", self.saveEqIds, width=76)
        self.saveEqButton.grid(row=0, column=2, sticky="s", padx=(8, 0))

        gridsRow = ctk.CTkFrame(body, fg_color="transparent")
        gridsRow.pack(fill="x", pady=rowGap)
        gridsRow.grid_columnconfigure((0, 1, 2), weight=1, uniform="g")
        self.makeEntry(gridsRow, "total", "Total grids", "1", default=defaultTotalGrids).grid(
            row=0, column=0, sticky="ew", padx=(0, 6))
        self.makeToggle(gridsRow, "attempted", "Grids attempted", defaultAttempted).grid(
            row=0, column=1, sticky="ew", padx=6)
        self.makeToggle(gridsRow, "skipped", "Grids skipped", defaultSkipped).grid(
            row=0, column=2, sticky="ew", padx=(6, 0))

        self.makeLabel(body, "Status").pack(anchor="w", pady=(rowGap, 0))
        self.status = ctk.StringVar(value=defaultStatus)
        self.statusButton = ctk.CTkSegmentedButton(
            body, values=statusOptions, variable=self.status, height=fieldHeight,
            font=self.smallFont("bold"), command=lambda _: self.onStatusChange(),
            fg_color=fieldColor, unselected_color=fieldColor, unselected_hover_color=borderColor,
        )
        self.statusButton.pack(fill="x")
        self.onStatusChange(refresh=False)

        self.makeLabel(body, "Remarks (optional)").pack(anchor="w", pady=(rowGap + 2, 0))
        self.remarks = ctk.CTkTextbox(
            body, height=56, fg_color=fieldColor, border_color=borderColor, border_width=2,
            text_color=textColor, corner_radius=7, wrap="word",
        )
        self.remarks.pack(fill="x")
        self.remarks.bind("<KeyRelease>", lambda _: self.updatePreview())

        self.makeLabel(body, f"Folder name (today_{employeeId}_Cloud WO - WO)").pack(anchor="w", pady=(rowGap + 2, 0))
        folderRow = ctk.CTkFrame(body, fg_color="transparent")
        folderRow.pack(fill="x")
        self.folderName = ctk.StringVar()
        ctk.CTkEntry(
            folderRow, textvariable=self.folderName, height=fieldHeight, state="readonly",
            fg_color=bgColor, border_color=borderColor, text_color=textColor, corner_radius=7,
            font=ctk.CTkFont(family="Consolas", size=12),
        ).pack(side="left", fill="x", expand=True)
        self.copyFolderButton = makeQuietButton(folderRow, "Copy", self.copyFolderName)
        self.copyFolderButton.pack(side="left", padx=(8, 0))
        makeQuietButton(folderRow, "📂 Open file", self.openFileLocation, width=104).pack(side="left", padx=(6, 0))

    def buildPreview(self):
        card = self.makeCard(1, "Preview")
        self.locationPreview = LocationPreview(card)
        self.locationPreview.pack(fill="x", padx=16, pady=(0, 8))
        self.preview = ctk.CTkTextbox(
            card, fg_color=bgColor, text_color=textColor, corner_radius=8, border_width=1,
            border_color=borderColor, font=ctk.CTkFont(family="Consolas", size=13), wrap="word",
        )
        self.preview.pack(fill="both", expand=True, padx=16, pady=(0, 10))

        # WhatsApp: press Send, or stop with everything ready so you press it yourself.
        self.whatsappSendSwitch = makeWhatsappSendSwitch(card, self.whatsappSendVar)
        self.whatsappSendSwitch.pack(anchor="e", padx=16, pady=(0, 8))

        buttonRow = ctk.CTkFrame(card, fg_color="transparent")
        buttonRow.pack(fill="x", padx=16, pady=(0, 14))
        self.copyButton = ctk.CTkButton(
            buttonRow, text="Copy to clipboard", height=36, corner_radius=8,
            fg_color=accentColor, font=ctk.CTkFont(size=13, weight="bold"), command=self.copyReport,
        )
        self.copyButton.pack(side="left", fill="x", expand=True, padx=(0, 8))
        makeQuietButton(buttonRow, "Clear", self.clearForm, width=80, height=36).pack(side="right")
        self.whatsappButton = makeWhatsappButton(buttonRow, self.shareWhatsapp)
        self.whatsappButton.pack(side="right", padx=(0, 8))
        # Keep what's filled in (status, grids, remarks...) without ending the ticket or sharing.
        self.saveButton = makeQuietButton(buttonRow, saveLabel, self.saveDraft, width=96, height=36)
        self.saveButton.pack(side="right", padx=(0, 8))
        self.updateSaveButton()

    def hasUnsavedChanges(self):
        """True when the form differs from the WO's record (or the WO isn't in Records yet)."""
        fields = self.reportFields()
        if not fields["wo"]:
            return False
        try:
            record = getRecord(fields["wo"])
        except Exception:
            record = None
        if not record:
            return True
        saved = lambda key: str(record.get(key) if record.get(key) is not None else "").strip()
        pairs = (("ticket", "ticketId"), ("eq3", "eq3"), ("eq6", "eq6"), ("total", "totalGrids"),
                 ("attempted", "attempted"), ("skipped", "skipped"), ("status", "status"), ("remarks", "remarks"))
        return any(fields[key] != saved(recordKey) for key, recordKey in pairs)

    def updateSaveButton(self):
        if hasattr(self, "saveButton"):
            setSaveEnabled(self.saveButton, self.hasUnsavedChanges())

    def saveDraft(self):
        wo = self.getValue("wo")
        if not wo:
            self.lookupMessage.configure(text="Enter the WO first, then Save.", text_color=redColor)
            return
        fields = self.reportFields()
        self.saveReport(event=f"End: saved {fields['status']} · grids {fields['total']} / attempted "
                              f"{fields['attempted']} / skipped {fields['skipped']} (not ended)")
        self.loadedWoKey = woKey(wo)
        try:
            isEnded = bool((getRecord(wo) or {}).get("endedAt"))
        except Exception:
            isEnded = False
        self.lookupMessage.configure(
            text=f"Saved to Records: {fields['status']}, {fields['total']} grid(s), attempted {fields['attempted']}, "
                 f"skipped {fields['skipped']}."
                 + ("" if isEnded else " The ticket stays open - end it whenever you're ready."),
            text_color=greenColor)
        flashSaved(self.saveButton, self.hasUnsavedChanges)
        recordsChanged(self)

    def shareWhatsapp(self):
        """The renamed CSV + this report, to the WhatsApp group from .env. Sends only if the switch is on."""
        self.saveReport()
        shareTicket(self, self.whatsappButton, self.getValue("wo"), self.buildReport(), self.gridFilePath,
                    lambda text, color: self.lookupMessage.configure(text=text, text_color=color),
                    send=self.whatsappSendVar.get())

    def bindShortcuts(self):
        # Only while this page is showing.
        self.winfo_toplevel().bind(
            "<Control-Return>", lambda _: self.copyReport() if self.winfo_ismapped() else None, add="+")

    # ---------- today's open tickets ----------
    def onShow(self):
        self.refreshOpenTickets()
        self.updateSaveButton()

    def refreshOpenTickets(self):
        try:
            records = openTicketsToday()
        except Exception:
            records = []
        self.openTicketMap = {}
        for record in records:
            label = record["wo"] + (f"   ·   {record['ticketId']}" if record.get("ticketId") else "")
            self.openTicketMap[label] = record
        if self.openTicketMap:
            self.openTicketsMenu.configure(values=list(self.openTicketMap), state="normal")
            self.openTicketsMenu.set(f"▾ Today's open ({len(self.openTicketMap)})")
        else:
            self.openTicketsMenu.configure(values=["No open tickets today"], state="disabled")
            self.openTicketsMenu.set("None open today")

    def onPickOpenTicket(self, label):
        record = self.openTicketMap.get(label)
        if record and not self.isLookupBusy:
            self.prefill(record["wo"], record.get("ticketId"))
            self.lookupMessage.configure(
                text=f"Picked from today's open tickets. Press Enter in WO (or {self.findButton.cget('text').strip()}) "
                     "to continue.",
                text_color=accentColor)
        self.refreshOpenTickets()  # back to the "Today's open (n)" label

    # ---------- coming from Start Ticket / Records ----------
    def prefill(self, wo, ticketId=None):
        self.clearForm()
        self.fieldVars["wo"].set(wo)
        record = getRecord(wo) or {}
        self.fieldVars["ticket"].set(ticketId or record.get("ticketId") or "")
        for key in ("eq3", "eq6"):
            self.fieldVars[key].set(record.get(key) or "")
        self.gridFilePath = record.get("gridSummaryPath")
        self.lookupMessage.configure(
            text=f"Carried over. Press Enter in WO (or {self.findButton.cget('text').strip()}) to continue.",
            text_color=accentColor)

    # ---------- ticket lookup ----------
    def findTicket(self):
        wo = self.getValue("wo")
        if not wo:
            self.lookupMessage.configure(text="Enter a WO first.", text_color=redColor)
            return
        if self.isLookupBusy:
            return
        self.isLookupBusy = True
        resetStop()
        self.doneButton.pack_forget()
        showStopButton(self.stopButton)
        self.clearButton.configure(state="disabled")
        isLocal = isLocalStart(getRecord(wo))
        self.findButton.configure(state="disabled", text="Working…" if isLocal else "Searching…")
        self.lookupMessage.configure(
            text="Local start: copying GridSummary and uploading…" if isLocal
            else "Searching TechInsights in your Chrome…", text_color=mutedColor)
        threading.Thread(target=self.lookupWorker, args=(wo,), daemon=True).start()
        self.after(150, self.pollLookup)

    def lookupWorker(self, wo):
        """Find + verify the ticket ID, copy GridSummary, then upload. Runs off the UI thread."""
        post = self.lookupResults.put
        startRecord = getRecord(wo) or {}
        # The ticket Start Ticket saved: TechInsights is searched for exactly that one, so an
        # older ticket for the same WO is never used.
        startId = startRecord.get("startTicketId")
        if isLocalStart(startRecord):
            # Local start: there's no TechInsights ticket to look up - its ID is "LM_N_MMDDYYYY".
            ticketId = startRecord.get("ticketId") or startId
            check = f"Local start {ticketId} - no ticket lookup"
            verified = False
        else:
            try:
                ticketId = lookupTicketId(wo, expectedId=startId)
            except Exception as error:  # shown to the user in the status line
                if startId:
                    safeSave(wo, event=f"End: Ticket {startId} not found in TechInsights - stopped")
                post(("error", str(error) or error.__class__.__name__))
                return

            # Check 2 of 2: the ticket TechInsights shows must be the one Start Ticket made.
            if startId and startId != ticketId:
                safeSave(wo, event=f"End: ticket ID mismatch (Start {startId}, TechInsights {ticketId}) - stopped")
                post(("error", f"Ticket ID check failed: Start Ticket saved {startId}, but TechInsights shows "
                               f"{ticketId} for this WO. Stopped before uploading - check which one is right."))
                return
            check = (f"Ticket ID {ticketId} matches Start Ticket ✓" if startId
                     else f"Found Ticket ID {ticketId} (no Start Ticket record to check against)")
            verified = bool(startId)
        post(("ticket", ticketId))
        post(("progress", check))

        summaries, errors = [check], []
        saveError = safeSave(wo, event=f"End: {check}", ticketId=ticketId, endTicketId=ticketId,
                             ticketVerified=verified, folderName=buildFolderName(wo))
        if saveError:
            errors.append(saveError)

        # GridSummary copy; if it fails, say so but still do the uploads.
        post(("progress", f"{check}. Copying {gridSummaryFile}…"))
        try:
            copied, wasAlreadyThere = copyGridSummary(wo)
            post(("gridFile", str(copied)))
            summaries.append(f"GridSummary {'copy already there' if wasAlreadyThere else 'copied'}: {copied.name}")
            safeSave(wo, gridSummaryPath=str(copied))
        except Exception as error:
            errors.append(f"GridSummary: {error}")

        # EQs with a saved Job ID (from an earlier run, or typed in by hand) are not uploaded again.
        record = getRecord(wo) or {}
        alreadyDone = {equipment: record[equipment.lower()] for equipment in equipments
                       if record.get(equipment.lower())}

        def onResult(equipment, jobId):
            # Saved the moment it arrives, so a later failure (e.g. EQ6) can't lose EQ3.
            safeSave(wo, event=f"End: {equipment} uploaded, Job ID {jobId}", **{equipment.lower(): jobId})
            post(("jobIds", {equipment: jobId}))

        def onTab(token):
            # Remember the EQ tab so Done can close it (it stays open until then).
            if token:
                tokens = (getRecord(wo) or {}).get("eqTabTokens") or []
                safeSave(wo, eqTabTokens=tokens + [token])

        try:
            uploadSummaries, uploadErrors, jobIds = prepareAllUploads(
                wo, onProgress=lambda text: post(("progress", f"{check}. {text}")),
                onResult=onResult, onTab=onTab, alreadyDone=alreadyDone)
        except Exception as error:
            post(("error", "\n".join(summaries + errors + [f"ActixOne: {error}"])))
            return
        post(("jobIds", jobIds))
        allUploaded = not uploadErrors and all(jobIds.get(equipment) for equipment in equipments)
        safeSave(wo, event=f"End: uploads {'done' if allUploaded else 'with problems - rerun to finish'}",
                 uploadNotes=uploadSummaries + uploadErrors,
                 **({"endedAt": now()} if allUploaded else {}))
        report = "\n".join(summaries + uploadSummaries + errors + uploadErrors)
        post(("error" if errors or uploadErrors else "finished", report))

    def pollLookup(self):
        isFinished = False
        while True:
            try:
                kind, value = self.lookupResults.get_nowait()
            except queue.Empty:
                break
            if kind == "ticket":
                self.fieldVars["ticket"].set(value)
            elif kind == "progress":
                self.lookupMessage.configure(text=value, text_color=mutedColor)
            elif kind == "gridFile":
                self.gridFilePath = value
            elif kind == "jobIds":
                # {"EQ3": "AJO-TX-..."} -> the EQ3 / EQ6 fields
                for equipment, jobId in value.items():
                    if equipment.lower() in self.fieldVars:
                        self.fieldVars[equipment.lower()].set(jobId)
            elif kind == "finished":
                self.lookupMessage.configure(text=value, text_color=greenColor)
                isFinished = True
            else:
                self.lookupMessage.configure(text=value, text_color=redColor)
                isFinished = True
        if not isFinished:
            self.after(150, self.pollLookup)
            return
        self.isLookupBusy = False
        self.stopButton.pack_forget()
        self.findButton.configure(state="normal")
        self.updateFindButton()
        self.clearButton.configure(state="normal")
        self.saveReport()
        self.doneButton.pack(side="right")
        self.refreshOpenTickets()
        recordsChanged(self)
        bringToFront(self)

    # ---------- report ----------
    def onWoChange(self):
        """Accepts a WO (pasted 'Cloud WO - ' / 'WO:' is stripped), a grid key or a Ticket ID."""
        raw = self.fieldVars["wo"].get()
        cleaned, record, matchedBy = (resolveWorkOrder(raw) if not self.isLookupBusy
                                      else (cleanWorkOrder(raw), None, None))
        if cleaned != raw:
            # Tk doesn't re-run its change handlers for a change made inside one, so carry on here.
            self.fieldVars["wo"].set(cleaned)
            self.entries["wo"].icursor("end")
            self.updatePreview()
        self.loadSavedInfo(cleaned)
        if not self.isLookupBusy:
            self.updateFindButton()
        if hasattr(self, "locationPreview"):
            self.locationPreview.show(cleaned, record)
        if matchedBy in matchedByNames:
            self.lookupMessage.configure(
                text=f"{matchedByNames[matchedBy]} {raw.strip()} matched this WO. Saved info loaded.",
                text_color=accentColor)

    def updateFindButton(self):
        """Local start: nothing to find in TechInsights, the button just uploads."""
        try:
            isLocal = isLocalStart(getRecord(self.getValue("wo")))
        except Exception:
            isLocal = False
        self.findButton.configure(text="⬆  Upload" if isLocal else "Find in Chrome")

    def loadSavedInfo(self, wo):
        """A WO that's in Records (typed, pasted or picked): fill in what we already know,
        without overwriting anything you typed."""
        if self.isLookupBusy or not wo or woKey(wo) == getattr(self, "loadedWoKey", None):
            return
        try:
            record = getRecord(wo)
        except Exception:
            record = None
        if not record:
            return
        self.loadedWoKey = woKey(wo)
        filled = []
        for key, recordKey, label in (("ticket", "ticketId", "Ticket ID"), ("eq3", "eq3", "EQ3"), ("eq6", "eq6", "EQ6")):
            if record.get(recordKey) and not self.getValue(key):
                self.fieldVars[key].set(record[recordKey])
                filled.append(label)
        if record.get("gridSummaryPath"):
            self.gridFilePath = record["gridSummaryPath"]
        filled += self.loadSavedStatus(record)
        if filled:
            self.lookupMessage.configure(text=f"Loaded from Records: {', '.join(filled)}.", text_color=accentColor)

    def loadSavedStatus(self, record):
        """Status, grids and remarks saved earlier (Save, Records, or a previous run) come back."""
        filled = []
        for key, recordKey in (("total", "totalGrids"), ("attempted", "attempted"), ("skipped", "skipped")):
            value = str(record.get(recordKey) if record.get(recordKey) is not None else "").strip()
            if value:
                self.fieldVars[key].set(value)
                filled.append("grids") if "grids" not in filled else None
        if record.get("status") in statusOptions:
            self.status.set(record["status"])
            self.onStatusChange()
            filled.append("status")
        if record.get("remarks") and not self.remarks.get("1.0", "end").strip():
            self.remarks.insert("1.0", record["remarks"])
            self.updatePreview()
            filled.append("remarks")
        return filled

    def saveEqIds(self):
        """Save the EQ3 / EQ6 Job IDs as typed, so End Ticket uses them and won't upload those again."""
        wo = self.getValue("wo")
        if not wo:
            self.lookupMessage.configure(text="Enter the WO first, then save its EQ Job IDs.", text_color=redColor)
            return
        typed = {equipment: self.getValue(equipment.lower()) for equipment in equipments
                 if equipment.lower() in self.fieldVars and self.getValue(equipment.lower())}
        if not typed:
            self.lookupMessage.configure(text="Type an EQ3 or EQ6 Job ID first.", text_color=redColor)
            return
        saveError = safeSave(wo, event=f"End: {', '.join(typed)} Job ID saved by hand",
                             **{equipment.lower(): jobId for equipment, jobId in typed.items()})
        if saveError:
            self.lookupMessage.configure(text=saveError, text_color=redColor)
            return
        self.lookupMessage.configure(
            text=f"Saved {', '.join(f'{equipment} {jobId}' for equipment, jobId in typed.items())}. "
                 "A rerun won't upload these again.", text_color=greenColor)
        flashCopied(self.saveEqButton, "💾 Save", fieldColor)
        self.updateSaveButton()
        recordsChanged(self)

    def copyFolderName(self):
        copyText(self, self.folderName.get())
        flashCopied(self.copyFolderButton, "Copy", fieldColor)

    def openFileLocation(self):
        wo = self.getValue("wo")
        if not wo:
            self.lookupMessage.configure(text="Enter a WO first.", text_color=redColor)
            return
        try:
            opened = showInExplorer(wo, self.gridFilePath)
            self.lookupMessage.configure(text=f"Opened {opened}", text_color=mutedColor)
        except Exception as error:
            self.lookupMessage.configure(text=f"Couldn't open the file: {error}", text_color=redColor)

    def onToggle(self, key, value):
        """Attempted and skipped are opposites: one grid is either attempted or skipped."""
        other = "skipped" if key == "attempted" else "attempted"
        self.fieldVars[other].set("0" if value == "1" else "1")

    def onStatusChange(self, refresh=True):
        color = statusColors.get(self.status.get(), accentColor)
        self.statusButton.configure(selected_color=color, selected_hover_color=color)
        if refresh:
            self.updatePreview()

    def getValue(self, key):
        return self.fieldVars[key].get().strip()

    def reportFields(self):
        return {
            "wo": self.getValue("wo"), "ticket": self.getValue("ticket"),
            "eq3": self.getValue("eq3"), "eq6": self.getValue("eq6"),
            "total": self.getValue("total"), "attempted": self.getValue("attempted"),
            "skipped": self.getValue("skipped"), "status": self.status.get(),
            "remarks": self.remarks.get("1.0", "end").strip(),
        }

    def buildReport(self):
        return formatReport(self.reportFields())

    def saveReport(self, event=None, **extra):
        """Keep the report and its fields in tickets.json (only when there's a WO)."""
        fields = self.reportFields()
        if not fields["wo"]:
            return
        safeSave(fields["wo"], event=event, **extra, report=self.buildReport(), ticketId=fields["ticket"] or None,
                 eq3=fields["eq3"] or None, eq6=fields["eq6"] or None, totalGrids=fields["total"],
                 attempted=fields["attempted"], skipped=fields["skipped"], status=fields["status"],
                 remarks=fields["remarks"], folderName=buildFolderName(fields["wo"]))
        self.updateSaveButton()

    def updatePreview(self):
        if not hasattr(self, "preview"):
            return
        wo = self.getValue("wo")
        self.folderName.set(buildFolderName(wo) if wo else "")
        self.preview.configure(state="normal")
        self.preview.delete("1.0", "end")
        self.preview.insert("1.0", self.buildReport())
        self.preview.configure(state="disabled")
        self.updateSaveButton()

    def copyReport(self):
        copyText(self, self.buildReport())
        self.saveReport()
        flashCopied(self.copyButton, "Copy to clipboard", accentColor)

    def clearForm(self):
        for key, fieldVar in self.fieldVars.items():
            fieldVar.set("")
        self.fieldVars["total"].set(defaultTotalGrids)
        self.fieldVars["attempted"].set(defaultAttempted)
        self.fieldVars["skipped"].set(defaultSkipped)
        self.remarks.delete("1.0", "end")
        self.status.set(defaultStatus)
        self.onStatusChange()
        self.gridFilePath = None
        self.loadedWoKey = None  # so the next WO loads its saved info again
        self.lookupMessage.configure(
            text="Type the WO and press Enter to look up the Ticket ID.", text_color=mutedColor)


class StartTicketPage(ctk.CTkFrame):
    """WO in, then start it: a cloud start creates the TechInsights ticket (once a day); a local
    start just marks the WO as started, with "LM_N_MMDDYYYY" as its Ticket ID (N from 2; the
    cloud ticket is 1)."""

    cloudLabel = "☁  Cloud"
    localLabel = "💻  Local"

    def __init__(self, master, onBack, onGoToEnd):
        super().__init__(master, fg_color=bgColor)
        self.onBack = onBack
        self.onGoToEnd = onGoToEnd
        self.results = queue.Queue()
        self.isBusy = False
        self.lastWo = ""

        header, self.doneButton, self.clearButton = makePageHeader(
            self, "Start Ticket", "Cloud start once a day (real ticket), local start for the rest",
            accentColor, onBack=onBack, onDone=self.finishAndGoHome, onClear=self.clearForNext)
        header.pack(fill="x", padx=20, pady=(12, 2))
        self.stopButton = makeStopButton(header, lambda: pressStop(
            self.stopButton, lambda text, color: self.message.configure(text=text, text_color=color)))

        card = ctk.CTkFrame(self, fg_color=cardColor, corner_radius=12, border_width=1, border_color=borderColor)
        card.pack(fill="x", padx=20, pady=(10, 12))
        ctk.CTkFrame(card, height=4, corner_radius=2, fg_color=accentColor).pack(fill="x", padx=18, pady=(14, 0))
        body = ctk.CTkFrame(card, fg_color="transparent")
        body.pack(fill="x", padx=18, pady=(12, 16))

        # Cloud = creates the day's real ticket (once a day). Local = no ticket, "LM_N_MMDDYYYY".
        modeRow = ctk.CTkFrame(body, fg_color="transparent")
        modeRow.pack(fill="x", pady=(0, 12))
        self.modeVar = ctk.StringVar(value=self.localLabel)
        self.modeButton = ctk.CTkSegmentedButton(
            modeRow, values=[self.cloudLabel, self.localLabel], variable=self.modeVar, height=34,
            font=smallFont("bold"), command=lambda _: self.onModeChange(),
            fg_color=fieldColor, unselected_color=fieldColor, unselected_hover_color=borderColor,
            selected_color=accentColor, selected_hover_color=accentColor)
        self.modeButton.pack(side="left")
        self.modeNote = ctk.CTkLabel(modeRow, text="", text_color=mutedColor, font=smallFont(),
                                     anchor="w", justify="left")
        self.modeNote.pack(side="left", padx=(14, 0), fill="x", expand=True)

        labelRow = ctk.CTkFrame(body, fg_color="transparent")
        labelRow.pack(fill="x", pady=(0, 4))
        ctk.CTkLabel(labelRow, text="WO", text_color=mutedColor, font=smallFont(), height=18).pack(
            side="left", anchor="s")
        makeQuietButton(labelRow, "📥  Import Excel", self.importSheet, width=130, height=28).pack(side="right")
        # Imported WOs not started yet: pick one instead of pasting.
        self.waitingMap = {}
        self.waitingMenu = ctk.CTkOptionMenu(
            labelRow, values=["-"], width=320, height=28, corner_radius=7, dynamic_resizing=False,
            command=self.onPickWaiting, fg_color=fieldColor, button_color=borderColor,
            button_hover_color=accentColor, text_color=amberColor, font=smallFont("bold"),
            dropdown_fg_color=cardColor, dropdown_hover_color=selectedColor, dropdown_text_color=textColor,
            dropdown_font=ctk.CTkFont(size=12),
        )
        self.waitingMenu.pack(side="right", padx=(0, 8))
        woRow = ctk.CTkFrame(body, fg_color="transparent")
        woRow.pack(fill="x")
        self.woVar = ctk.StringVar()
        self.woVar.trace_add("write", lambda *_: self.onWoChange())
        self.woEntry = ctk.CTkEntry(
            woRow, textvariable=self.woVar, placeholder_text="SO-LM-HN-02-3_G23d_2U_102126_NOKIA",
            height=fieldHeight + 6, fg_color=fieldColor, border_color=borderColor, text_color=textColor,
            corner_radius=8, font=ctk.CTkFont(size=14),
        )
        self.woEntry.pack(side="left", fill="x", expand=True)
        addPlaceholder(self.woEntry, self.woVar, "Paste a WO or grid key, or pick one from To start")
        self.woEntry.bind("<Return>", lambda _: self.startTicket())
        self.copyWoButton = makeCopyWoButton(woRow, self.woVar, height=fieldHeight + 6)
        self.copyWoButton.pack(side="left", padx=(8, 0))
        self.startButton = ctk.CTkButton(
            woRow, text="🚀  Start", height=fieldHeight + 6, width=120, corner_radius=8,
            fg_color=accentColor, font=ctk.CTkFont(size=14, weight="bold"), command=self.startTicket,
        )
        self.startButton.pack(side="left", padx=(8, 0))

        # Only for a cloud start (it fills the TechInsights form); hidden for a local start.
        self.cloudOptions = ctk.CTkFrame(body, fg_color="transparent")
        self.cloudOptions.pack(fill="x")
        chips = ctk.CTkFrame(self.cloudOptions, fg_color="transparent")
        chips.pack(fill="x", pady=(10, 0))
        ctk.CTkLabel(chips, text="Also fills", text_color=mutedColor, font=smallFont()).pack(side="left", padx=(0, 8))
        for name, value in [("Region", defaultRegion), ("Market", defaultMarket),
                            ("Logs prev. day", defaultLogsUploadedPreviousDay)]:
            ctk.CTkLabel(
                chips, text=f"{name}: {value}", text_color=textColor, font=smallFont("bold"),
                fg_color=fieldColor, corner_radius=12, height=24, padx=10,
            ).pack(side="left", padx=(0, 6))
        # AM / PM depends on the time, so this chip keeps itself up to date.
        self.shiftChip = ctk.CTkLabel(chips, text="", text_color=textColor, font=smallFont("bold"),
                                      fg_color=fieldColor, corner_radius=12, height=24, padx=10)
        self.shiftChip.pack(side="left", padx=(0, 6))
        self.updateShiftChip()

        self.submitVar = ctk.BooleanVar(value=defaultSubmit)
        self.submitSwitch = ctk.CTkSwitch(
            self.cloudOptions, text="", variable=self.submitVar, command=self.onSubmitToggle,
            progress_color=greenColor, button_color=textColor, button_hover_color=textColor,
            fg_color=borderColor, switch_width=44, switch_height=22, font=smallFont("bold"),
            text_color=textColor,
        )
        self.submitSwitch.pack(anchor="w", pady=(14, 0))
        self.onSubmitToggle()

        self.message = ctk.CTkLabel(
            body, text="", text_color=mutedColor, font=ctk.CTkFont(size=12),
            anchor="w", justify="left", wraplength=880,
        )
        self.message.pack(fill="x", pady=(12, 0))

        # ---------- WO / Grid Key / Location preview ----------
        previewCard = ctk.CTkFrame(self, fg_color=cardColor, corner_radius=12, border_width=1,
                                   border_color=borderColor)
        previewCard.pack(fill="x", padx=20, pady=(0, 12))
        previewBody = ctk.CTkFrame(previewCard, fg_color="transparent")
        previewBody.pack(fill="x", padx=18, pady=12)
        previewTop = ctk.CTkFrame(previewBody, fg_color="transparent")
        previewTop.pack(fill="x")
        ctk.CTkLabel(previewTop, text="Preview", text_color=textColor,
                     font=ctk.CTkFont(size=14, weight="bold")).pack(side="left")
        self.previewRecord = None
        self.copyPreviewButton = makeQuietButton(previewTop, "Copy", self.copyStartPreview, width=62, height=28)
        self.copyPreviewButton.pack(side="right")
        self.navigateButton = makeIconButton(previewTop, navigateIcon, lambda: sendLocation(
            self, self.navigateButton, self.previewRecord,
            lambda text, color: self.message.configure(text=text, text_color=color)))
        self.navigateButton.pack(side="right", padx=(0, 6))
        self.startPreview = ctk.CTkTextbox(
            previewBody, height=74, fg_color=bgColor, text_color=textColor, corner_radius=8, border_width=1,
            border_color=borderColor, font=ctk.CTkFont(family="Consolas", size=13), wrap="none",
        )
        self.startPreview.pack(fill="x", pady=(6, 0))

        # ---------- result card ----------
        result = ctk.CTkFrame(self, fg_color=cardColor, corner_radius=12, border_width=1, border_color=borderColor)
        result.pack(fill="x", padx=20, pady=(0, 16))
        resultBody = ctk.CTkFrame(result, fg_color="transparent")
        resultBody.pack(fill="x", padx=18, pady=16)
        ctk.CTkLabel(resultBody, text="Ticket ID  (real ID for a cloud start, LM_N_date for a local start - blank on WhatsApp)",
                     text_color=mutedColor, font=smallFont()).pack(anchor="w")
        ticketRow = ctk.CTkFrame(resultBody, fg_color="transparent")
        ticketRow.pack(fill="x", pady=(4, 0))
        self.ticketVar = ctk.StringVar()
        ctk.CTkEntry(
            ticketRow, textvariable=self.ticketVar, state="readonly", width=200, height=44,
            fg_color=bgColor, border_color=borderColor, text_color=greenColor, corner_radius=8,
            font=ctk.CTkFont(family="Consolas", size=22, weight="bold"),
        ).pack(side="left")
        self.copyTicketButton = makeQuietButton(ticketRow, "Copy", self.copyTicketId, height=44)
        self.copyTicketButton.pack(side="left", padx=(8, 0))
        self.goToEndButton = ctk.CTkButton(
            ticketRow, text="Go to End Ticket  →", height=44, width=190, corner_radius=8,
            fg_color=greenColor, hover_color=greenHoverColor, text_color=darkTextColor,
            font=ctk.CTkFont(size=14, weight="bold"), command=self.goToEnd,
        )  # shown when a run finishes
        self.pickDefaultMode()
        self.refreshWaiting()
        self.updateStartPreview()

    # ---------- cloud / local ----------
    def isLocalMode(self):
        return self.modeVar.get() == self.localLabel

    def pickDefaultMode(self):
        """Cloud until today's cloud start is done, local after that."""
        try:
            cloud = cloudStartToday()
        except Exception:
            cloud = None
        self.modeVar.set(self.localLabel if cloud else self.cloudLabel)
        self.onModeChange()

    def onModeChange(self):
        try:
            cloud, nextNumber = cloudStartToday(), nextLocalNumber()
        except Exception:
            cloud, nextNumber = None, 1
        cloudText = (f"Today's cloud start: {cloud.get('cluster') or cloud['wo']} · {cloud.get('ticketId') or '—'}"
                     if cloud else "No cloud start yet today")
        if self.isLocalMode():
            self.cloudOptions.pack_forget()
            self.startButton.configure(text="💻  Start local")
            self.modeNote.configure(text=f"Next: {localTicketId(nextNumber)}   ·   {cloudText}", text_color=mutedColor)
        else:
            self.cloudOptions.pack(fill="x", before=self.message)
            self.startButton.configure(text="🚀  Start")
            self.modeNote.configure(
                text=(f"⚠ {cloudText}. Only one cloud start a day - use Local unless you need a new ticket."
                      if cloud else "First WO of the day: creates the real ticket in TechInsights"),
                text_color=amberColor if cloud else mutedColor)
        if not self.isBusy:
            self.resetMessage()

    # ---------- imported WOs ----------
    def onShow(self):
        self.refreshWaiting()
        self.updateStartPreview()
        if not self.isBusy and not self.ticketVar.get():
            self.pickDefaultMode()  # e.g. the cloud start was just done

    def refreshWaiting(self):
        try:
            records = notStartedRecords()
        except Exception:
            records = []
        self.waitingMap = {}
        for record in records:
            # Short and scannable: cluster + grid key (picking still fills the full WO).
            name = record.get("cluster") or record["wo"]
            label = f"{name}   ·   {record['gridKey']}" if record.get("gridKey") else name
            while label in self.waitingMap:  # keep every entry pickable
                label += " "
            self.waitingMap[label] = record
        if self.waitingMap:
            self.waitingMenu.configure(values=list(self.waitingMap), state="normal")
            self.waitingMenu.set(f"▾ To start ({len(self.waitingMap)})")
        else:
            self.waitingMenu.configure(values=["Nothing imported to start"], state="disabled")
            self.waitingMenu.set("No imported WOs to start")

    def onPickWaiting(self, label):
        record = self.waitingMap.get(label)
        if record and not self.isBusy:
            self.woVar.set(record["wo"])
            self.message.configure(text="Picked from your imported list. Press Start (or Enter).",
                                   text_color=accentColor)
            self.woEntry.focus_set()
        self.refreshWaiting()  # back to the "To start (n)" label

    def importSheet(self):
        if self.isBusy:
            return
        path = filedialog.askopenfilename(
            title="Import WOs from a sheet",
            filetypes=[("Excel or CSV", "*.xlsx *.xlsm *.csv"), ("All files", "*.*")])
        if not path:
            return
        try:
            # Columns are found by their values (headers only a hint); only your team's rows.
            rows, notes = readSheet(path, team=employeeId)
            added, updated, alreadyStarted = importWorkOrders(rows, Path(path).name)
        except Exception as error:
            self.message.configure(text=f"Couldn't import {Path(path).name}: {error}", text_color=redColor)
            return
        parts = [f"Imported {len(rows)} WOs from {Path(path).name}", f"{added} new"]
        if updated:
            parts.append(f"{updated} already in Records")
        if alreadyStarted:
            parts.append(f"{alreadyStarted} already started")
        text = " · ".join(parts) + ". Pick one from ▾ To start."
        if notes:  # anything unusual in the sheet, one line each
            text += "\n" + "\n".join(f"• {note}" for note in notes)
        self.message.configure(text=text, text_color=amberColor if notes else greenColor)
        self.refreshWaiting()
        self.updateStartPreview()
        recordsChanged(self)

    # ---------- preview ----------
    def updateStartPreview(self):
        if not hasattr(self, "startPreview"):
            return
        wo = self.woVar.get().strip()
        try:
            record = getRecord(wo) if wo else None
        except Exception:
            record = None
        self.startPreview.configure(state="normal")
        self.startPreview.delete("1.0", "end")
        self.startPreview.insert("1.0", formatLocationPreview(wo, record))
        self.startPreview.configure(state="disabled")
        self.previewRecord = record
        self.navigateButton.configure(state="normal" if hasLocation(record) else "disabled")
        # Pasted or typed a WO that's in the imported list: say so (once per WO).
        matchedKey = woKey(wo) if record and record.get("importedAt") else None
        if matchedKey and matchedKey != getattr(self, "matchedKey", None) and not self.isBusy:
            state = "already started" if record.get("startedAt") else "not started yet"
            cluster = f" ({record['cluster']})" if record.get("cluster") else ""
            self.message.configure(text=f"Found in your imported list{cluster}, {state}. Grid key and "
                                        "location loaded below.", text_color=accentColor)
        self.matchedKey = matchedKey

    def copyStartPreview(self):
        copyText(self, formatLocationPreview(self.woVar.get().strip(), getRecord(self.woVar.get().strip())))
        flashCopied(self.copyPreviewButton, "Copy", fieldColor)

    def onSubmitToggle(self):
        if self.submitVar.get():
            self.submitSwitch.configure(text="Submit: ON  -  clicks Create, then finds the new Ticket ID")
        else:
            self.submitSwitch.configure(text="Submit: OFF  -  only fills the form, you click Create")
        if hasattr(self, "message") and not self.isBusy:
            self.resetMessage()

    def resetMessage(self):
        if self.isLocalMode():
            text = ("Marks the WO as started today with an LM_N_date ID instead of a ticket. "
                    "No TechInsights, nothing opens in Chrome.")
        elif self.submitVar.get():
            text = "Creates the ticket in TechInsights and gets its ID. Saved to Records."
        else:
            text = "Opens Create Ticket in TechInsights and fills it. You click Create yourself."
        self.message.configure(text=text, text_color=mutedColor)

    def copyTicketId(self):
        if not self.ticketVar.get():
            return
        copyText(self, self.ticketVar.get())
        flashCopied(self.copyTicketButton, "Copy", fieldColor)

    def resetPage(self):
        self.doneButton.pack_forget()
        self.goToEndButton.pack_forget()
        self.woVar.set("")
        self.ticketVar.set("")
        self.submitVar.set(defaultSubmit)
        self.onSubmitToggle()
        self.pickDefaultMode()
        self.refreshWaiting()

    def updateShiftChip(self):
        pmFrom = datetime.combine(datetime.now().date(), driveShiftPmFrom)
        cutoff = pmFrom.strftime("%I:%M %p").lstrip("0")
        self.shiftChip.configure(text=f"Drive Shift: {currentDriveShift()}   (PM from {cutoff})")
        self.after(30000, self.updateShiftChip)  # flips by itself at the cutoff

    def clearForNext(self):
        """Empty the page for the next ticket, staying here."""
        if self.isBusy:
            return
        self.resetPage()
        self.woEntry.focus_set()

    def finishAndGoHome(self):
        self.resetPage()
        self.onBack()

    def goToEnd(self):
        wo, ticketId = self.lastWo, self.ticketVar.get()
        self.resetPage()
        self.onGoToEnd(wo, ticketId)

    def onWoChange(self):
        """Accepts a WO, a grid key or a Ticket ID; a known grid key / Ticket ID shows its WO."""
        raw = self.woVar.get()
        cleaned, record, matchedBy = (resolveWorkOrder(raw) if not self.isBusy
                                      else (cleanWorkOrder(raw), None, None))
        if cleaned != raw:
            # Tk doesn't re-run its change handlers for a change made inside one, so carry on here.
            self.woVar.set(cleaned)
            self.woEntry.icursor("end")
        self.updateStartPreview()
        if matchedBy in matchedByNames:
            state = "already started" if record.get("startedAt") else "not started yet"
            self.message.configure(
                text=f"{matchedByNames[matchedBy]} {raw.strip()} matched this WO ({state}).", text_color=accentColor)
            self.showsMatchNote = True
        elif getattr(self, "showsMatchNote", False) and not record and not self.isBusy:
            self.showsMatchNote = False
            self.resetMessage()  # don't leave an old "matched" note under something new

    def startTicket(self):
        wo = self.woVar.get().strip()
        if not wo:
            self.message.configure(text="Enter a WO first.", text_color=redColor)
            return
        if self.isBusy:
            return
        if self.isLocalMode():
            self.startLocalTicket(wo)
            return
        self.isBusy = True
        self.lastWo = wo
        self.ticketVar.set("")
        self.doneButton.pack_forget()
        self.goToEndButton.pack_forget()
        self.startButton.configure(state="disabled", text="Working…")
        self.modeButton.configure(state="disabled")
        self.submitSwitch.configure(state="disabled")
        self.clearButton.configure(state="disabled")
        resetStop()
        showStopButton(self.stopButton)
        self.message.configure(text="Opening TechInsights in your Chrome…", text_color=mutedColor)
        shift = currentDriveShift()  # decided now, at ticket creation
        threading.Thread(target=self.worker, args=(wo, self.submitVar.get(), shift), daemon=True).start()
        self.after(150, self.poll)

    def startLocalTicket(self, wo):
        """No TechInsights: save the WO as started with the next "LM_N_MMDDYYYY". Instant."""
        self.lastWo = wo
        record = getRecord(wo) or {}
        warning = ""
        if record.get("endedAt") and not (isLocalStart(record) and (record.get("startedAt") or "")[:10]
                                          == datetime.now().date().isoformat()):
            warning = f" Note: Records shows this WO was already completed {niceTime(record['endedAt'])}."
        try:
            saved, isNew = startLocal(
                wo, region=defaultRegion, market=defaultMarket, driveShift=currentDriveShift(),
                folderName=buildFolderName(wo))
        except Exception as error:
            self.message.configure(text=f"Couldn't save the local start: {error}", text_color=redColor)
            return
        ticketId = saved["ticketId"]
        self.ticketVar.set(ticketId)
        text = (f"Started locally as {ticketId}. No ticket created. End Ticket works as usual."
                if isNew else f"Already started locally today as {ticketId} - nothing changed.")
        self.message.configure(text=text + warning, text_color=greenColor if isNew else amberColor)
        self.doneButton.pack(side="right")
        self.goToEndButton.pack(side="right")
        self.refreshWaiting()
        self.onModeChange()  # the next LM number
        self.message.configure(text=text + warning, text_color=greenColor if isNew else amberColor)
        recordsChanged(self)

    def worker(self, wo, submit, shift, force=False):
        try:
            summary, ticketId, wasExisting = openCreateTicketForm(wo, submit=submit, shift=shift, force=force)
        except Exception as error:  # shown in the message line
            safeSave(wo, event=f"Start: failed - {error}")
            self.results.put((False, str(error) or error.__class__.__name__, None))
            return

        record = getRecord(wo) or {}
        if wasExisting:
            # Ask on the UI thread: use this ticket, or create a new one anyway.
            self.results.put(("ask", summary, ticketId))
            return

        if force:
            if not ticketId:
                self.results.put((True, summary + " (Records not changed - Create wasn't clicked.)", None))
                return
            # New ticket for a WO that had one: same WO details, new Ticket ID and today's date.
            oldId = record.get("ticketId")
            try:
                startNewTicket(
                    wo, event=f"Start: new ticket {ticketId} created (replaces {oldId or 'the existing one'})",
                    startedAt=now(), submitted=True, ticketId=ticketId, startTicketId=ticketId, startType="cloud",
                    region=defaultRegion, market=defaultMarket, driveShift=shift, folderName=buildFolderName(wo))
                summary += (f" Records now uses {ticketId}; {oldId} is kept under previous tickets."
                            if oldId else f" Records now uses {ticketId}.")
            except Exception as error:
                summary += f" Couldn't save to Records: {error}"
            self.results.put((True, summary, ticketId))
            return

        olderId = record.get("startTicketId")
        if ticketId and olderId and olderId != ticketId:
            summary += f" (Records had {olderId} for this WO before; now {ticketId}.)"
        saveError = safeSave(
            wo, event=f"Start: {'ticket created ' + ticketId if ticketId else 'form filled, Create not clicked'}",
            startedAt=now(), submitted=bool(ticketId), region=defaultRegion, market=defaultMarket,
            driveShift=shift, folderName=buildFolderName(wo), startType="cloud",
            **({"ticketId": ticketId, "startTicketId": ticketId} if ticketId else {}),
        )
        if saveError:
            summary += f" {saveError}"
        self.results.put((True, summary, ticketId))

    def useExistingTicket(self, wo, ticketId, summary):
        """Made outside the app (or earlier): record it as started today so End Ticket can pick it up."""
        record = getRecord(wo) or {}
        if record.get("endedAt"):
            summary += f" Note: Records shows this WO was already completed {niceTime(record['endedAt'])}."
        saveError = safeSave(
            wo, event=f"Start: ticket {ticketId} already existed in TechInsights - marked as started",
            startedAt=now(), submitted=True, ticketId=ticketId, startTicketId=ticketId, startType="cloud",
            folderName=buildFolderName(wo),
        )
        return summary + (f" {saveError}" if saveError else "")

    def askRecreate(self, wo, ticketId, summary):
        """The WO already has a ticket: create a new one anyway, or use it?"""
        bringToFront(self)
        createNew = messagebox.askyesno(
            "Ticket already exists",
            f"TechInsights already has Ticket {ticketId} for\n{wo}\n\n"
            "Create a NEW ticket anyway?\n\n"
            "Yes: create a new ticket. The WO's details (grid key, location…) stay; "
            "the new Ticket ID and today's date replace the old ones.\n"
            f"No: use the existing ticket {ticketId}.",
            icon="warning", parent=self)
        if createNew:
            safeSave(wo, event=f"Start: {ticketId} exists - you chose to create a new ticket")
            self.message.configure(text="Creating a new ticket in your Chrome…", text_color=mutedColor)
            threading.Thread(target=self.worker, args=(wo, self.submitVar.get(), currentDriveShift(), True),
                             daemon=True).start()
        else:
            self.results.put((True, self.useExistingTicket(wo, ticketId, summary), ticketId))
        self.after(150, self.poll)

    def poll(self):
        try:
            ok, text, ticketId = self.results.get_nowait()
        except queue.Empty:
            self.after(150, self.poll)
            return
        if ok == "ask":  # still busy: the answer decides what runs next
            self.askRecreate(self.lastWo, ticketId, text)
            return
        self.isBusy = False
        self.startButton.configure(state="normal")
        self.modeButton.configure(state="normal")
        self.submitSwitch.configure(state="normal")
        self.clearButton.configure(state="normal")
        self.stopButton.pack_forget()
        # Today's cloud ticket now exists -> switch to Local for the next WO (message is set just below).
        self.pickDefaultMode()
        if ticketId:
            self.ticketVar.set(ticketId)
        self.message.configure(text=text, text_color=greenColor if ok else redColor)
        self.doneButton.pack(side="right")
        if ok:
            self.goToEndButton.pack(side="right")
        self.refreshWaiting()  # a started WO leaves the "To start" list
        recordsChanged(self)
        bringToFront(self)


class RecordsPage(ctk.CTkFrame):
    """Everything saved in tickets.json: search, copy single values or the whole preview."""

    detailFields = [
        ("WO", "wo"), ("Ticket ID", "ticketId"), ("EQ3", "eq3"), ("EQ6", "eq6"),
        ("Grid key", "gridKey"), ("Location", "location"), ("Folder name", "folderName"),
    ]  # Status, grids and remarks are edited in "Update status" below these

    def __init__(self, master, onBack, onContinue, whatsappSendVar):
        super().__init__(master, fg_color=bgColor)
        self.onContinue = onContinue
        self.whatsappSendVar = whatsappSendVar  # shared with End Ticket
        self.selectedKey = None
        self.records = []
        self.searchJob = None
        self.listRows = {}
        self.checked = set()  # woKeys ticked for "Move to today"

        header, _, _ = makePageHeader(self, "Records", "Everything Start and End Ticket saved", purpleColor, onBack)
        header.pack(fill="x", padx=20, pady=(12, 2))

        searchRow = ctk.CTkFrame(self, fg_color="transparent")
        searchRow.pack(fill="x", padx=20, pady=(8, 8))
        self.searchVar = ctk.StringVar()
        self.searchVar.trace_add("write", lambda *_: self.scheduleRefresh())
        searchEntry = ctk.CTkEntry(
            searchRow, textvariable=self.searchVar, height=38, corner_radius=10,
            fg_color=fieldColor, border_color=borderColor, text_color=textColor, font=ctk.CTkFont(size=14),
        )
        searchEntry.pack(side="left", fill="x", expand=True)
        addPlaceholder(searchEntry, self.searchVar, "🔎  Search WO, Ticket ID, grid key or EQ3 / EQ6 Job ID…")
        self.countLabel = ctk.CTkLabel(searchRow, text="", text_color=mutedColor, font=smallFont())
        self.countLabel.pack(side="left", padx=(12, 0))
        self.moveButton = ctk.CTkButton(
            searchRow, text="📅 Move to today", height=34, width=150, corner_radius=8, fg_color=purpleColor,
            hover_color="#8b5cf6", text_color=darkTextColor, text_color_disabled=mutedColor,
            border_color=borderColor, font=smallFont("bold"), command=self.moveCheckedToToday)
        self.moveButton.pack(side="left", padx=(12, 0))
        makeWhatsappSendSwitch(searchRow, self.whatsappSendVar).pack(side="left", padx=(16, 0))

        content = ctk.CTkFrame(self, fg_color="transparent")
        content.pack(fill="both", expand=True, padx=20, pady=(0, 16))
        content.grid_columnconfigure(0, weight=0)
        content.grid_columnconfigure(1, weight=1)
        content.grid_rowconfigure(0, weight=1)

        self.listFrame = ctk.CTkScrollableFrame(content, width=330, fg_color=cardColor, corner_radius=12,
                                                border_width=1, border_color=borderColor)
        self.listFrame.grid(row=0, column=0, sticky="ns", padx=(0, 12))

        self.detail = ctk.CTkScrollableFrame(content, fg_color=cardColor, corner_radius=12, border_width=1,
                                             border_color=borderColor)
        self.detail.grid(row=0, column=1, sticky="nsew")

    def onShow(self):
        self.refresh()

    def scheduleRefresh(self):
        if self.searchJob:
            self.after_cancel(self.searchJob)
        self.searchJob = self.after(200, self.refresh)

    def refresh(self):
        self.searchJob = None
        try:
            self.records = searchRecords(self.searchVar.get())[:200]
        except Exception as error:
            self.records = []
            self.countLabel.configure(text=f"Couldn't read records: {error}")
        else:
            self.countLabel.configure(text=f"{len(self.records)} record{'s' if len(self.records) != 1 else ''}")

        # Newest day first; a small divider starts each day.
        self.records.sort(key=recordDay, reverse=True)
        for child in self.listFrame.winfo_children():
            child.destroy()
        self.listRows = {}
        if not self.records:
            ctk.CTkLabel(self.listFrame, text="No records yet." if not self.searchVar.get() else "No matches.",
                         text_color=mutedColor, font=smallFont()).pack(pady=20)
        lastDay = None
        for record in self.records:
            day = recordDay(record).date()
            if day != lastDay:
                lastDay = day
                count = sum(1 for other in self.records if recordDay(other).date() == day)
                self.addDayDivider(dayLabel(recordDay(record)), count)
            self.addListRow(record)

        keys = [woKey(record.get("wo")) for record in self.records]
        self.checked &= set(keys)  # forget ticks on records no longer listed
        self.updateMoveButton()
        self.select(self.selectedKey if self.selectedKey in keys else (keys[0] if keys else None))

    def addDayDivider(self, label, count):
        isToday = label == "TODAY"
        divider = ctk.CTkFrame(self.listFrame, fg_color="transparent")
        divider.pack(fill="x", padx=8, pady=(10, 2))
        ctk.CTkLabel(divider, text=f"{label}  ·  {count}", text_color=purpleColor if isToday else mutedColor,
                     font=ctk.CTkFont(size=11, weight="bold")).pack(side="left")
        ctk.CTkFrame(divider, height=1, fg_color=purpleColor if isToday else borderColor).pack(
            side="left", fill="x", expand=True, padx=(8, 0), pady=(2, 0))

    def addListRow(self, record):
        key = woKey(record.get("wo"))
        row = ctk.CTkFrame(self.listFrame, fg_color=fieldColor, corner_radius=10, border_width=1,
                           border_color=borderColor)
        row.pack(fill="x", padx=6, pady=4)
        titleRow = ctk.CTkFrame(row, fg_color="transparent")
        titleRow.pack(fill="x", padx=(10, 12), pady=(8, 0))
        checkVar = ctk.BooleanVar(value=key in self.checked)
        checkBox = ctk.CTkCheckBox(
            titleRow, text="", variable=checkVar, width=20, checkbox_width=18, checkbox_height=18,
            corner_radius=5, border_width=2, fg_color=purpleColor, hover_color="#8b5cf6",
            command=lambda: self.toggleChecked(key, checkVar.get()))
        checkBox.pack(side="left", padx=(0, 6))
        ctk.CTkLabel(titleRow, text=record.get("wo", ""), text_color=textColor, anchor="w",
                     font=ctk.CTkFont(size=12, weight="bold")).pack(side="left", fill="x", expand=True)
        eqMarks = "  ".join(f"{name} {'✓' if record.get(name.lower()) else '–'}" for name in ("EQ3", "EQ6"))
        status = record.get("status")
        startTag = {"cloud": "☁ Cloud   ", "local": "💻 Local   "}.get(record.get("startType"), "")
        line = f"{startTag}🎫 {record.get('ticketId') or '—'}   {eqMarks}"
        ctk.CTkLabel(row, text=line, text_color=mutedColor, anchor="w", font=smallFont()).pack(fill="x", padx=12)
        if record.get("gridKey"):  # for reference at a glance
            ctk.CTkLabel(row, text=f"🔑 {record['gridKey']}", text_color=textColor, anchor="w",
                         font=ctk.CTkFont(family="Consolas", size=11)).pack(fill="x", padx=12)
        footer = ctk.CTkFrame(row, fg_color="transparent")
        footer.pack(fill="x", padx=12, pady=(0, 8))
        if record.get("closedAt"):
            progress, progressColor = f"🔒 Closed {clockTime(record['closedAt'])}", greenColor
        elif record.get("endedAt"):
            progress, progressColor = f"✓ Completed {clockTime(record['endedAt'])}", greenColor
        elif record.get("startedAt"):
            progress, progressColor = f"In progress · started {clockTime(record['startedAt'])}", amberColor
        elif record.get("importedAt"):
            progress, progressColor = "Not started · imported", accentColor
        else:
            progress, progressColor = f"Updated {clockTime(record.get('updatedAt'))}", mutedColor
        ctk.CTkLabel(footer, text=progress, text_color=progressColor,
                     font=ctk.CTkFont(size=11)).pack(side="left")
        if status:
            ctk.CTkLabel(footer, text=status, text_color=statusColors.get(status, mutedColor),
                         font=ctk.CTkFont(size=11, weight="bold")).pack(side="right")
        makeWhatsappPill(footer, record).pack(side="right", padx=(0, 8))

        def bindAll(widget):
            if widget is checkBox:
                return  # ticking the box shouldn't also open the record
            widget.bind("<Button-1>", lambda _: self.select(key))
            widget.configure(cursor="hand2")
            for child in widget.winfo_children():
                bindAll(child)

        bindAll(row)
        self.listRows[key] = row

    def select(self, key):
        self.selectedKey = key
        for rowKey, row in self.listRows.items():
            isSelected = rowKey == key
            row.configure(fg_color=selectedColor if isSelected else fieldColor,
                          border_color=purpleColor if isSelected else borderColor)
        self.showDetail(next((r for r in self.records if woKey(r.get("wo")) == key), None))

    def showDetail(self, record):
        for child in self.detail.winfo_children():
            child.destroy()
        if not record:
            ctk.CTkLabel(self.detail, text="Pick a record on the left.", text_color=mutedColor,
                         font=smallFont()).pack(pady=40)
            return

        body = ctk.CTkFrame(self.detail, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=16, pady=14)

        verified = record.get("ticketVerified")
        if isLocalStart(record):
            badge = (f"💻 Local start · {record.get('ticketId')} (no TechInsights ticket)", accentColor)
        else:
            badge = ("☁ Cloud ticket verified ✓", greenColor) if verified else (
                ("Not verified yet", amberColor) if record.get("ticketId") else ("No ticket yet", mutedColor))
        top = ctk.CTkFrame(body, fg_color="transparent")
        top.pack(fill="x")
        ctk.CTkLabel(top, text=badge[0], text_color=badge[1], font=smallFont("bold")).pack(side="left")
        makeWhatsappPill(top, record).pack(side="left", padx=(10, 0))
        if record.get("whatsappSentAt"):
            ctk.CTkLabel(top, text=f"sent {niceTime(record['whatsappSentAt'])}", text_color=whatsappColor,
                         font=ctk.CTkFont(size=11)).pack(side="left", padx=(6, 0))
        else:
            ctk.CTkLabel(top, text="not sent yet", text_color=mutedColor,
                         font=ctk.CTkFont(size=11)).pack(side="left", padx=(6, 0))
        times = "   ".join(part for part in (
            f"Started {niceTime(record['startedAt'])}" if record.get("startedAt") else "",
            f"Completed {niceTime(record['endedAt'])}" if record.get("endedAt") else "In progress",
            f"🔒 Closed {niceTime(record['closedAt'])}" if record.get("closedAt") else "") if part)
        ctk.CTkButton(
            top, text="🗑  Delete", height=26, width=86, corner_radius=7, fg_color="transparent",
            hover_color="#3a1f1f", border_width=1, border_color=redColor, text_color=redColor,
            font=smallFont("bold"), command=lambda: self.deleteRecord(record),
        ).pack(side="right", padx=(10, 0))
        # Own line, so it never runs into the badges when the window is narrow.
        ctk.CTkLabel(body, text=times, text_color=greenColor if record.get("closedAt") else mutedColor,
                     font=ctk.CTkFont(size=11), anchor="w").pack(fill="x", pady=(2, 6))
        locationPreview = LocationPreview(body)
        locationPreview.pack(fill="x", pady=(0, 8))
        locationPreview.show(record.get("wo", ""), record)

        lat, lon = latLong(record)
        values = {**record, "location": f"{lat}, {lon}" if lat or lon else ""}
        for label, key in self.detailFields:
            value = str(values.get(key) or "")
            row = ctk.CTkFrame(body, fg_color="transparent")
            row.pack(fill="x", pady=2)
            ctk.CTkLabel(row, text=label, width=90, anchor="w", text_color=mutedColor, font=smallFont()).pack(side="left")
            valueVar = ctk.StringVar(value=value or "—")
            ctk.CTkEntry(row, textvariable=valueVar, state="readonly", height=28, corner_radius=6,
                         fg_color=bgColor, border_color=borderColor, text_color=textColor,
                         font=ctk.CTkFont(family="Consolas", size=12)).pack(side="left", fill="x", expand=True)
            button = makeQuietButton(row, "Copy", None, width=62, height=28)
            button.configure(command=lambda b=button, v=value: self.copyValue(b, v))
            if not value:
                button.configure(state="disabled")
            button.pack(side="left", padx=(6, 0))

        self.buildStatusEditor(body, record)

        # Not started yet: the Start Ticket preview (WO / Grid Key / Location) is what's useful.
        report = (reportFromRecord(record) if record.get("startedAt")
                  else formatLocationPreview(record.get("wo", ""), record))
        preview = ctk.CTkTextbox(body, height=150, fg_color=bgColor, text_color=textColor, corner_radius=8,
                                 border_width=1, border_color=borderColor,
                                 font=ctk.CTkFont(family="Consolas", size=12), wrap="word")
        preview.pack(fill="both", expand=True, pady=(10, 8))
        preview.insert("1.0", report)
        preview.configure(state="disabled")

        actions = ctk.CTkFrame(body, fg_color="transparent")
        actions.pack(fill="x")
        copyPreviewButton = ctk.CTkButton(
            actions, text="Copy preview", height=34, corner_radius=8, fg_color=accentColor,
            font=ctk.CTkFont(size=13, weight="bold"))
        copyPreviewButton.configure(command=lambda: (copyText(self, report),
                                                     flashCopied(copyPreviewButton, "Copy preview", accentColor)))
        copyPreviewButton.pack(side="left", fill="x", expand=True)
        makeQuietButton(actions, "📂 Open file", lambda: self.openFile(record), width=104, height=34).pack(
            side="left", padx=(6, 0))
        whatsappButton = makeWhatsappButton(actions, None, height=34)
        whatsappButton.configure(command=lambda: shareTicket(
            self, whatsappButton, record.get("wo", ""), report, record.get("gridSummaryPath"),
            lambda text, color: self.detailStatus.configure(text=text, text_color=color),
            send=self.whatsappSendVar.get()))
        whatsappButton.pack(side="left", padx=(6, 0))
        ctk.CTkButton(
            actions, text="End Ticket  →", height=34, width=200, corner_radius=8,
            fg_color=greenColor, hover_color=greenHoverColor, text_color=darkTextColor,
            font=ctk.CTkFont(size=13, weight="bold"),
            command=lambda: self.onContinue(record.get("wo", ""), record.get("ticketId")),
        ).pack(side="left", padx=(6, 0))

        self.detailStatus = ctk.CTkLabel(body, text="", text_color=mutedColor, font=smallFont(),
                                         anchor="w", justify="left", wraplength=560)
        self.detailStatus.pack(fill="x", pady=(6, 0))

        history = record.get("history") or []
        if history:
            lines = "\n".join(f"{niceTime(item.get('at'))}  ·  {item.get('event')}" for item in history[-4:])
            ctk.CTkLabel(body, text=lines, text_color=mutedColor, font=ctk.CTkFont(size=11),
                         anchor="w", justify="left", wraplength=560).pack(fill="x", pady=(10, 0))

    def buildStatusEditor(self, body, record):
        """Fix the status, grids or remarks later (e.g. forgot on the day): Save updates the
        record and its report. Doesn't end, close or share anything."""
        box = ctk.CTkFrame(body, fg_color=bgColor, corner_radius=10, border_width=1, border_color=borderColor)
        box.pack(fill="x", pady=(10, 0))
        inner = ctk.CTkFrame(box, fg_color="transparent")
        inner.pack(fill="x", padx=12, pady=10)
        ctk.CTkLabel(inner, text="Update status", text_color=textColor, font=smallFont("bold")).pack(anchor="w")

        def label(parent, text):
            ctk.CTkLabel(parent, text=text, text_color=mutedColor, font=smallFont(), height=18).pack(anchor="w")

        def toggle(parent, variable, command):
            return ctk.CTkSegmentedButton(
                parent, values=["0", "1"], variable=variable, height=fieldHeight, font=smallFont("bold"),
                command=command, fg_color=fieldColor, selected_color=accentColor,
                selected_hover_color=accentColor, unselected_color=fieldColor, unselected_hover_color=borderColor)

        grids = ctk.CTkFrame(inner, fg_color="transparent")
        grids.pack(fill="x", pady=(4, 0))
        grids.grid_columnconfigure((0, 1, 2), weight=1, uniform="g")
        saved = lambda key, default: str(record[key]) if record.get(key) not in (None, "") else default
        totalVar = ctk.StringVar(value=saved("totalGrids", defaultTotalGrids))
        attemptedVar = ctk.StringVar(value=saved("attempted", defaultAttempted))
        skippedVar = ctk.StringVar(value=saved("skipped", defaultSkipped))
        cell = ctk.CTkFrame(grids, fg_color="transparent")
        cell.grid(row=0, column=0, sticky="ew", padx=(0, 6))
        label(cell, "Total grids")
        ctk.CTkEntry(cell, textvariable=totalVar, height=fieldHeight, fg_color=fieldColor,
                     border_color=borderColor, text_color=textColor, corner_radius=7).pack(fill="x")
        # Like End Ticket: one grid is either attempted or skipped.
        cell = ctk.CTkFrame(grids, fg_color="transparent")
        cell.grid(row=0, column=1, sticky="ew", padx=6)
        label(cell, "Grids attempted")
        toggle(cell, attemptedVar, lambda v: skippedVar.set("0" if v == "1" else "1")).pack(fill="x")
        cell = ctk.CTkFrame(grids, fg_color="transparent")
        cell.grid(row=0, column=2, sticky="ew", padx=(6, 0))
        label(cell, "Grids skipped")
        toggle(cell, skippedVar, lambda v: attemptedVar.set("0" if v == "1" else "1")).pack(fill="x")

        label(inner, "Status")
        statusVar = ctk.StringVar(value=record.get("status") if record.get("status") in statusOptions else "")
        statusButton = ctk.CTkSegmentedButton(
            inner, values=statusOptions, variable=statusVar, height=fieldHeight, font=smallFont("bold"),
            fg_color=fieldColor, unselected_color=fieldColor, unselected_hover_color=borderColor)

        def colorStatus(_=None):
            color = statusColors.get(statusVar.get(), accentColor)
            statusButton.configure(selected_color=color, selected_hover_color=color)

        statusButton.configure(command=colorStatus)
        colorStatus()
        statusButton.pack(fill="x")

        label(inner, "Remarks (optional)")
        remarksBox = ctk.CTkTextbox(inner, height=48, fg_color=fieldColor, border_color=borderColor, border_width=2,
                                    text_color=textColor, corner_radius=7, wrap="word")
        remarksBox.pack(fill="x")
        if record.get("remarks"):
            remarksBox.insert("1.0", record["remarks"])

        saveRow = ctk.CTkFrame(inner, fg_color="transparent")
        saveRow.pack(fill="x", pady=(8, 0))
        saveButton = ctk.CTkButton(saveRow, text=saveLabel, height=32, width=120, corner_radius=8,
                                   fg_color=purpleColor, hover_color="#8b5cf6", text_color=darkTextColor,
                                   text_color_disabled=mutedColor, font=smallFont("bold"))
        saveButton.pack(side="right")
        note = ctk.CTkLabel(saveRow, text="Saves to Records only - nothing is ended, closed or shared.",
                            text_color=mutedColor, font=ctk.CTkFont(size=11), anchor="w")
        note.pack(side="left", fill="x", expand=True)

        # Save is only clickable once something differs from what's shown when the record opened.
        current = lambda: (totalVar.get().strip(), attemptedVar.get(), skippedVar.get(), statusVar.get(),
                           remarksBox.get("1.0", "end").strip())
        shown = current()

        def updateSave(*_):
            isChanged = current() != shown
            saveButton.configure(state="normal" if isChanged else "disabled",
                                 fg_color=purpleColor if isChanged else fieldColor)

        for variable in (totalVar, attemptedVar, skippedVar, statusVar):
            variable.trace_add("write", updateSave)
        remarksBox.bind("<KeyRelease>", updateSave)
        updateSave()

        def save():
            status, total = statusVar.get(), totalVar.get().strip()
            if not status:
                note.configure(text="Pick a status first.", text_color=redColor)
                return
            fields = {"totalGrids": total, "attempted": attemptedVar.get(), "skipped": skippedVar.get(),
                      "status": status, "remarks": remarksBox.get("1.0", "end").strip()}
            report = formatReport({
                "wo": record.get("wo"), "ticket": record.get("ticketId"), "eq3": record.get("eq3"),
                "eq6": record.get("eq6"), "total": total, "attempted": fields["attempted"],
                "skipped": fields["skipped"], "status": status, "remarks": fields["remarks"]})
            error = safeSave(record.get("wo", ""), event=f"Records: status updated to {status} · grids {total} / "
                             f"attempted {fields['attempted']} / skipped {fields['skipped']}", report=report, **fields)
            if error:
                note.configure(text=error, text_color=redColor)
                return
            self.refresh()  # list + detail show the new status and report
            self.detailStatus.configure(text=f"Saved: {status}, {total} grid(s), attempted {fields['attempted']}, "
                                             f"skipped {fields['skipped']}.", text_color=greenColor)
            recordsChanged(self)

        saveButton.configure(command=save)

    def toggleChecked(self, key, isChecked):
        if isChecked:
            self.checked.add(key)
        else:
            self.checked.discard(key)
        self.updateMoveButton()

    def updateMoveButton(self):
        count = len(self.checked)
        # Purple and clickable once something is ticked; a quiet outline until then.
        self.moveButton.configure(
            text=f"📅 Move {count} to today" if count else "📅 Tick records to move",
            state="normal" if count else "disabled",
            fg_color=purpleColor if count else fieldColor, border_width=0 if count else 1)

    def moveCheckedToToday(self):
        wos = [record.get("wo", "") for record in self.records if woKey(record.get("wo")) in self.checked]
        if not wos:
            return
        try:
            moved = moveToToday(wos)
        except Exception as error:
            self.countLabel.configure(text=f"Couldn't move: {error}")
            return
        self.checked.clear()
        self.refresh()
        self.countLabel.configure(text=f"Moved {moved} to today")
        recordsChanged(self)

    def deleteRecord(self, record):
        """Delete one record, after asking twice. A copy is kept in tickets.deleted.json."""
        wo = record.get("wo", "")
        if not messagebox.askyesno(
                "Delete record?",
                f"Delete the record for\n\n{wo}\n\nIts Ticket ID, EQ Job IDs, report and history will be "
                "removed from Records.", icon="warning", parent=self):
            return
        if not messagebox.askyesno(
                "Are you sure?",
                f"Really delete {wo}?\n\nA copy is kept in {ticketStoreFile.stem}.deleted.json, but it "
                "won't come back in the app by itself.", icon="warning", default=messagebox.NO, parent=self):
            return
        try:
            wasDeleted = deleteTicketRecord(wo)
        except Exception as error:
            self.countLabel.configure(text=f"Couldn't delete: {error}")
            return
        self.selectedKey = None
        self.refresh()
        self.countLabel.configure(text=f"Deleted {wo}" if wasDeleted else "It was already gone")
        recordsChanged(self)

    def copyValue(self, button, value):
        copyText(self, value)
        flashCopied(button, "Copy", fieldColor)

    def openFile(self, record):
        try:
            showInExplorer(record.get("wo", ""), record.get("gridSummaryPath"))
        except Exception as error:
            self.countLabel.configure(text=f"Couldn't open the file: {error}")


class CloseTicketPage(ctk.CTkFrame):
    """Close a PASSED ticket in TechInsights, one step at a time."""

    # (record field set when done, name, what it does) - more steps get added here.
    closeSteps = [
        ("closeStep1At", "Step 1", "Start Driving task → Completed (Save, then OK)"),
        ("closeStep2At", "Step 2", "Check Out: Route Completion Status → Completed, task → Completed"),
        ("closeStep3At", "Step 3", "Upload Collection: EQ3, EQ6, GridSummary CSV, grid counts → Completed, Save, OK"),
    ]

    def __init__(self, master, onBack):
        super().__init__(master, fg_color=bgColor)
        self.isBusy = False
        self.record = None
        self.readyMap = {}
        self.results = queue.Queue()

        header, self.doneButton, self.clearButton = makePageHeader(
            self, "Close Ticket", "Finish the day's PASSED cloud ticket in TechInsights", amberColor,
            onBack=onBack, onDone=lambda: (self.clearForNext(), onBack()), onClear=self.clearForNext)
        header.pack(fill="x", padx=20, pady=(12, 2))
        self.stopButton = makeStopButton(header, lambda: pressStop(self.stopButton, self.showMessage))

        card = ctk.CTkFrame(self, fg_color=cardColor, corner_radius=12, border_width=1, border_color=borderColor)
        card.pack(fill="x", padx=20, pady=(10, 12))
        ctk.CTkFrame(card, height=4, corner_radius=2, fg_color=amberColor).pack(fill="x", padx=18, pady=(14, 0))
        body = ctk.CTkFrame(card, fg_color="transparent")
        body.pack(fill="x", padx=18, pady=(12, 16))

        labelRow = ctk.CTkFrame(body, fg_color="transparent")
        labelRow.pack(fill="x", pady=(0, 4))
        ctk.CTkLabel(labelRow, text="WO (or grid key)", text_color=mutedColor, font=smallFont(), height=18).pack(
            side="left", anchor="s")
        self.readyMenu = ctk.CTkOptionMenu(
            labelRow, values=["-"], width=320, height=28, corner_radius=7, dynamic_resizing=False,
            command=self.onPickReady, fg_color=fieldColor, button_color=borderColor,
            button_hover_color=amberColor, text_color=amberColor, font=smallFont("bold"),
            dropdown_fg_color=cardColor, dropdown_hover_color=selectedColor, dropdown_text_color=textColor,
            dropdown_font=ctk.CTkFont(size=12),
        )
        self.readyMenu.pack(side="right")

        woRow = ctk.CTkFrame(body, fg_color="transparent")
        woRow.pack(fill="x")
        self.woVar = ctk.StringVar()
        self.woVar.trace_add("write", lambda *_: self.onWoChange())
        self.woEntry = ctk.CTkEntry(
            woRow, textvariable=self.woVar, placeholder_text="SO-HN_LM_121_G23e_2U_102826_Nokia",
            height=fieldHeight + 6, fg_color=fieldColor, border_color=borderColor, text_color=textColor,
            corner_radius=8, font=ctk.CTkFont(size=14),
        )
        self.woEntry.pack(side="left", fill="x", expand=True)
        addPlaceholder(self.woEntry, self.woVar, "Paste a WO or grid key, or pick one from Ready to close")
        self.copyWoButton = makeCopyWoButton(woRow, self.woVar, height=fieldHeight + 6)
        self.copyWoButton.pack(side="left", padx=(8, 0))
        self.closeButton = ctk.CTkButton(
            woRow, text="🔒  Close TKT", height=fieldHeight + 6, width=150, corner_radius=8,
            fg_color=amberColor, hover_color="#c08a2c", text_color=darkTextColor,
            font=ctk.CTkFont(size=14, weight="bold"), command=self.startClosing,
        )  # only shown for a PASSED ticket

        self.infoLabel = ctk.CTkLabel(body, text="", text_color=textColor, font=smallFont("bold"),
                                      anchor="w", justify="left")
        self.infoLabel.pack(fill="x", pady=(10, 0))

        self.locationPreview = LocationPreview(body)
        self.locationPreview.pack(fill="x", pady=(10, 0))

        self.stepsFrame = ctk.CTkFrame(body, fg_color=bgColor, corner_radius=8)
        self.stepsFrame.pack(fill="x", pady=(10, 0))

        self.message = ctk.CTkLabel(body, text="", text_color=mutedColor, font=ctk.CTkFont(size=12),
                                    anchor="w", justify="left", wraplength=880)
        self.message.pack(fill="x", pady=(10, 0))
        self.loadRecord("")
        self.refreshReady()

    # ---------- helpers ----------
    def showMessage(self, text, color=mutedColor):
        self.message.configure(text=text, text_color=color)

    def onShow(self):
        self.refreshReady()
        self.loadRecord(self.woVar.get().strip())

    def refreshReady(self):
        """PASSED cloud tickets with steps still to do (local starts have no ticket to close)."""
        try:
            records = [record for record in searchRecords("")
                       if (record.get("status") or "").upper() == "PASSED" and not isLocalStart(record)
                       and not record.get("closedAt")
                       and not all(record.get(field) for field, _, _ in self.closeSteps)]
        except Exception:
            records = []
        self.readyMap = {}
        for record in records:
            name = record.get("cluster") or record["wo"]
            label = f"{name}   ·   {record.get('ticketId') or 'no ticket ID'}"
            while label in self.readyMap:
                label += " "
            self.readyMap[label] = record
        if self.readyMap:
            self.readyMenu.configure(values=list(self.readyMap), state="normal")
            self.readyMenu.set(f"▾ Ready to close ({len(self.readyMap)})")
        else:
            self.readyMenu.configure(values=["Nothing ready to close"], state="disabled")
            self.readyMenu.set("Nothing ready to close")

    def onPickReady(self, label):
        record = self.readyMap.get(label)
        if record and not self.isBusy:
            self.woVar.set(record["wo"])
        self.refreshReady()

    def onWoChange(self):
        """Accepts a WO, a grid key or a Ticket ID."""
        raw = self.woVar.get()
        cleaned, record, matchedBy = (resolveWorkOrder(raw) if not self.isBusy
                                      else (cleanWorkOrder(raw), None, None))
        if cleaned != raw:
            self.woVar.set(cleaned)  # Tk won't re-run this handler for it, so carry on below
            self.woEntry.icursor("end")
        self.loadRecord(cleaned)
        if matchedBy in matchedByNames and not self.isBusy:
            self.showMessage(f"{matchedByNames[matchedBy]} {raw.strip()} matched this WO. " + self.message.cget("text"),
                             accentColor)

    def loadRecord(self, wo):
        try:
            self.record = getRecord(wo) if wo else None
        except Exception:
            self.record = None
        record = self.record or {}
        self.locationPreview.show(wo, record)
        for child in self.stepsFrame.winfo_children():
            child.destroy()
        for field, name, what in self.closeSteps:
            done = record.get(field)
            row = ctk.CTkFrame(self.stepsFrame, fg_color="transparent")
            row.pack(fill="x", padx=12, pady=4)
            ctk.CTkLabel(row, text="●", text_color=greenColor if done else borderColor,
                         font=ctk.CTkFont(size=14)).pack(side="left")
            ctk.CTkLabel(row, text=f"{name}:  {what}", text_color=textColor, font=smallFont()).pack(
                side="left", padx=(8, 0))
            ctk.CTkLabel(row, text=f"done {niceTime(done)}" if done else "pending",
                         text_color=greenColor if done else mutedColor, font=smallFont("bold")).pack(side="right")
        ctk.CTkLabel(self.stepsFrame, text="More steps will be added here.", text_color=mutedColor,
                     font=ctk.CTkFont(size=11)).pack(anchor="w", padx=12, pady=(0, 6))

        status = (record.get("status") or "").upper()
        isLocal = isLocalStart(record)
        # only a cloud ticket can be closed, and only once
        isPassed = status == "PASSED" and not isLocal and not record.get("closedAt")
        if not wo:
            self.infoLabel.configure(text="")
        elif not self.record:
            self.infoLabel.configure(text="Not in Records - run Start / End Ticket for it first.", text_color=redColor)
        else:
            parts = [f"Ticket {record.get('ticketId') or '—'}", f"Status {status or '—'}",
                     f"EQ3 {record.get('eq3') or '—'}", f"EQ6 {record.get('eq6') or '—'}"]
            if record.get("closedAt"):
                parts.append(f"🔒 CLOSED {niceTime(record['closedAt'])}")
            self.infoLabel.configure(text="   ·   ".join(parts), text_color=greenColor if isPassed else textColor)
        if isPassed and not self.isBusy:
            self.closeButton.pack(side="left", padx=(8, 0))
        else:
            self.closeButton.pack_forget()
        if not self.isBusy:
            if self.record and isLocal:
                self.showMessage(f"This is a local start ({record.get('ticketId')}) - there's no TechInsights "
                                 "ticket to close. Only the day's cloud ticket gets closed.", amberColor)
            elif self.record and record.get("closedAt"):
                self.showMessage(f"Already closed {niceTime(record['closedAt'])} - nothing to do.", greenColor)
            elif self.record and not isPassed:
                self.showMessage(f"Close TKT is only for PASSED tickets (this one is {status or 'not set'}).",
                                 amberColor)
            elif isPassed:
                self.showMessage("Ready. Close TKT runs the steps above in TechInsights.", mutedColor)
            elif not wo:
                self.showMessage("Pick a PASSED ticket from ▾ Ready to close, or type its WO.", mutedColor)

    # ---------- running ----------
    def startClosing(self):
        record = self.record or {}
        wo = record.get("wo")
        if (not wo or self.isBusy or (record.get("status") or "").upper() != "PASSED"
                or isLocalStart(record)):
            return
        self.isBusy = True
        resetStop()
        self.closeButton.pack_forget()
        self.doneButton.pack_forget()
        self.clearButton.configure(state="disabled")
        showStopButton(self.stopButton)
        self.showMessage("Closing: opening TechInsights in your Chrome… (refreshes between steps)")
        ticketId = record.get("ticketId")
        stepNames = {int(name.split()[-1]): (field, what) for field, name, what in self.closeSteps}

        def work():
            if not ticketId:  # by WO alone it could land on an older ticket for the same WO
                raise ChromeBridgeError("No Ticket ID saved for this WO - run Find in End Ticket first.")
            # Step 3 (Logfile Submittal) values, from the record and the renamed GridSummary CSV.
            latest = getRecord(wo) or record
            try:
                csvPath = str(findRenamedCopy(wo, latest.get("gridSummaryPath")))
            except Exception:
                csvPath = None  # Step 3 stops and says so, if the ticket gets that far
            logfile = {"eq3": latest.get("eq3"), "eq6": latest.get("eq6"), "total": latest.get("totalGrids"),
                       "tested": latest.get("attempted"), "skipped": latest.get("skipped"), "csvPath": csvPath}
            summary, stepsDone, alreadyDone, error = closeTicketSteps(wo, ticketId, logfile)
            # Steps found done by hand: mark them done (keep an earlier time if the app already had one).
            saved = getRecord(wo) or {}
            for step in alreadyDone:
                field, what = stepNames.get(step, (f"closeStep{step}At", f"step {step}"))
                if not saved.get(field):
                    safeSave(wo, event=f"Close: Step {step} was already done by hand - {what}", **{field: now()})
            # Save every step that got done, even when a later one failed.
            for step in stepsDone:
                field, what = stepNames.get(step, (f"closeStep{step}At", f"step {step}"))
                safeSave(wo, event=f"Close: Step {step} done - {what}", **{field: now()})
            # All close steps done (here or by hand): the ticket is closed.
            saved = getRecord(wo) or {}
            if all(saved.get(field) for field, _, _ in self.closeSteps) and not saved.get("closedAt"):
                safeSave(wo, event="Ticket closed - all close steps done", closedAt=now())
                summary = (summary or "Done.") + " 🔒 Ticket marked as Closed."
            if error:
                raise ChromeBridgeError(error + (f" (step {', '.join(map(str, stepsDone))} done and saved)"
                                                 if stepsDone else ""))
            return summary

        def onDone(ok, value):
            self.isBusy = False
            self.stopButton.pack_forget()
            self.clearButton.configure(state="normal")
            if not ok:
                safeSave(wo, event=f"Close: stopped - {value}")
            self.loadRecord(wo)
            self.refreshReady()
            self.showMessage(value, greenColor if ok else redColor)
            self.doneButton.pack(side="right")
            recordsChanged(self)
            bringToFront(self)

        runInBackground(self, work, onDone)

    def clearForNext(self):
        if self.isBusy:
            return
        self.doneButton.pack_forget()
        self.woVar.set("")
        self.loadRecord("")
        self.refreshReady()
        self.woEntry.focus_set()


class HomePage(ctk.CTkFrame):
    def __init__(self, master, onStart, onEnd, onRecords, onClose):
        super().__init__(master, fg_color=bgColor)
        center = ctk.CTkFrame(self, fg_color="transparent")
        center.place(relx=0.5, rely=0.46, anchor="center")

        ctk.CTkLabel(center, text="⚡ Kaam25", text_color=textColor,
                     font=ctk.CTkFont(size=34, weight="bold")).pack()
        today = datetime.now()
        ctk.CTkLabel(
            center, text=f"{today.strftime('%A, %B')} {today.day}  ·  Employee {employeeId}",
            text_color=mutedColor, font=ctk.CTkFont(size=13),
        ).pack(pady=(4, 28))

        row = ctk.CTkFrame(center, fg_color="transparent")
        row.pack()
        self.makeChoice(row, "🚀", "Start Ticket", "Cloud start once a day,\nlocal start (LM_N_date) after",
                        accentColor, onStart).pack(side="left", padx=8)
        self.makeChoice(row, "🏁", "End Ticket", "Upload EQ3 / EQ6\nand build the report",
                        greenColor, onEnd).pack(side="left", padx=8)
        self.makeChoice(row, "🔒", "Close Ticket", "Finish the day's PASSED\ncloud ticket",
                        amberColor, onClose).pack(side="left", padx=8)
        self.makeChoice(row, "📒", "Records", "Search tickets, Job IDs\nand files, copy anything",
                        purpleColor, onRecords).pack(side="left", padx=8)

    def makeChoice(self, parent, icon, title, description, color, command):
        """A big clickable card that glows in its color on hover."""
        card = ctk.CTkFrame(parent, width=210, height=220, fg_color=cardColor, corner_radius=16,
                            border_width=2, border_color=borderColor)
        card.pack_propagate(False)
        ctk.CTkFrame(card, height=5, corner_radius=3, fg_color=color).pack(fill="x", padx=20, pady=(18, 0))
        ctk.CTkLabel(card, text=icon, font=ctk.CTkFont(size=34)).pack(pady=(14, 0))
        ctk.CTkLabel(card, text=title, text_color=textColor,
                     font=ctk.CTkFont(size=20, weight="bold")).pack(pady=(2, 4))
        ctk.CTkLabel(card, text=description, text_color=mutedColor, font=smallFont(),
                     justify="center").pack()
        ctk.CTkLabel(card, text="Open  →", text_color=color, font=smallFont("bold")).pack(pady=(10, 0))

        def onEnter(_):
            card.configure(border_color=color, fg_color=cardHoverColor)

        def onLeave(_):
            card.configure(border_color=borderColor, fg_color=cardColor)

        def bindAll(widget):
            widget.bind("<Button-1>", lambda _: command())
            widget.bind("<Enter>", onEnter)
            widget.bind("<Leave>", onLeave)
            widget.configure(cursor="hand2")
            for child in widget.winfo_children():
                bindAll(child)

        bindAll(card)
        return card


navItems = [
    ("home", "Home", textColor),
    ("start", "🚀  Start Ticket", accentColor),
    ("end", "🏁  End Ticket", greenColor),
    ("close", "🔒  Close Ticket", amberColor),
    ("records", "📒  Records", purpleColor),
]


class NavBar(ctk.CTkFrame):
    """Always-visible top bar: switch pages, and see how many tickets are still open today."""

    def __init__(self, master, onSelect):
        super().__init__(master, fg_color=cardColor, corner_radius=0)
        inner = ctk.CTkFrame(self, fg_color="transparent")
        inner.pack(fill="x", padx=16, pady=8)

        brand = ctk.CTkLabel(inner, text="⚡ Kaam25", text_color=textColor, cursor="hand2",
                             font=ctk.CTkFont(size=17, weight="bold"))
        brand.pack(side="left", padx=(0, 18))
        brand.bind("<Button-1>", lambda _: onSelect("home"))

        self.buttons = {}
        for name, text, color in navItems:
            button = ctk.CTkButton(
                inner, text=text, height=32, width=116 if name != "home" else 64, corner_radius=8,
                fg_color="transparent", hover_color=fieldColor, text_color=mutedColor,
                font=smallFont("bold"), command=lambda page=name: onSelect(page),
            )
            button.pack(side="left", padx=3)
            self.buttons[name] = (button, color)

        self.openChip = ctk.CTkButton(
            inner, text="", height=28, corner_radius=14, fg_color=fieldColor, hover_color=borderColor,
            font=smallFont("bold"), command=lambda: onSelect("end"),
        )
        self.openChip.pack(side="right")
        ctk.CTkFrame(self, height=1, corner_radius=0, fg_color=borderColor).pack(fill="x", side="bottom")

    def setActive(self, active):
        for name, (button, color) in self.buttons.items():
            isActive = name == active
            button.configure(fg_color=fieldColor if isActive else "transparent",
                             text_color=color if isActive else mutedColor)

    def setOpenCount(self, count):
        if count:
            self.openChip.configure(text=f"●  {count} open today", text_color=amberColor)
        else:
            self.openChip.configure(text="✓  Nothing open today", text_color=greenColor)


class Dashboard(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Kaam25")
        self.geometry("1000x780")
        self.minsize(920, 720)
        self.configure(fg_color=bgColor)
        # Open maximized (CustomTkinter resets the state while starting, so do it just after).
        self.after(50, lambda: self.state("zoomed"))
        # F11: true fullscreen (no title bar) on/off. Esc: leave it.
        self.bind("<F11>", lambda _: self.attributes("-fullscreen", not self.attributes("-fullscreen")))
        self.bind("<Escape>", lambda _: self.attributes("-fullscreen", False))

        self.navBar = NavBar(self, onSelect=self.showPage)
        self.navBar.pack(fill="x")
        pageArea = ctk.CTkFrame(self, fg_color=bgColor, corner_radius=0)
        pageArea.pack(fill="both", expand=True)

        goHome = lambda: self.showPage("home")
        # One WhatsApp Send setting for the whole app (End Ticket + Records), starting from .env.
        self.whatsappSendVar = ctk.BooleanVar(value=whatsappSend)
        self.pages = {
            "home": HomePage(pageArea, onStart=lambda: self.showPage("start"),
                             onEnd=lambda: self.showPage("end"), onRecords=lambda: self.showPage("records"),
                             onClose=lambda: self.showPage("close")),
            "close": CloseTicketPage(pageArea, onBack=goHome),
            "start": StartTicketPage(pageArea, onBack=goHome, onGoToEnd=self.continueInEnd),
            "end": EndTicketPage(pageArea, onBack=goHome, whatsappSendVar=self.whatsappSendVar),
            "records": RecordsPage(pageArea, onBack=goHome, onContinue=self.continueInEnd,
                                   whatsappSendVar=self.whatsappSendVar),
        }
        # Single-column forms: keep them a readable width when the window is maximized.
        capPageWidth(self.pages["start"])
        capPageWidth(self.pages["close"])
        self.showPage("home")

    def showPage(self, name):
        for page in self.pages.values():
            page.pack_forget()
        page = self.pages[name]
        page.pack(fill="both", expand=True)
        if hasattr(page, "onShow"):
            page.onShow()
        self.navBar.setActive(name)
        self.refreshOpenCount()

    def refreshOpenCount(self):
        try:
            self.navBar.setOpenCount(len(openTicketsToday()))
        except Exception:
            self.navBar.setOpenCount(0)

    def continueInEnd(self, wo, ticketId=None):
        self.pages["end"].prefill(wo, ticketId)
        self.showPage("end")


if __name__ == "__main__":
    Dashboard().mainloop()
