"""One command (Set up desk): get both phones ready for testing and lay the screen out as

    | Chrome (1/2)          | TMO 1 (1/4) | TMO 2 (1/4) |

Skips whatever is already done: unlocked phones, Service Mode + Speedtest already showing,
phones already open in Vysor.

Phones come from Settings > Phones (PHONE_TMO1 / PHONE_TMO2 in .env), in that order. Each name must match
the device's name in Vysor, because that is the title of its Vysor window.

Run from the kaam25 folder:  venv\\Scripts\\python.exe -m kaam.deskLayout
"""

import ctypes
import os
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

from kaam.phoneControl import (configuredPhones, connectedSerials, listenHere, listeners, onEachPhone, say,
                               serviceModeSplit, vysorAppDir)

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
dwmapi = ctypes.windll.dwmapi

try:  # real pixels, so the halves line up on scaled (125%, 150%) screens
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()


# ---------- finding windows ----------

def processName(pid):
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ""
    try:
        buffer = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size))
        return Path(buffer.value).name.lower()
    finally:
        kernel32.CloseHandle(handle)


def topWindows():
    """[(hwnd, title, exe name)] of visible top-level windows, front to back."""
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def onWindow(hwnd, _):
        if user32.IsWindowVisible(hwnd) and not user32.GetWindow(hwnd, 4):  # skip owned popups
            length = user32.GetWindowTextLengthW(hwnd)
            if length:
                title = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, title, length + 1)
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                found.append((hwnd, title.value, processName(pid.value)))
        return True

    user32.EnumWindows(onWindow, 0)
    return found


def findWindow(exe, titleTest):
    for hwnd, title, name in topWindows():
        if name == exe and titleTest(title):
            return hwnd
    return None


def waitForWindow(exe, titleTest, timeout):
    end = time.time() + timeout
    while time.time() < end:
        hwnd = findWindow(exe, titleTest)
        if hwnd:
            return hwnd
        time.sleep(0.5)
    return None


# ---------- placing windows ----------

def workArea():
    """Primary screen minus the taskbar: (left, top, width, height)."""
    rect = wintypes.RECT()
    user32.SystemParametersInfoW(0x30, 0, ctypes.byref(rect), 0)  # SPI_GETWORKAREA
    return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top


def placeWindow(hwnd, x, y, width, height):
    """Moves a window so its visible edges sit exactly on the given box."""
    for attempt in range(2):  # a maximised window sometimes ignores the first move while it un-maximises
        if moveWindow(hwnd, x, y, width, height):
            break
        time.sleep(0.5)
    user32.SetForegroundWindow(hwnd)


def visibleRect(hwnd):
    rect = wintypes.RECT()
    if dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)) != 0:
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect


def moveWindow(hwnd, x, y, width, height):
    """One try; True when the window ended up (within a few pixels) where it was asked."""
    if user32.IsZoomed(hwnd) or user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE (un-maximise / un-minimise)
        end = time.time() + 2
        while (user32.IsZoomed(hwnd) or user32.IsIconic(hwnd)) and time.time() < end:
            time.sleep(0.1)
        time.sleep(0.3)
    wantX, wantY, wantWidth = x, y, width
    outer, visible = wintypes.RECT(), wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(outer))
    # Windows 10/11 windows have invisible resize borders; grow the window by them so there are no gaps.
    if dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(visible), ctypes.sizeof(visible)) == 0:
        x -= visible.left - outer.left
        y -= visible.top - outer.top
        width += (visible.left - outer.left) + (outer.right - visible.right)
        height += (visible.top - outer.top) + (outer.bottom - visible.bottom)
    user32.SetWindowPos(hwnd, 0, x, y, width, height, 0x0004 | 0x0040)  # SWP_NOZORDER | SWP_SHOWWINDOW
    time.sleep(0.2)
    now = visibleRect(hwnd)
    # Vysor keeps the phone's shape, so only the left edge, top and width are checked (width may shrink).
    return abs(now.left - wantX) <= 3 and abs(now.top - wantY) <= 3 and now.right - now.left <= wantWidth + 3


# ---------- Chrome and Vysor ----------

def isChromeTitle(title):
    return title.endswith("Google Chrome")


def findChromeExe():
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LOCALAPPDATA")):
        if base:
            exe = Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe"
            if exe.exists():
                return str(exe)
    return "chrome"


def chromeWindow():
    hwnd = findWindow("chrome.exe", isChromeTitle)
    if hwnd:
        return hwnd
    say("Starting Chrome")
    subprocess.Popen([findChromeExe(), "--new-window"])
    return waitForWindow("chrome.exe", isChromeTitle, 20)


def openInVysor(serials):
    """Vysor -- -s <serial> opens that phone's window (also when Vysor is already running).
    The "--" matters: without it Chrome (inside Vysor) reads -s as its own switch and Vysor never sees it."""
    appDir = vysorAppDir()
    if not appDir:
        raise RuntimeError("Vysor is not installed (no %LOCALAPPDATA%\\vysor\\app-* folder).")
    args = ["--"]
    for serial in serials:
        args += ["-s", serial]
    subprocess.Popen([str(appDir / "Vysor.exe")] + args, cwd=str(appDir))


def phoneWindow(name):
    return findWindow("vysor.exe", lambda title: title.strip() == name)


def closePhones(timeout=8):
    """Closes the TMO 1 / TMO 2 Vysor windows (like pressing their X), so Set up desk can open them
    fresh. Vysor itself and the phones are left alone. Returns the names it closed."""
    names = list(configuredPhones())
    open_ = {name: phoneWindow(name) for name in names}
    open_ = {name: hwnd for name, hwnd in open_.items() if hwnd}
    if not open_:
        say("No TMO window open in Vysor - nothing to close")
        return []
    for name, hwnd in open_.items():
        say(f"Closing {name}")
        user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    end = time.time() + timeout
    while time.time() < end and any(phoneWindow(name) for name in open_):
        time.sleep(0.3)
    still = [name for name in open_ if phoneWindow(name)]
    for name in open_:
        say(f"{name} still open - close it in Vysor" if name in still else f"{name} closed")
    return [name for name in open_ if name not in still]


def hideVysorHome():
    """Minimises Vysor's own device-list window, so only the phone windows show."""
    for hwnd, title, exe in topWindows():
        if exe == "vysor.exe" and title.strip().lower() == "vysor":
            user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE


def bringToFront(hwnd):
    """Puts a window on top even when this script isn't the active app.
    Windows ignores SetForegroundWindow from background programs, so we briefly join the input of
    whatever app is in front (that app is then allowed to hand over the focus)."""
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    frontThread = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    ourThread = kernel32.GetCurrentThreadId()
    attached = frontThread and frontThread != ourThread and user32.AttachThreadInput(ourThread, frontThread, True)
    try:
        user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)  # TOPMOST, no move/size
        user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)  # back to normal, stays in front
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(ourThread, frontThread, False)


def isCovered(hwnd):
    """True when another visible window above this one overlaps it."""
    mine = visibleRect(hwnd)
    for other, _, _ in topWindows():
        if other == hwnd:
            return False
        if user32.IsIconic(other):
            continue
        rect = visibleRect(other)
        if rect.left < mine.right and rect.right > mine.left and rect.top < mine.bottom and rect.bottom > mine.top:
            return True
    return False


def layoutDesk():
    phones = configuredPhones()
    if not phones:
        raise RuntimeError("Add your phones first: Settings > Phones, TMO 1 / TMO 2 serial (from  adb devices).")
    connected = set(connectedSerials())
    toOpen = [serial for serial in phones.values() if serial in connected]
    for name, serial in phones.items():
        if serial not in connected:
            say(f"{name} ({serial}) is not connected over USB - skipping it")
    # Only start the phones that aren't already showing; asking Vysor again just pops up its device list.
    notShowing = [serial for name, serial in phones.items() if serial in toOpen and not phoneWindow(name)]
    if notShowing:
        say("Opening in Vysor: " + ", ".join(name for name, serial in phones.items() if serial in notShowing))
        openInVysor(notShowing)

    left, top, width, height = workArea()
    half, quarter = width // 2, width // 4

    chrome = chromeWindow()
    if chrome:
        placeWindow(chrome, left, top, half, height)
    else:
        say("Chrome window not found")

    placed = []
    for slot, (name, serial) in enumerate(list(phones.items())[:2]):
        if serial not in toOpen:
            continue
        hwnd = waitForWindow("vysor.exe", lambda title, name=name: title.strip() == name, 25)
        if not hwnd:
            say(f"No Vysor window called '{name}'. Check the device's name in Vysor is TMO 1 / TMO 2.")
            continue
        x = left + half + slot * quarter
        placeWindow(hwnd, x, top, width - half - quarter if slot == 1 else quarter, height)
        placed.append(hwnd)
        say(f"{name} placed")

    if notShowing:
        time.sleep(7)  # Vysor pops its device list up again a few seconds after opening a phone
    hideVysorHome()
    time.sleep(0.5)  # let Windows finish switching away from the minimised list first
    for attempt in range(3):
        for hwnd in ([chrome] if chrome else []) + placed:  # Chrome first, phones last = phones on top
            bringToFront(hwnd)
            time.sleep(0.2)
        time.sleep(0.5)
        if not any(isCovered(hwnd) for hwnd in placed):
            break
    else:
        say("WARNING: a phone window is still behind another window")


def setupDesk():
    """Everything for testing, skipping what's already done:
    phones unlocked, Service Mode + Speedtest on each (left alone if already showing),
    phones open in Vysor (only those not showing), then Chrome left half + phones right."""
    phones = configuredPhones()
    if not phones:
        raise RuntimeError("Add your phones first: Settings > Phones, TMO 1 / TMO 2 serial (from  adb devices).")
    connected = set(connectedSerials())
    ready = [serial for serial in phones.values() if serial in connected]
    # Start Vysor first so its windows load while the phones get set up.
    notShowing = [serial for name, serial in phones.items() if serial in ready and not phoneWindow(name)]
    if notShowing:
        say("Opening in Vysor: " + ", ".join(name for name, serial in phones.items() if serial in notShowing))
        openInVysor(notShowing)
    # The phones (both at once) and the windows on this PC at the same time.
    parentListener = listeners.get(threading.get_ident())
    errors = []

    def phonesPart():
        listenHere(parentListener)
        try:
            onEachPhone(serviceModeSplit, ready)
        except Exception as error:
            errors.append(error)
        finally:
            listenHere(None)
    phonesThread = threading.Thread(target=phonesPart) if ready else None
    if phonesThread:
        phonesThread.start()
    try:
        layoutDesk()
    finally:
        if phonesThread:
            phonesThread.join()
    if errors:
        raise errors[0]


if __name__ == "__main__":
    try:
        setupDesk()
    except RuntimeError as error:
        say(error)
        sys.exit(1)
