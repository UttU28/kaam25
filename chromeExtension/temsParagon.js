// Injected into your TEMS Paragon tab (http://localhost:8080): opens Cloud and, when TEMS Cloud
// says "Please log in", clicks Log in. The login popup is handled by temsLogin.js (Chrome fills
// your saved password). Finishes once the Cloud assignments are showing.
(async () => {
  const job = await chrome.runtime.sendMessage({ type: "jobState" });
  if (!job || job.kind !== "tems") return;
  if (window.kaamTemsRunning === job.requestId) return; // already running in this page
  window.kaamTemsRunning = job.requestId;

  const appWaitMs = 60000;      // TEMS Paragon page to load
  const stateWaitMs = 20000;    // Cloud page to show either "Log in" or the assignments
  const loginWaitMs = 3 * 60000; // you / Chrome finishing the login popup
  const reclickAfterMs = 30000; // still logged out this long after clicking Log in: click once more
  const maxLoginClicks = 2;

  const debugLog = (text) => chrome.runtime.sendMessage({ type: "log", text: `tems: ${text}` }).catch(() => {});
  const finish = (result) => {
    debugLog(`finished: ${JSON.stringify(result)}`);
    window.kaamTemsRunning = null;
    chrome.runtime.sendMessage({ type: "jobDone", result });
  };

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const textOf = (el) => (el?.innerText || "").trim();
  const waitFor = async (check, timeoutMs, stepMs = 400) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = check();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  };
  // Real mouse click (a user gesture), so TEMS is allowed to open its login popup.
  const realClick = async (el) => {
    // Bring it into view inside its own scrolling panel only. scrollIntoView() would also scroll
    // TEMS's whole page (which never scrolls itself) and leave it shifted up with a blank gap.
    const box = scrollBoxOf(el);
    const view = box ? box.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    let rect = el.getBoundingClientRect();
    if (box && (rect.top < view.top || rect.bottom > Math.min(view.bottom, innerHeight))) {
      box.scrollTop += rect.top - view.top - Math.max(0, (Math.min(view.bottom, innerHeight) - view.top - rect.height) / 2);
      await sleep(150);
    }
    resetPageScroll();
    rect = el.getBoundingClientRect();
    const clicked = await chrome.runtime.sendMessage({
      type: "realClick", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    });
    if (!clicked) el.click();
    setTimeout(resetPageScroll, 400);  // Chrome's debugging bar comes and goes: keep the page in place
  };
  // TEMS's page itself never scrolls (its panels do): if something scrolled it, put it back.
  function resetPageScroll() {
    for (const node of new Set([document.scrollingElement, document.documentElement, document.body])) {
      if (node && (node.scrollTop || node.scrollLeft)) { node.scrollTop = 0; node.scrollLeft = 0; }
    }
  }

  // ---------- reading the TEMS page ----------
  const menuButton = (label) => [...document.querySelectorAll('[class*="SideMenuButton_menu-button"]')]
    .find((el) => isVisible(el) && textOf(el).toLowerCase() === label.toLowerCase());
  const isSelected = (el) => /selected/i.test(el?.className || "");
  const content = () => document.querySelector('[class*="Content_pages"]') || document.body;
  const loginButton = () => {
    const message = [...content().querySelectorAll('[class*="log-in-message"], [class*="CloudAssignmentsProvider"]')]
      .find((el) => isVisible(el) && /please log in/i.test(textOf(el)));
    const scope = message || content();
    return [...scope.querySelectorAll('a, button, [role="button"]')]
      .find((el) => isVisible(el) && /^log\s*in$/i.test(textOf(el)));
  };
  // Logged in: no "Please log in" message, and the Cloud project picker / list is showing.
  const isLoggedIn = () => {
    if (loginButton() || /please log in to tems cloud/i.test(textOf(content()))) return false;
    const picker = [...content().querySelectorAll("select")].some(isVisible);
    return picker || /cloud project/i.test(textOf(content()));
  };
  // ---------- project / WO list and the details card ----------
  const squash = (text) => String(text || "").replace(/\s+/g, "").toLowerCase();
  // The right-hand details card: Cloud's assignment details, or Assign's work order details.
  const detailsCard = () => [...content().querySelectorAll('[class*="card-details"], [class*="CloudAssignmentDetails"], [class*="WorkOrderSelectionDetails"]')]
    .map((el) => el.closest('[class*="Card_card"]') || el.closest("section") || el).find(isVisible) || null;
  // The list card (left): everything in the content area except the details card.
  const inListCard = (el) => !detailsCard()?.contains(el);
  // List rows: <li class="ListItem_main ListItem_clickable"> with the name in "StatusIndicatorName"
  // and the status ("New", "In Progress") in "StatusIndicatorDescription".
  const listRows = () => [...content().querySelectorAll('li[class*="ListItem"]')].filter((el) => isVisible(el) && inListCard(el));
  const rowName = (row) => textOf(row.querySelector('[class*="StatusIndicatorName"]')) || textOf(row).split("\n")[0];
  // The row (the <li> itself - that's what TEMS listens on) for `name`, spaces / case ignored.
  const findRow = (name) => {
    const want = squash(name);
    const row = listRows().find((li) => squash(rowName(li)) === want);
    if (row) return row;
    // Fallback for other markup: the smallest element whose whole text is the name.
    const hits = [...content().querySelectorAll("a, li, div, span")]
      .filter((el) => isVisible(el) && inListCard(el) && squash(el.innerText) === want);
    const hit = hits.find((el) => !hits.some((other) => other !== el && el.contains(other)));
    return hit ? hit.closest('li, a, [role="button"]') || hit : null;
  };
  // A title in the list card that isn't a row: inside a project its name sits next to a back button.
  const titleNamed = (name) => [...content().querySelectorAll("div, span, h1, h2, h3, header, label")]
    .find((el) => isVisible(el) && inListCard(el) && !el.closest("li") && squash(el.innerText) === squash(name)) || null;
  const listBackButton = () => [...content().querySelectorAll('[class*="back-button"], a, button')]
    .find((el) => isVisible(el) && inListCard(el) && !el.closest("li") &&
      (/back-button/i.test(el.className || "") || [...el.querySelectorAll("img")].some((img) => /chevron pointing left|back/i.test(img.alt || "")))) || null;
  const openProjectName = () => {
    const back = listBackButton();
    if (!back) return "";
    for (let node = back.parentElement; node && inListCard(node) && node !== content(); node = node.parentElement) {
      const label = [...node.querySelectorAll("div, span")].find((el) => isVisible(el) && !el.closest("li") &&
        !el.querySelector("select, img") && el !== back && !back.contains(el) && textOf(el) && !/\n/.test(textOf(el)));
      if (label) return textOf(label);
    }
    return "";
  };
  // The project is open once its row is gone from the list and its name shows as the list title.
  const inProject = (name) => !findRowInList(name) && !!titleNamed(name);
  const findRowInList = (name) => listRows().some((li) => squash(rowName(li)) === squash(name));
  const describeList = () => `rows=${listRows().length} first="${listRows().slice(0, 2).map(rowName).join(" | ")}" ` +
    `back=${!!listBackButton()} title="${openProjectName()}"`;
  const detailsShowWo = (wo) => {
    const label = detailsCard()?.querySelector('[class*="CloudAssignmentDetails_label"]');
    return !!label && squash(textOf(label)) === squash(wo);
  };
  const reserveButton = () => [...(detailsCard()?.querySelectorAll('a, button, [role="button"]') || [])]
    .find((el) => isVisible(el) && /^reserve$/i.test(textOf(el))) || null;
  // After Reserve works, TEMS changes that button's label to "Reserved".
  const reservedLabel = () => [...(detailsCard()?.querySelectorAll('a, button, [role="button"]') || [])]
    .find((el) => isVisible(el) && /^reserved$/i.test(textOf(el))) || null;
  const isEnabled = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
    !/disabled/i.test(el.className || "") && getComputedStyle(el).pointerEvents !== "none";
  // Click a row; if nothing happens, try a real mouse click.
  const clickAndWait = async (el, opened) => {
    el.click();
    if (!(await waitFor(opened, 3000))) {
      const fresh = el.isConnected ? el : null;
      if (fresh) await realClick(fresh);
    }
  };
  // Long lists: scroll the list down step by step until the row shows up (or the end).
  const scrollBoxOf = (el) => {
    for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
    }
    return null;
  };
  // Assign rows read "Cloud WO - <WO>" (with "Suspended" etc. under the icon): match on the WO.
  const findAssignRow = (wo) => listRows().find((li) => squash(textOf(li)).includes(squash(wo))) || null;
  const assignDetailsShowWo = (wo) => {
    const label = detailsCard()?.querySelector('[class*="WorkOrderSelectionDetails_label"]');
    return !!label && squash(textOf(label)).includes(squash(wo));
  };
  const detailsButton = (pattern) => [...(detailsCard()?.querySelectorAll('a, button, [role="button"]') || [])]
    .find((el) => isVisible(el) && pattern.test(textOf(el))) || null;
  // Every WO name seen in the lists while searching (for "did you mean ...?" when a WO isn't found).
  const seenNames = new Set();
  const noteNames = () => listRows().forEach((li) => {
    const name = rowName(li).replace(/^\s*cloud\s*wo\s*-\s*/i, "").trim();
    if (name) seenNames.add(name);
  });
  // Wait until the list has loaded and stopped changing (or `done()`), at most maxMs.
  const listSettled = async (done = () => false, maxMs = 8000) => {
    let last = -1, since = Date.now();
    await waitFor(() => {
      if (done()) return true;
      const count = listRows().length;
      if (count !== last) { last = count; since = Date.now(); }
      return count > 0 && Date.now() - since > 1000;
    }, maxMs, 250);
  };
  // The list's scroll box, and whether scrolling loads more rows (most TEMS lists hold every row
  // already - then there's nothing to scroll for).
  const listScrollBox = () => scrollBoxOf([...content().querySelectorAll("li, a, div")].find((el) => isVisible(el) && inListCard(el) && scrollBoxOf(el)));
  const scrollLoadsMore = async (box) => {
    const before = listRows().length;
    box.scrollTop = box.scrollHeight;
    await sleep(700);
    const more = listRows().length !== before;
    box.scrollTop = 0;
    return more;
  };
  // Every name in the current list (Cloud project or Assign), scrolling only if the list loads lazily.
  const collectNames = async () => {
    seenNames.clear();
    await listSettled();
    noteNames();
    const box = listScrollBox();
    if (box && await scrollLoadsMore(box)) {
      for (let step = 0; step < 200; step++) {
        noteNames();
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) break;
        box.scrollTop += Math.max(100, box.clientHeight * 0.8);
        await sleep(250);
      }
      noteNames();
      box.scrollTop = 0;
    }
    return new Set(seenNames);
  };
  const findRowScrolling = async (name, find = findRow) => {
    await listSettled(() => !!find(name));
    let row = find(name);
    noteNames();
    if (row) return row;
    const box = listScrollBox();
    if (!box || !(await scrollLoadsMore(box))) return null;
    for (let step = 0; step < 200; step++) {
      await sleep(250);
      noteNames();
      row = find(name);
      if (row) return row;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) break;
      box.scrollTop += Math.max(100, box.clientHeight * 0.8);
    }
    await sleep(400);
    return find(name);
  };

  // TEMS names for the same WO number and date as `wo` but spelled differently (G23d vs G23e, a
  // missing letter; spaces / case ignored). Closest first, at most 3.
  const editDistance = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  };
  const woParts = (text) => {
    const s = squash(text);
    return { number: (s.match(/^(.*?_\d+)_/) || [])[1] || "", date: (s.match(/_(\d{6})_/) || [])[1] || "" };
  };
  const suggestionsFor = (wo) => {
    const want = squash(wo), parts = woParts(wo);
    return [...seenNames]
      .map((name) => {
        const s = squash(name), p = woParts(name);
        const dist = editDistance(want, s);
        // Same WO number (and date) is required, so LM_137 is never offered for LM_136.
        const sameWo = p.number === parts.number && (!parts.date || p.date === parts.date);
        return { name, dist, ok: s !== want && (parts.number ? sameWo : dist <= 2) };
      })
      .filter((x) => x.ok)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3)
      .map((x) => x.name);
  };

  // The same WO with the script letter swapped: "..._ G23d_2U_..." <-> "..._ G23e_2U_..." (only d / e).
  const twinOf = (wo) => {
    const swapped = String(wo || "").replace(/(_\s*[A-Za-z]\d+)([dDeE])(\s*_)/, (all, head, letter, tail) =>
      head + ({ d: "e", e: "d", D: "E", E: "D" })[letter] + tail);
    return swapped !== wo ? swapped : "";
  };

  // Only used to see when the list stops changing.
  const assignmentCount = () => (textOf(content()).match(/\b(In Progress|Planned|Completed)\b/g) || []).length;

  // Live Testing's Start ticket: Control page, then its play button - only when the app says TEMS
  // has the WO Validated / Paused (canPlay); while it runs, the same button would pause it.
  const playOnControl = async () => {
    const { canPlay = false } = job.data || {};
    const control = await waitFor(() => menuButton("Control"), appWaitMs);
    if (!control) return finish({ ok: false, error: `TEMS Paragon didn't load at ${location.origin}. Is TEMS Paragon running?` });
    if (!isSelected(control)) {
      debugLog("opening Control");
      control.click();
      if (!(await waitFor(() => isSelected(menuButton("Control")), 3000))) await realClick(menuButton("Control") || control);
    }
    const controlShown = !!(await waitFor(() => isSelected(menuButton("Control")), 5000));
    const playButton = () => {
      const box = [...document.querySelectorAll('[class*="WorkOrderControl_container"]')].find(isVisible);
      const buttons = box ? [...box.querySelectorAll('[class*="WorkOrderControl_button"]')].filter(isVisible) : [];
      const main = buttons[buttons.length - 1];  // an error button, if any, comes first
      return main ? main.closest('button, [role="button"]') || main : null;
    };
    const button = await waitFor(playButton, 10000);
    if (!button) return finish({ ok: false, controlShown, error: "TEMS Control is open, but its play button isn't there (no WO open?)." });
    watchNotifications();  // the stationary-test prompt comes later, also when it was already running
    if (!canPlay) return finish({ ok: true, controlShown, played: false, summary: "TEMS Control is open - play isn't ready yet, so it wasn't pressed." });
    if (!isEnabled(button)) return finish({ ok: true, controlShown, played: false, summary: "TEMS Control is open, but its play button is greyed out - not pressed." });
    debugLog("pressing play on Control");
    window.kaamPlaying = true;  // the watcher leaves this warning to the real click below
    await realClick(button);
    // TEMS's driving warning ("Do not attempt to adjust this device while driving...") -> I understand.
    const confirm = await waitFor(() => notificationButton(/do not attempt to adjust this device/i, /^i understand$/i), 8000, 250);
    if (confirm) {
      debugLog("confirming the driving warning: I understand");
      await realClick(confirm);
      await waitFor(() => !notificationButton(/do not attempt to adjust this device/i, /^i understand$/i), 4000);
    }
    window.kaamPlaying = false;
    finish({ ok: true, controlShown, played: true, summary: `TEMS: play pressed on Control${confirm ? " (I understand)" : ""}.` });
  };

  // TEMS pop-ups (UserNotification): the button labelled `label` in a notification whose text
  // matches `text`. The buttons are <a class="Button_button...">, not <button>.
  function notificationButton(text, label) {
    const boxes = [...document.querySelectorAll('[class*="UserNotification_notification-body"]')]
      .filter((box) => isVisible(box) && text.test(textOf(box)));
    for (const box of boxes) {
      const hit = [...box.querySelectorAll('[class*="Button_button"], a, button')]
        .find((el) => isVisible(el) && label.test(textOf(el)));
      if (hit) return hit;
    }
    return null;
  }

  // The test's stage, read from TEMS's own screens:
  //  stationary - "Executing stationary test ..." banner
  //  mobility   - "At the stationary location / Accelerate ... to start mobility test" (stationary done)
  //  complete   - the result page with Submit / Discard / Suspend (stationary + mobility done)
  //  closed     - we pressed Submit / Discard / Suspend (set by those steps)
  function resultControls() {
    return [...document.querySelectorAll('[class*="StandaloneResultPage_controls-section"]')]
      .find((box) => isVisible(box) && /suspend/i.test(textOf(box))) || null;
  }
  function resultButton(label) {
    const box = resultControls();
    return box ? [...box.querySelectorAll('[class*="Button_button"], a, button')]
      .find((el) => isVisible(el) && label.test(textOf(el))) || null : null;
  }
  function stageOnScreen() {
    if (resultControls()) return "complete";
    const banner = [...document.querySelectorAll('[class*="GridStateBanner_banner"]')].find(isVisible);
    const text = textOf(banner);
    if (/executing stationary test/i.test(text)) return "stationary";
    if (/at the stationary location|start mobility test/i.test(text)) return "mobility";
    return "";
  }
  // Tells the app (Live Testing) the stage; sent on every change and every 20 s while watching.
  function reportStage(stage) {
    if (stage) window.kaamStage = stage;
    chrome.runtime.sendMessage({ type: "temsStage", stage: window.kaamStage || "", wo }).catch(() => {});
  }

  // After Start Stationary, this TEMS tab keeps watching for the next hours (plain page clicks -
  // no job is running by then, so no debugger banner):
  //  - the driving warning -> I understand
  //  - "Stopped in the target grid cell ... start the stationary test?" -> OK
  //    (Cancel instead for a few minutes after Submit reopened the WO: no new stationary test)
  //  - "Low UE NR RSRP" / "Good RSRP" -> OK
  //  - the stage (above), reported to the app
  function watchNotifications(hours = 8) {
    window.kaamNotifyUntil = Date.now() + hours * 3600000;
    if (window.kaamNotifyWatch) return;  // already watching: just keep it on longer
    const cancelStationary = () => (window.kaamCancelStationaryUntil || 0) > Date.now();
    const answers = [
      { text: /do not attempt to adjust this device/i, label: () => /^i understand$/i, what: () => "driving warning: I understand",
        skip: () => window.kaamPlaying },  // the play step clicks this one itself
      { text: /start the stationary test/i, label: () => (cancelStationary() ? /^cancel$/i : /^ok$/i),
        what: () => (cancelStationary() ? "stationary test: Cancel (after Submit)" : "stationary test: OK"),
        after: () => { if (cancelStationary()) window.kaamStationaryCancelled = Date.now(); } },
      { text: /low ue nr rsrp|change the stationary location/i, label: () => /^ok$/i, what: () => "Low UE NR RSRP: OK" },
      { text: /good rsrp|this location is good/i, label: () => /^ok$/i, what: () => "Good RSRP: OK" },
    ];
    const press = (el) => {
      const rect = el.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, at));
      }
      el.click();
    };
    const lastPressed = new WeakSet();
    let lastSent = 0;
    window.kaamNotifyWatch = setInterval(() => {
      resetPageScroll();  // a shifted-up TEMS page (blank gap at the bottom) goes back in place
      if (Date.now() > window.kaamNotifyUntil) {
        clearInterval(window.kaamNotifyWatch); window.kaamNotifyWatch = null;
        return;
      }
      for (const answer of answers) {
        if (answer.skip?.()) continue;
        const el = notificationButton(answer.text, answer.label());
        if (!el || lastPressed.has(el)) continue;
        lastPressed.add(el);  // once per pop-up
        debugLog(answer.what());
        press(el);
        answer.after?.();
      }
      // A stage only moves forward on screen; other TEMS pages (Assign...) show none, so keep the last.
      const seen = stageOnScreen();
      if (seen && seen !== window.kaamStage) { debugLog(`stage: ${seen}`); reportStage(seen); lastSent = Date.now(); }
      else if (Date.now() - lastSent > 20000) { reportStage(); lastSent = Date.now(); }
    }, 1000);
  }

  const { action = "test", wo = "", project = "", cloudWo = "", assignWo = "" } = job.data || {};
    // ---------- steps used by the actions ----------
    class Problem extends Error {}
    const goCloud = async () => {
      const button = menuButton("Cloud");
      if (button && !isSelected(button)) {
        debugLog("clicking Cloud");
        await clickAndWait(button, () => isSelected(menuButton("Cloud")));
        await sleep(800);
      }
    };
    const openProject = async () => {
      await goCloud();
      if (inProject(project)) return;
      // "No Cloud project selected" is the project list itself, not an open project.
      if (openProjectName() && !/no cloud project/i.test(openProjectName())) {
        debugLog(`another project is open (${openProjectName()}) - going back to the list`);
        listBackButton()?.click();
        await waitFor(() => !openProjectName(), 5000);
      }
      const projectRow = await waitFor(() => findRow(project), 15000);
      if (!projectRow) throw new Problem(`Project ${project} isn't in TEMS Cloud's list. Check the TEMS project in Settings.`);
      debugLog(`opening project ${project}`);
      await clickAndWait(projectRow, () => inProject(project));
      if (!(await waitFor(() => inProject(project), 10000))) {
        debugLog(`project didn't open - ${describeList()}`);
        throw new Problem(`Clicked project ${project}, but it didn't open.`);
      }
    };
    const cloudRowFor = async (name) => {
      await openProject();
      const row = await findRowScrolling(name);
      if (!row) debugLog(`${name} not in ${project} - ${describeList()}`);
      return row;
    };
    const goAssign = async () => {
      const button = await waitFor(() => menuButton("Assign"), 5000);
      if (!button) throw new Problem("TEMS has no Assign tab.");
      if (!isSelected(button)) {
        debugLog("clicking Assign");
        await clickAndWait(button, () => isSelected(menuButton("Assign")));
        await sleep(800);
      }
    };
    // Assign's refresh button (circling arrows), if there is one.
    const refreshButton = () => [...content().querySelectorAll("a, button")].find((el) => isVisible(el) && inListCard(el) &&
      !el.closest("li") && [...el.querySelectorAll("img")].some((img) => /refresh|reload|sync|update/i.test(img.alt || "")));
    // Looks for `name` on Assign for up to waitMs, pressing refresh now and then (a just-reserved WO
    // can take a moment to show up there).
    const assignRowFor = async (name, waitMs) => {
      await goAssign();
      const end = Date.now() + waitMs;
      let refreshedAt = Date.now();
      for (;;) {
        const row = await findRowScrolling(name, findAssignRow);
        if (row || Date.now() > end) {
          if (!row) debugLog(`${name} not on Assign - ${describeList()}`);
          return row;
        }
        if (Date.now() - refreshedAt > 5000) {
          refreshedAt = Date.now();
          const refresh = refreshButton();
          if (refresh) { debugLog("pressing Assign's refresh"); refresh.click(); }
          else { await goCloud(); await goAssign(); } // no refresh button: switch tabs to reload the list
        }
        await sleep(1500);
      }
    };
    const openCloudDetails = async (name, row) => {
      debugLog(`opening ${name} in ${project}`);
      await clickAndWait(row, () => detailsShowWo(name));
      if (!(await waitFor(() => detailsShowWo(name), 10000))) throw new Problem(`Clicked ${name} in ${project}, but its details didn't open.`);
    };
    const openAssignDetails = async (name, row) => {
      debugLog(`opening ${name} on Assign`);
      await clickAndWait(row, () => assignDetailsShowWo(name));
      if (!(await waitFor(() => assignDetailsShowWo(name), 10000))) throw new Problem(`Clicked ${name} on Assign, but its details didn't open.`);
    };
    const cloudInfo = () => {
      const text = textOf(detailsCard());
      return {
        status: (text.match(/Status:\s*([^\n]+)/i) || [])[1]?.trim() || "?",
        assignee: (text.match(/Assignee:\s*([^\n]+)/i) || [])[1]?.trim() || "?",
      };
    };
    // An "Are you sure?" style popup after a click: press its OK / Yes / Reserve / Open.
    const confirmPopup = async () => {
      await sleep(600);
      const dialogs = [...document.querySelectorAll('[role="dialog"], [class*="Dialog"], [class*="Modal"], [class*="Popup"]')]
        .filter((el) => isVisible(el) && !detailsCard()?.contains(el));
      for (const dialog of dialogs) {
        const ok = [...dialog.querySelectorAll('a, button, [role="button"]')]
          .find((el) => isVisible(el) && /^(ok|yes|confirm|reserve|open|start|continue)$/i.test(textOf(el)));
        if (ok) { debugLog(`pressing "${textOf(ok)}" in a popup`); ok.click(); await sleep(800); return true; }
      }
      return false;
    };
    // Click `button`; done once `changed()` is true. Tries a real mouse click if nothing happens.
    const press = async (button, changed, label) => {
      debugLog(`clicking ${label}`);
      button.click();
      await confirmPopup();
      if (await waitFor(changed, 6000)) return true;
      if (button.isConnected && isVisible(button)) {
        debugLog(`${label}: nothing changed - trying a real click`);
        await realClick(button);
        await confirmPopup();
      }
      return !!(await waitFor(changed, 12000));
    };


  // ---------- Start Stationary when the WO isn't open (after Suspend / Discard TEMS is back on Assign) ----------
  // Assign -> the WO's row -> Open. The app then waits until TEMS has it ready (green) and presses play.
  const openWoForTest = async () => {
    watchNotifications();
    if (!wo) throw new Problem("No WO picked in Live Testing, so nothing to open on Assign.");
    const row = await assignRowFor(wo, 8000);
    if (!row) throw new Problem(`${wo} isn't on TEMS's Assign page.`);
    await openAssignDetails(wo, row);
    const openButton = await waitFor(() => detailsButton(/^(open|start)$/i), 5000);
    if (!openButton) throw new Problem(`${wo} is on Assign, but there's no Open button.`);
    if (!isEnabled(openButton)) throw new Problem(`${wo} is on Assign, but its ${textOf(openButton)} button is greyed out.`);
    const opened = await press(openButton, () => !openButton.isConnected || !isVisible(openButton) ||
      !assignDetailsShowWo(wo) || isSelected(menuButton("Control")), textOf(openButton));
    finish({ ok: true, opened, summary: `TEMS: ${wo} opened from Assign${opened ? "" : " (no visible change yet)"}.` });
  };

  // ---------- the end of a test: Submit / Discard / Suspend ----------
  const clickNotification = async (text, label, waitMs, what) => {
    const button = await waitFor(() => notificationButton(text, label), waitMs, 300);
    if (!button) return false;
    debugLog(`${what}: ${textOf(button)}`);
    await realClick(button);
    await waitFor(() => !notificationButton(text, label), 5000);
    return true;
  };
  const needResultPage = () => {
    if (!resultControls()) throw new Problem("TEMS isn't showing the finished test (Submit / Discard / Suspend) - nothing pressed.");
  };
  // Suspend -> TEMS goes back to Assign and says "Work order summary created" -> OK.
  const suspendRun = async () => {
    needResultPage();
    debugLog("pressing Suspend");
    await realClick(resultButton(/^suspend$/i));
    const ok = await clickNotification(/work order summary created/i, /^ok$/i, 45000, "summary created");
    return ok ? "suspended (summary created, OK)" : "suspended (no \"summary created\" pop-up seen)";
  };
  // The right-hand details panel scrolled to the bottom (Grid Resource etc. in view).
  const scrollDetailsToBottom = async () => {
    const card = detailsCard();
    const box = scrollBoxOf(card?.querySelector("*") || card) || scrollBoxOf(card) ||
      (card && card.scrollHeight > card.clientHeight + 4 ? card : null);
    if (!box) { debugLog("details panel: nothing to scroll"); return; }
    for (let n = 0; n < 3; n++) { box.scrollTop = box.scrollHeight; await sleep(500); }
    resetPageScroll();
    debugLog(`details panel scrolled to ${Math.round(box.scrollTop)} of ${box.scrollHeight - box.clientHeight}`);
    await sleep(800);  // let the map and the panel settle before the picture
  };
  const endRun = async (kind) => {
    watchNotifications();
    if (kind === "suspend") {
      const what = await suspendRun();
      reportStage("closed");
      finish({ ok: true, summary: `TEMS: ${what}.` });
      return;
    }
    if (kind === "discard") {
      needResultPage();
      debugLog("pressing Discard");
      await realClick(resultButton(/^discard$/i));
      const yes = await clickNotification(/discard this work order/i, /^yes$/i, 15000, "discard confirm");
      if (!yes) throw new Problem("Pressed Discard, but TEMS didn't ask to confirm - check the TEMS tab.");
      reportStage("closed");
      finish({ ok: true, summary: "TEMS: discarded (confirmed Yes)." });
      return;
    }
    // Submit (for now): Chrome full window, Suspend, then on Assign: the WO's details scrolled to the
    // bottom, a picture of the page, Open it again and Cancel the stationary test it offers.
    needResultPage();
    await chrome.runtime.sendMessage({ type: "temsWindow", mode: "max" }).catch(() => {});
    try {
      await sleep(800);
      const what = await suspendRun();
      reportStage("closed");
      if (!wo) throw new Problem(`${what}, but no WO is picked in Live Testing, so no picture.`);
      const row = await assignRowFor(wo, 20000);
      if (!row) throw new Problem(`${what}, but ${wo} isn't on Assign - no picture.`);
      await openAssignDetails(wo, row);
      await sleep(1500);  // the details (map, Grid Resource) load
      await scrollDetailsToBottom();
      const shot = await chrome.runtime.sendMessage({ type: "captureTab" }).catch(() => null);
      if (!shot?.dataUrl) throw new Problem(`${what}, but the picture failed${shot?.error ? `: ${shot.error}` : ""}.`);
      debugLog("picture taken");
      // Open it again; TEMS then offers a stationary test - Cancel it (the watcher does), wait for you.
      window.kaamCancelStationaryUntil = Date.now() + 4 * 60000;
      window.kaamStationaryCancelled = 0;
      const openButton = await waitFor(() => detailsButton(/^(open|start)$/i), 8000);
      let reopened = "not reopened (no Open button)";
      if (openButton && isEnabled(openButton)) {
        const opened = await press(openButton, () => !openButton.isConnected || !isVisible(openButton) ||
          !assignDetailsShowWo(wo) || isSelected(menuButton("Control")), textOf(openButton));
        reopened = opened ? "opened again" : "Open clicked (no visible change yet)";
        const cancelled = await waitFor(() => window.kaamStationaryCancelled, 90000, 500);
        reopened += cancelled ? ", stationary test cancelled - waiting for you" : " - no stationary pop-up yet (it gets Cancel when it shows)";
      }
      finish({ ok: true, screenshot: shot.dataUrl, summary: `TEMS: ${what}, picture taken, ${reopened}.` });
    } finally {
      await chrome.runtime.sendMessage({ type: "temsWindow", mode: "restore" }).catch(() => {});
    }
  };

  try {
    resetPageScroll();  // a page left shifted by an older version: back in place first
    if (action === "play") { watchNotifications(); reportStage("started"); await playOnControl(); return; }
    if (action === "openWo") { await openWoForTest(); return; }
    if (["suspend", "discard", "submit"].includes(action)) { await endRun(action); return; }
    // 1. TEMS Paragon loaded, then the Cloud tab.
    const cloud = await waitFor(() => menuButton("Cloud"), appWaitMs);
    if (!cloud) {
      finish({ ok: false, error: `TEMS Paragon didn't load at ${location.origin}. Is TEMS Paragon running?` });
      return;
    }
    if (!isSelected(cloud)) {
      debugLog("clicking Cloud");
      cloud.click();
      if (!(await waitFor(() => isSelected(menuButton("Cloud")), 3000))) await realClick(menuButton("Cloud") || cloud);
    }

    // 2. Logged in already, or the Log in button?
    const state = await waitFor(() => (isLoggedIn() ? "in" : loginButton() ? "out" : null), stateWaitMs);
    if (!state) {
      finish({ ok: false, error: "The TEMS Cloud page didn't show its assignments or a Log in button. Check the TEMS tab." });
      return;
    }

    // 3. Log in: click it; the popup window signs in with Chrome's saved password.
    if (state === "out") {
      let clicks = 0, clickedAt = 0;
      const end = Date.now() + loginWaitMs;
      while (Date.now() < end && !isLoggedIn()) {
        const button = loginButton();
        if (button && clicks < maxLoginClicks && (!clickedAt || Date.now() - clickedAt > reclickAfterMs)) {
          clicks += 1; clickedAt = Date.now();
          debugLog(`clicking Log in (${clicks}/${maxLoginClicks})`);
          await realClick(button);
        }
        await sleep(700);
      }
      if (!isLoggedIn()) {
        finish({ ok: false, error: "Still not logged in to TEMS Cloud. Finish the login in its popup window, then try again." });
        return;
      }
    }


    // 4. Let the Cloud list finish loading (stops changing).
    let last = -1, stableSince = Date.now();
    await waitFor(() => {
      const count = assignmentCount();
      if (count !== last) { last = count; stableSince = Date.now(); }
      return Date.now() - stableSince > 1500;
    }, 15000, 300);
    const loginText = state === "out" ? "Logged in to TEMS Cloud" : "TEMS Cloud was already logged in";
    // action: "find" (where is the WO? nothing clicked), "go" (prod: Reserve in Cloud, then Open on
    // Assign - clicks both), "test" (cloudWo / assignWo: find the buttons, click nothing).
    // listWos (the plan check after an import): every WO name in the Cloud project (scrolled to the
    // end) and on Assign. Only the tabs and the project are clicked - nothing is reserved or opened.
    if (action === "listWos") {
      await openProject();
      const cloudNames = [...(await collectNames())];
      await goAssign();
      const assignNames = [...(await collectNames())];
      debugLog(`listWos: ${cloudNames.length} in ${project}, ${assignNames.length} on Assign`);
      finish({ ok: true, cloudNames, assignNames, backToApp: true,  // back to the app to see the result
        summary: `${loginText}. ${cloudNames.length} WOs in TEMS Cloud (${project}), ${assignNames.length} on Assign.` });
      return;
    }
    if (!wo && !cloudWo && !assignWo) {
      finish({ ok: true, summary: `${loginText} - Cloud assignments loaded. (No WO, so nothing to find.)` });
      return;
    }

    // ---------- actions ----------
    // Where is the WO in TEMS? Reads every name in the Cloud project list and on Assign, then picks
    // the best fit: the WO exactly as given (Cloud, then Assign), else its d/e twin (G23d <-> G23e,
    // everything else identical; Cloud, then Assign). An exact Cloud match can't be beaten, so
    // Assign isn't read then. Returns {name, where, twin} or null (+ suggestions for the popup).
    const locate = async (wo) => {
      const twin = twinOf(wo);
      const pick = (names, want) => want ? [...names].find((name) => squash(name) === squash(want)) : undefined;
      await openProject();
      const cloudNames = await collectNames();
      const exactCloud = pick(cloudNames, wo);
      if (exactCloud) return { name: exactCloud, where: "cloud", twin: false };
      await goAssign();
      const assignNames = await collectNames();
      const all = new Set([...cloudNames, ...assignNames]);
      const choices = [
        [pick(assignNames, wo), "assign", false],
        [pick(cloudNames, twin), "cloud", true],
        [pick(assignNames, twin), "assign", true],
      ];
      debugLog(`${wo}: ${cloudNames.size} names in ${project}, ${assignNames.size} on Assign` +
        (twin ? ` - exact or ${twin}` : ""));
      const [name, where, isTwin] = choices.find(([n]) => n) || [];
      seenNames.clear(); all.forEach((n) => seenNames.add(n)); // for suggestionsFor
      return name ? { name, where, twin: isTwin } : null;
    };
    const notFoundText = (wo, suggestions) => `${wo} isn't in TEMS Cloud (${project}) or on Assign.` +
      (suggestions.length ? ` TEMS has: ${suggestions.join(", ")}.` : "");

    if (action === "find") {
      // Before the ticket is made: is the WO in TEMS (and under which spelling)? Nothing is clicked.
      const spot = await locate(wo);
      if (spot) {
        const where = spot.where === "cloud" ? `in TEMS Cloud (${project})` : "on TEMS's Assign tab";
        if (spot.twin) debugLog(`${wo} not in TEMS, but ${spot.name} is (${spot.where}) - using that`);
        finish({ ok: true, found: spot.where, matchedWo: spot.name,
          summary: spot.twin ? `TEMS has ${spot.name} (not ${wo}) ${where} - using that.`
            : `${wo} is ${where} - it gets ${spot.where === "cloud" ? "reserved" : "opened"} after the ticket.` });
        return;
      }
      const suggestions = suggestionsFor(wo);
      if (suggestions.length) debugLog(`${wo} not found - close names in TEMS: ${suggestions.join(" | ")}`);
      finish({ ok: true, found: null, suggestions, summary: notFoundText(wo, suggestions) });
      return;
    }

    if (action === "go") {
      // Prod: find it (best fit, as above), reserve it in Cloud if it's there, then open it on Assign.
      const spot = await locate(wo);
      if (!spot) {
        const suggestions = suggestionsFor(wo);
        finish({ ok: false, notFound: true, suggestions, error: notFoundText(wo, suggestions) });
        return;
      }
      const name = spot.name;
      if (spot.twin) debugLog(`${wo} not in TEMS, but ${name} is (${spot.where}) - using that`);
      const done = spot.twin ? [`TEMS has it as ${name} (not ${wo})`] : [];
      let cloudRow = null;
      if (spot.where === "cloud") {
        cloudRow = await cloudRowFor(name);
        if (!cloudRow) throw new Problem(`${name} was in ${project} a moment ago, but isn't now. Check the TEMS tab.`);
        await openCloudDetails(name, cloudRow);
        const before = cloudInfo();
        const reserve = await waitFor(() => reserveButton(), 5000);
        if (reserve && isEnabled(reserve)) {
          const reserved = await press(reserve, () => {
            if (reservedLabel()) return true;
            const now = reserveButton();
            return !now || !isEnabled(now) || !/unassigned/i.test(cloudInfo().assignee);
          }, "Reserve");
          if (!reserved) throw new Problem(`Clicked Reserve for ${name} (assignee ${before.assignee}), but it didn't take. Check the TEMS tab.`);
          debugLog(`Reserve done for ${name}${reservedLabel() ? ' (button now says "Reserved")' : ""}`);
          done.push(`reserved in ${project}${reservedLabel() ? " (shows Reserved)" : ` (assignee now ${cloudInfo().assignee})`}`);
        } else if (reservedLabel()) {
          done.push(`already reserved in ${project}`);
        } else {
          done.push(`nothing to reserve in ${project} (status ${before.status}, assignee ${before.assignee})`);
        }
      }
      const assignRow = await assignRowFor(name, cloudRow ? 30000 : 4000);
      if (!assignRow) throw new Problem(`${name}: ${done.join("; ")} - but it didn't show up on Assign. Check the TEMS tab.`);
      await openAssignDetails(name, assignRow);
      const openButton = await waitFor(() => detailsButton(/^(open|start)$/i), 5000);
      if (!openButton) throw new Problem(`${name} is on Assign, but there's no Open button.`);
      if (!isEnabled(openButton)) throw new Problem(`${name} is on Assign, but its ${textOf(openButton)} button is disabled.`);
      const label = textOf(openButton);
      const opened = await press(openButton, () => !openButton.isConnected || !isVisible(openButton) ||
        !assignDetailsShowWo(name) || isSelected(menuButton("Control")), label);
      done.push(opened ? `${label} clicked on Assign` : `${label} clicked on Assign (no visible change yet)`);
      // Then TEMS's Map page, so the drive shows there (the app's Live Testing draws the same map).
      let mapShown = false;
      await waitFor(() => isSelected(menuButton("Control")) || !openButton.isConnected, 8000);
      const mapButton = await waitFor(() => menuButton("Map"), 8000);
      if (mapButton) {
        if (!isSelected(mapButton)) await clickAndWait(mapButton, () => isSelected(menuButton("Map")));
        mapShown = isSelected(menuButton("Map"));
        done.push(mapShown ? "Map page open" : "Map clicked");
      } else debugLog("no Map button in the side menu");
      finish({ ok: true, found: spot.where, matchedWo: name, reserved: !!cloudRow, opened, mapShown, backToApp: true,
        summary: `TEMS: ${name} - ${done.join(", then ")}.` });
      return;
    }

    // action "test": find both buttons for two (possibly different) WOs, click nothing.
    const parts = [];
    let allOk = true;
    if (cloudWo) {
      try {
        const row = await cloudRowFor(cloudWo);
        if (!row) { allOk = false; parts.push(`Cloud: ${cloudWo} isn't in ${project}.`); }
        else {
          await openCloudDetails(cloudWo, row);
          const reserve = await waitFor(() => reserveButton(), 5000);
          const info = cloudInfo();
          if (!reserve && reservedLabel()) parts.push(`Cloud: ${cloudWo} already shows Reserved - nothing to click.`);
          else if (!reserve) { allOk = false; parts.push(`Cloud: ${cloudWo} (status ${info.status}, assignee ${info.assignee}) has no Reserve button.`); }
          else {
            const enabled = isEnabled(reserve);
            debugLog(`TEST Reserve for ${cloudWo}: ${enabled ? "enabled" : "disabled"} - not clicked`);
            parts.push(`Cloud: ${cloudWo} (status ${info.status}, assignee ${info.assignee}) - Reserve found, ${enabled ? "enabled" : "DISABLED"}, not clicked.`);
          }
        }
      } catch (error) { allOk = false; parts.push(`Cloud: ${error.message}`); }
    }
    if (assignWo) {
      try {
        const row = await assignRowFor(assignWo, 4000);
        if (!row) { allOk = false; parts.push(`Assign: ${assignWo} isn't on Assign.`); }
        else {
          await openAssignDetails(assignWo, row);
          const openButton = await waitFor(() => detailsButton(/^(open|start)$/i), 5000);
          const lastRun = textOf(detailsCard()?.querySelector('[class*="WorkOrderSelectionDetails_row"]')) || "";
          if (!openButton) { allOk = false; parts.push(`Assign: ${assignWo} has no Open button.`); }
          else {
            const enabled = isEnabled(openButton);
            debugLog(`TEST ${textOf(openButton)} for ${assignWo}: ${enabled ? "enabled" : "disabled"} - not clicked`);
            parts.push(`Assign: ${assignWo}${lastRun ? ` (${lastRun})` : ""} - ${textOf(openButton)} found, ${enabled ? "enabled" : "DISABLED"}, not clicked.`);
          }
        }
      } catch (error) { allOk = false; parts.push(`Assign: ${error.message}`); }
    }
    const text = `TEST (nothing clicked) · ${parts.join(" ")}`;
    finish(allOk ? { ok: true, summary: text } : { ok: false, error: text });
  } catch (error) {
    finish({ ok: false, error: `TEMS: ${error.message}` });
  }
})();
