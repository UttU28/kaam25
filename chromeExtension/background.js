// Relays results to the Kaam25 app and remembers which tab is running which job
// ("ticket" lookup or "actix" login), so the job survives redirects to sign-in pages.
const bridgeBase = "http://127.0.0.1:47821";
const bridgeUrl = `${bridgeBase}/result`;
const jobMaxAgeMs = 30 * 60 * 1000; // long enough for sign-in plus a slow upload

const extensionVersion = chrome.runtime.getManifest().version;

// Keep equal to "version" in manifest.json. Chrome can keep running an old saved copy of this
// file after an update (seen across a Chrome restart); when it does, reload to get the new code.
const backgroundBuild = "3.58";
if (extensionVersion !== backgroundBuild) chrome.runtime.reload();

// Sends to the app. If the app says our files changed on disk, reload to pick them up.
function sendToBridge(data) {
  return fetch(bridgeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: extensionVersion, build: backgroundBuild, ...data }),
  })
    .then((response) => (response.status === 200 ? response.json() : null))
    .then(async (reply) => {
      if (!reply) return;
      if (reply.cancel && reply.cancel.length) await cancelJobs(reply.cancel);
      if (reply.closeTabs && reply.closeTabs.length) closeKeptTabs(reply.closeTabs);
      if (reply.reload) setTimeout(() => chrome.runtime.reload(), 300);
    })
    .catch(() => {});
}

// ---------- Stop pressed in the app ----------
// Drop those jobs: their page scripts check before Create / Submit / Send and stop there.
async function cancelJobs(requestIds) {
  const jobs = (await chrome.storage.session.get("jobs")).jobs || {};
  let changed = false;
  for (const [tabId, job] of Object.entries(jobs)) {
    if (requestIds.includes(job.requestId)) {
      delete jobs[tabId];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.session.set({ jobs });
    debugLog(`stopped from the app: ${requestIds.length} job(s) dropped`);
  }
}

// ---------- EQ tabs kept open until the ticket is Done in the app ----------
async function getKeptTabs() {
  return (await chrome.storage.session.get("keptTabs")).keptTabs || {};
}

async function keepTab(requestId, tabId) {
  const keptTabs = await getKeptTabs();
  keptTabs[requestId] = tabId;
  await chrome.storage.session.set({ keptTabs });
}

// tokens: the run IDs the app saved for this ticket's EQ tabs. Only those tabs are closed.
async function closeKeptTabs(tokens) {
  const keptTabs = await getKeptTabs();
  const jobs = await getAllJobs();
  for (const token of tokens) {
    const tabId = keptTabs[token];
    if (tabId == null) continue;
    delete keptTabs[token];
    // A reused tab may now hold another ticket's upload: leave it open if it's busy or kept for one.
    const running = jobs[tabId] && Date.now() - jobs[tabId].startedAt < jobMaxAgeMs;
    const keptForOther = Object.entries(keptTabs).some(([other, id]) => id === tabId && !tokens.includes(other));
    if (running || keptForOther) continue;
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  await chrome.storage.session.set({ keptTabs });
}

// Check in with the app every 30 s (and when Chrome starts): picks up a newer version on disk,
// and closes EQ tabs once you click Done. Fails quietly when the app isn't open.
chrome.alarms.create("kaamCheckIn", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "kaamCheckIn") sendToBridge({ stage: "ping" }); });
chrome.runtime.onStartup.addListener(() => sendToBridge({ stage: "ping" }));
chrome.runtime.onInstalled.addListener(() => {
  sendToBridge({ stage: "log", text: `extension loaded, code ${backgroundBuild}`, url: "" });
});
sendToBridge({ stage: "ping" });

// Goes to kaamDebug.log in the app folder. Never includes field values.
function debugLog(text, tab) {
  sendToBridge({ stage: "log", text, url: tab ? tab.url : "" });
}

async function getAllJobs() {
  return (await chrome.storage.session.get("jobs")).jobs || {};
}

async function setJob(tabId, job) {
  const jobs = await getAllJobs();
  if (job) jobs[tabId] = job;
  else delete jobs[tabId];
  await chrome.storage.session.set({ jobs });
}

// A tab belongs to a job if it started it, or was opened by it (a sign-in popup).
async function getJob(tab) {
  if (!tab) return null;
  const jobs = await getAllJobs();
  for (const tabId of [tab.id, tab.openerTabId]) {
    const job = tabId != null ? jobs[tabId] : null;
    if (job && Date.now() - job.startedAt < jobMaxAgeMs) return { tabId, ...job };
  }
  return null;
}

// A real mouse click (same as you clicking). Chrome only hands a saved password
// to the page after a real click or keypress, so sign-in buttons need this.
async function realClick(tabId, x, y) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const press = { x, y, button: "left", clickCount: 1 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...press });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...press });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Real typing into whatever has focus, optionally followed by Enter.
async function realType(tabId, text, pressEnter) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Input.insertText", { text });
    if (pressEnter) {
      const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...enter });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "char", text: "\r", ...enter });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...enter });
    }
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Real typing of several lines, with Shift+Enter between them (plain Enter would send in WhatsApp).
async function realTypeLines(tabId, lines) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const shiftEnter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 };
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await chrome.debugger.sendCommand(target, "Input.insertText", { text: lines[i] });
      if (i < lines.length - 1) {
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...shiftEnter });
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...shiftEnter });
      }
    }
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// ---------- WhatsApp: use the open WhatsApp Web tab, or open one ----------
const whatsappUrl = "https://web.whatsapp.com/";

async function waitForTabLoaded(tabId, timeoutMs = 60000, urlStart = whatsappUrl) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === "complete" && (tab.url || "").startsWith(urlStart)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startWhatsappShare(message, triggerTab) {
  sendToBridge({ requestId: message.requestId, stage: "started" });
  const [openTab] = await chrome.tabs.query({ url: `${whatsappUrl}*` });
  let tabId;
  if (openTab) {
    // Your open (e.g. pinned) WhatsApp tab: bring it forward. After Chrome starts, that tab may
    // still be asleep or loading - showing it wakes it, then wait until WhatsApp has loaded.
    tabId = openTab.id;
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(openTab.windowId, { focused: true });
    chrome.tabs.remove(triggerTab.id).catch(() => {});
    debugLog(`whatsapp: using the open WhatsApp tab (${openTab.discarded ? "asleep" : openTab.status})`, openTab);
    if (openTab.discarded || openTab.status !== "complete") await new Promise((resolve) => setTimeout(resolve, 800));
    if (!(await waitForTabLoaded(tabId, 120000))) {
      sendToBridge({ requestId: message.requestId, stage: "done", error: "The WhatsApp tab didn't finish loading." });
      return;
    }
  } else {
    // None open: turn the app's little page into WhatsApp Web.
    tabId = triggerTab.id;
    await chrome.tabs.update(tabId, { url: whatsappUrl, active: true });
    debugLog("whatsapp: no WhatsApp tab open, opening one", triggerTab);
    if (!(await waitForTabLoaded(tabId))) {
      sendToBridge({ requestId: message.requestId, stage: "done", error: "WhatsApp Web didn't load." });
      return;
    }
  }
  await setJob(tabId, { kind: "whatsapp", requestId: message.requestId, data: message.data, startedAt: Date.now() });
  try {
    // Injected fresh each time, so it works even in a tab opened before the extension updated.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["whatsappShare.js"] });
  } catch (error) {
    await setJob(tabId, null);
    sendToBridge({ requestId: message.requestId, stage: "done", error: `Couldn't start in the WhatsApp tab: ${error.message}` });
  }
}

// ---------- TEMS Paragon: use the open TEMS tab (http://localhost:8080), or open one ----------
async function startTems(message, triggerTab) {
  sendToBridge({ requestId: message.requestId, stage: "started" });
  const done = (error) => sendToBridge({ requestId: message.requestId, stage: "done", ok: false, error });
  let temsUrl;
  try { temsUrl = new URL(message.data.url); } catch { return done(`Not a web address: ${message.data.url}`); }
  const urlStart = `${temsUrl.origin}/`;
  // TEMS is "there" once its side menu (Cloud / Assign ...) has rendered in the tab.
  const temsReady = async (tabId, timeoutMs) => {
    if (!(await waitForTabLoaded(tabId, timeoutMs, urlStart))) return false;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId }, func: () => !!document.querySelector('[class*="SideMenuButton_menu-button"]'),
      }).catch(() => []);
      if (probe?.result) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };

  let tabId = null;
  const openTabs = await chrome.tabs.query({ url: `${temsUrl.origin}/*` });
  // Prefer the TEMS tab you're looking at, then any TEMS tab.
  const openTab = openTabs.find((tab) => tab.active) || openTabs[0];
  if (openTab) {
    await chrome.tabs.update(openTab.id, { active: true });
    await chrome.windows.update(openTab.windowId, { focused: true });
    debugLog(`tems: using the open TEMS tab (${openTab.discarded ? "asleep" : openTab.status})`, openTab);
    if (await temsReady(openTab.id, 15000)) tabId = openTab.id;
    else {
      // Open but TEMS isn't showing (error page, stuck, asleep): reload it once.
      debugLog("tems: TEMS isn't showing in that tab - reloading it", openTab);
      await chrome.tabs.reload(openTab.id).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (await temsReady(openTab.id, 25000)) tabId = openTab.id;
      else debugLog("tems: still not showing after a reload - opening TEMS in a new tab", openTab);
    }
  } else {
    debugLog("tems: no TEMS tab open, opening one", triggerTab);
  }
  if (tabId) {
    chrome.tabs.remove(triggerTab.id).catch(() => {});
  } else {
    // No usable TEMS tab: turn the app's little page into a new TEMS tab.
    tabId = triggerTab.id;
    await chrome.tabs.update(tabId, { url: temsUrl.href, active: true });
    if (!(await temsReady(tabId, 60000))) return done(`TEMS Paragon didn't load at ${temsUrl.href}. Is TEMS Paragon running?`);
  }
  await setJob(tabId, { kind: "tems", requestId: message.requestId, data: message.data, startedAt: Date.now() });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["temsParagon.js"] });
  } catch (error) {
    await setJob(tabId, null);
    done(`Couldn't start in the TEMS tab: ${error.message}`);
  }
}

// Runs inside WhatsApp's own page. When WhatsApp asks to open the file picker, hand it the
// file our share script left in #kaam-file-carrier instead - no Windows dialog. Does nothing
// when there's no carrier (i.e. outside a Kaam25 share).
function hookWhatsappFilePicker() {
  if (window.kaamFilePickerHooked) return;
  window.kaamFilePickerHooked = true;
  const proto = HTMLInputElement.prototype;
  const handOver = (input) => {
    const carrier = document.getElementById("kaam-file-carrier");
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !carrier || !carrier.files.length) return false;
    input.files = carrier.files;
    carrier.remove();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  const originalClick = proto.click;
  proto.click = function (...args) { if (handOver(this)) return undefined; return originalClick.apply(this, args); };
  if (proto.showPicker) {
    const originalShowPicker = proto.showPicker;
    proto.showPicker = function (...args) { if (handOver(this)) return undefined; return originalShowPicker.apply(this, args); };
  }
  // A real click straight on a file box: stop the dialog, hand over the file.
  document.addEventListener("click", (event) => { if (handOver(event.target)) event.preventDefault(); }, true);
}

// If WhatsApp reloads itself during a share (it does after updates), the share script goes
// with the old page - start it again in the new one. It skips itself if already running.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const job = (await getAllJobs())[tabId];
  // Only a recent job: an old stuck one must never come back and type into the chat later.
  if (!job || Date.now() - job.startedAt > 10 * 60 * 1000) return;
  const script = { whatsapp: "whatsappShare.js", tems: "temsParagon.js" }[job.kind];
  if (!script) return;
  debugLog(`${job.kind}: the page reloaded during the job, starting again`, await chrome.tabs.get(tabId));
  chrome.scripting.executeScript({ target: { tabId }, files: [script] }).catch(() => {});
});

// ---------- One tab per site: reuse the tab Kaam25 used last for ActixOne / TechInsights ----------
// The app opens every job in a new tab. When that tab starts, move the job into the tab we used
// before for the same kind (if it's still open and not busy) and close the new one.
// Only tabs Kaam25 itself opened are reused - never one you opened by hand.

// Navigate a tab and wait until that new page has loaded (sees "loading" first, then "complete").
function navigateAndWait(tabId, url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
    const listener = (id, changeInfo) => {
      if (id !== tabId) return;
      if (changeInfo.status === "loading") sawLoading = true;
      if (changeInfo.status === "complete" && sawLoading) done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url, active: true }).catch(done);
  });
}

async function reuseTab(kind, url, newTab) {
  const reuseTabs = (await chrome.storage.session.get("reuseTabs")).reuseTabs || {};
  const oldId = reuseTabs[kind];
  if (oldId != null && oldId !== newTab.id) {
    const oldTab = await chrome.tabs.get(oldId).catch(() => null);
    const oldJob = (await getAllJobs())[oldId];
    const busy = oldJob && Date.now() - oldJob.startedAt < jobMaxAgeMs;
    if (oldTab && !busy) {
      // Via a blank page, so the page always loads fresh (a change after # alone wouldn't reload it).
      await navigateAndWait(oldId, "about:blank");
      await chrome.tabs.update(oldId, { url });
      await chrome.windows.update(oldTab.windowId, { focused: true }).catch(() => {});
      chrome.tabs.remove(newTab.id).catch(() => {});
      debugLog(`${kind}: reusing the open Kaam25 tab instead of a new one`);
      return true;
    }
  }
  reuseTabs[kind] = newTab.id;
  await chrome.storage.session.set({ reuseTabs });
  return false;
}

// ---------- back to the Kaam25 tab when the work is done ----------
// A job that finished fine brings the app's tab (127.0.0.1:5000-5020) to the front a few seconds
// later - unless more work starts first (a new job or tab), e.g. Start's TEMS check -> ticket -> TEMS.
// A failed job leaves you on its tab so you can see what happened.
let focusAppTimer = null;
function cancelFocusApp() { clearTimeout(focusAppTimer); focusAppTimer = null; }
function focusAppSoon(delayMs = 4000) {
  cancelFocusApp();
  focusAppTimer = setTimeout(async () => {
    focusAppTimer = null;
    const jobs = await getAllJobs();
    if (Object.values(jobs).some((job) => job && Date.now() - job.startedAt < jobMaxAgeMs)) return; // still busy
    const tab = await findAppTab();
    if (!tab) return;
    if (tab.active) {
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      if (win && win.focused) return;
    }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }, delayMs);
}
chrome.tabs.onCreated.addListener(() => cancelFocusApp());

// Your Kaam25 tab (127.0.0.1 / localhost, port 5000-5020; a pinned one counts too): the given port
// first, then the one used last.
async function findAppTab(preferPort = 0) {
  const tabs = await chrome.tabs.query({ url: ["http://127.0.0.1/*", "http://localhost/*"] });
  const appTabs = tabs.filter((tab) => portOf(tab) >= 5000 && portOf(tab) <= 5020);
  appTabs.sort((a, b) => (portOf(b) === preferPort) - (portOf(a) === preferPort) ||
    (b.pinned - a.pinned) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return appTabs[0] || null;
}

// The app just started (its /app page): switch to the open Kaam25 tab, reload it so it's fresh, and
// close the helper page. No Kaam25 tab open: the helper page becomes the app.
async function focusAppOnStart(url, triggerTab) {
  cancelFocusApp();
  const port = Number(new URL(url).port);
  const tab = await findAppTab(port);
  if (!tab) {
    debugLog("app started - no Kaam25 tab open, opening one", triggerTab);
    await chrome.tabs.update(triggerTab.id, { url }).catch(() => {});
    return;
  }
  debugLog(`app started - switching to the open Kaam25 tab${tab.pinned ? " (pinned)" : ""}`, triggerTab);
  if (portOf(tab) !== port) await chrome.tabs.update(tab.id, { url, active: true }).catch(() => {});
  else {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.tabs.reload(tab.id).catch(() => {});
  }
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.remove(triggerTab.id).catch(() => {});
}
function portOf(tab) { try { return Number(new URL(tab.url).port); } catch { return 0; } }

async function handleMessage(message, sender) {
  switch (message.type) {
    case "reuseTab":
      try {
        return await reuseTab(message.kind, message.url, sender.tab);
      } catch (error) {
        debugLog(`tab reuse failed, using the new tab: ${error.message}`, sender.tab);
        return false;
      }
    case "whatsappHookFilePicker":
      if (!(await getJob(sender.tab))) return false;
      await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN", func: hookWhatsappFilePicker });
      return true;
    case "whatsappStart":
      cancelFocusApp();
      startWhatsappShare(message, sender.tab); // runs on; the result comes back through jobDone
      return true;
    case "focusApp":
      await focusAppOnStart(message.url, sender.tab);
      return true;
    case "temsStart":
      cancelFocusApp();
      startTems(message, sender.tab); // runs on; the result comes back through jobDone
      return true;
    case "realTypeLines":
      if (!(await getJob(sender.tab))) return false;
      try {
        await realTypeLines(sender.tab.id, message.lines);
        return true;
      } catch (error) {
        debugLog(`real typing failed: ${error.message}`, sender.tab);
        return false;
      }
    case "realType":
      if (!(await getJob(sender.tab))) return false;
      try {
        await realType(sender.tab.id, message.text, message.pressEnter);
        return true;
      } catch (error) {
        debugLog(`real typing failed: ${error.message}`, sender.tab);
        return false;
      }
    case "getFiles": {
      // The log files the app picked for this job.
      const job = await getJob(sender.tab);
      if (!job) return { error: "This tab has no Kaam25 job." };
      try {
        const response = await fetch(`${bridgeBase}/files/${job.requestId}`);
        return await response.json();
      } catch (error) {
        return { error: `Couldn't get the log files from the app: ${error.message}` };
      }
    }
    case "log":
      debugLog(message.text, sender.tab);
      return true;
    case "temsStage":
      // The TEMS tab's watcher: where the test is (stationary / mobility / complete / closed). Live Testing shows it.
      sendToBridge({ stage: "temsStage", temsStage: message.stage || "", wo: message.wo || "",
        event: message.event || "", eventText: message.eventText || "" });
      return true;
    case "captureTab": {
      // Submit: a picture of the TEMS page as it shows now (PNG data URL). Only for a TEMS tab running a job.
      if (!(await getJob(sender.tab))) return { error: "the TEMS tab has no job" };
      const target = { tabId: sender.tab.id };
      try {
        await chrome.debugger.attach(target, "1.3");
        const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", { format: "png" });
        debugLog("picture of the TEMS page taken", sender.tab);
        return { dataUrl: `data:image/png;base64,${shot.data}` };
      } catch (error) {
        debugLog(`picture failed: ${error.message}`, sender.tab);
        return { error: error.message };
      } finally {
        await chrome.debugger.detach(target).catch(() => {});
      }
    }
    case "temsWindow": {
      // Submit: Chrome full window for the picture ("max"), then back as it was ("restore").
      const windowId = sender.tab.windowId;
      if (message.mode === "max") {
        const win = await chrome.windows.get(windowId).catch(() => null);
        if (!win) return false;
        await chrome.storage.session.set({ temsWindowBefore: { state: win.state, left: win.left, top: win.top, width: win.width, height: win.height } });
        await chrome.windows.update(windowId, { state: "maximized", focused: true }).catch(() => {});
        return true;
      }
      const before = (await chrome.storage.session.get("temsWindowBefore")).temsWindowBefore;
      if (!before) return false;
      await chrome.storage.session.remove("temsWindowBefore");
      if (before.state === "maximized") return true;
      await chrome.windows.update(windowId, { state: "normal" }).catch(() => {});
      await chrome.windows.update(windowId, { left: before.left, top: before.top, width: before.width, height: before.height }).catch(() => {});
      return true;
    }
    case "realClick":
      // Only for tabs running a Kaam25 job.
      if (!(await getJob(sender.tab))) {
        debugLog("real click refused: tab has no job", sender.tab);
        return false;
      }
      try {
        await realClick(sender.tab.id, message.x, message.y);
        debugLog(`real click done at ${Math.round(message.x)},${Math.round(message.y)}`, sender.tab);
        return true;
      } catch (error) {
        debugLog(`real click failed: ${error.message}`, sender.tab);
        return false;
      }
    case "jobStart":
      cancelFocusApp();
      await setJob(sender.tab.id, {
        kind: message.kind, requestId: message.requestId, data: message.data, startedAt: Date.now(),
      });
      sendToBridge({ requestId: message.requestId, stage: "started" });
      return true;
    case "jobState":
      return await getJob(sender.tab);
    case "jobProgress": {
      // A batch (End Tickets on WhatsApp) telling the app how far it is: every result so far.
      const job = await getJob(sender.tab);
      if (!job) return false;
      sendToBridge({ requestId: job.requestId, stage: "progress", seq: Date.now(), ...(message.progress || {}) });
      return true;
    }
    case "stillWanted":
      // Right before Create / Submit / Send: check in with the app first (it hands over any
      // Stop you just pressed), then say whether this tab's job is still on.
      await sendToBridge({ stage: "ping" });
      return !!(await getJob(sender.tab));
    case "jobUpdate": {
      // Change a running job's data, e.g. switch "create" to "find" before clicking Create.
      const job = await getJob(sender.tab);
      if (!job) return false;
      await setJob(job.tabId, {
        kind: job.kind, requestId: job.requestId, startedAt: job.startedAt,
        data: { ...job.data, ...message.data },
      });
      return true;
    }
    case "jobDone": {
      const job = await getJob(sender.tab);
      if (!job) return false;
      await setJob(job.tabId, null);
      const { closeTab, keepTab: shouldKeep, ...result } = message.result || {};
      if (shouldKeep) await keepTab(job.requestId, job.tabId); // closed later, when the app says Done
      sendToBridge({ requestId: job.requestId, stage: "done", ...result });
      // Close only the tab this job opened, and only when the job fully finished.
      if (closeTab && job.data && job.data.closeTab) {
        debugLog("job done - closing its tab", sender.tab);
        // ...unless another job moved into it meanwhile (e.g. EQ6 reusing EQ3's ActixOne tab).
        setTimeout(async () => {
          const busyNow = (await getAllJobs())[job.tabId];
          if (busyNow && Date.now() - busyNow.startedAt < jobMaxAgeMs) { debugLog("tab reused by the next job - left open"); return; }
          chrome.tabs.remove(job.tabId).catch(() => {});
        }, 1500);
      }
      // Start Ticket's work (TEMS check / Reserve + Open, creating or finding the ticket) leaves you
      // where it ends - only End / Close work (uploads, WhatsApp, closing a ticket) switches back.
      // TEMS Reserve + Open done (its Map page is showing): back to the app, which opens Live Testing.
      const startWork = job.kind === "tems" || (job.kind === "ticket" && (job.data || {}).mode !== "close");
      if (job.kind === "tems" && result.backToApp && result.ok) focusAppSoon(1500);
      else if (startWork) cancelFocusApp();
      else if (job.kind === "whatsapp" && result.ok) focusAppSoon(1500);  // shared: straight back to the app
      else if (!result.error && result.ok !== false) focusAppSoon();
      return true;
    }
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, () => sendResponse(null));
  return true; // answer asynchronously
});
