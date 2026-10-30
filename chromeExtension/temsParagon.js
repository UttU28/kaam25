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
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    const clicked = await chrome.runtime.sendMessage({
      type: "realClick", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    });
    if (!clicked) el.click();
  };

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
  const findRowScrolling = async (name, find = findRow) => {
    let row = await waitFor(() => find(name), 8000);
    if (row) return row;
    const sample = [...content().querySelectorAll("li, a, div")].find((el) => isVisible(el) && inListCard(el) && scrollBoxOf(el));
    const box = scrollBoxOf(sample);
    if (!box) return null;
    box.scrollTop = 0;
    for (let step = 0; step < 200; step++) {
      await sleep(250);
      row = find(name);
      if (row) return row;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) break;
      box.scrollTop += Math.max(100, box.clientHeight * 0.8);
    }
    await sleep(400);
    return find(name);
  };

  // Only used to see when the list stops changing.
  const assignmentCount = () => (textOf(content()).match(/\b(In Progress|Planned|Completed)\b/g) || []).length;

  try {
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
        finish({ ok: false, error: "Still not logged in to TEMS Cloud. Finish the login in its popup window, then press TEMS again." });
        return;
      }
    }

    // 4. Let the assignments list finish loading (stops changing), then done.
    let last = -1, stableSince = Date.now();
    await waitFor(() => {
      const count = assignmentCount();
      if (count !== last) { last = count; stableSince = Date.now(); }
      return Date.now() - stableSince > 1500;
    }, 15000, 300);
    const loginText = state === "out" ? "Logged in to TEMS Cloud" : "TEMS Cloud was already logged in";
    const { wo, project } = job.data || {};
    if (!wo || !project) {
      finish({ ok: true, summary: `${loginText} - Cloud assignments loaded.${wo ? "" : " (No WO in the box, so nothing to find.)"}` });
      return;
    }

    // 5. The project: already open, or open it from the project list (going back first if
    //    another project is open).
    if (!inProject(project)) {
      if (openProjectName()) {
        debugLog(`another project is open (${openProjectName()}) - going back to the list`);
        listBackButton()?.click();
        await waitFor(() => !openProjectName(), 5000);
      }
      const projectRow = await waitFor(() => findRow(project), 15000);
      if (!projectRow) {
        finish({ ok: false, error: `${loginText}, but project ${project} isn't in the Cloud list. Check TEMS_PROJECT in .env.` });
        return;
      }
      debugLog(`opening project ${project}`);
      await clickAndWait(projectRow, () => inProject(project));
      if (!(await waitFor(() => inProject(project), 10000))) {
        debugLog(`project didn't open - ${describeList()}`);
        finish({ ok: false, error: `Clicked project ${project}, but it didn't open.` });
        return;
      }
    }

    // 6. The WO in the project's list (scrolls through it if it's long).
    const woRow = await findRowScrolling(wo);
    if (!woRow) {
      debugLog(`WO not found - ${describeList()}`);
      const filter = [...content().querySelectorAll("select")].find(isVisible);
      finish({ ok: false, error: `${loginText}; project ${project} is open, but ${wo} isn't in its list` +
        `${filter ? ` (filter: "${filter.selectedOptions[0]?.text || filter.value}")` : ""}.` });
      return;
    }
    debugLog(`opening ${wo}`);
    await clickAndWait(woRow, () => detailsShowWo(wo));
    if (!(await waitFor(() => detailsShowWo(wo), 10000))) {
      finish({ ok: false, error: `Clicked ${wo} in ${project}, but its details didn't open.` });
      return;
    }

    // 7. Reserve: find it and check it's enabled - NOT clicked yet (testing).
    const reserve = await waitFor(() => reserveButton(), 5000);
    const details = detailsCard();
    const status = (textOf(details).match(/Status:\s*([^\n]+)/i) || [])[1]?.trim() || "?";
    const assignee = (textOf(details).match(/Assignee:\s*([^\n]+)/i) || [])[1]?.trim() || "?";
    if (!reserve) {
      finish({ ok: false, error: `${wo} is open (status ${status}, assignee ${assignee}), but there's no Reserve button.` });
      return;
    }
    const enabled = isEnabled(reserve);
    debugLog(`Reserve found for ${wo}: ${enabled ? "enabled - would click it" : "disabled"} (NOT clicked - test mode)`);
    const cloudText = `${loginText} · ${project} · ${wo} (status ${status}, assignee ${assignee}): ` +
      `Reserve found, ${enabled ? "enabled - would click it" : "DISABLED"}, not clicked.`;

    // 8. Assign tab: open the WO there and check its Open button - NOT clicked yet (testing).
    const assignWo = job.data.assignWo;
    if (!assignWo) {
      finish({ ok: true, reserveFound: true, reserveEnabled: enabled, summary: cloudText });
      return;
    }
    const assign = await waitFor(() => menuButton("Assign"), 5000);
    if (!assign) {
      finish({ ok: false, error: `${cloudText} Then: no Assign tab in TEMS.` });
      return;
    }
    if (!isSelected(assign)) {
      debugLog("clicking Assign");
      await clickAndWait(assign, () => isSelected(menuButton("Assign")));
    }
    const assignRow = await findRowScrolling(assignWo, findAssignRow);
    if (!assignRow) {
      debugLog(`assign WO not found - ${describeList()}`);
      finish({ ok: false, error: `${cloudText} Then on Assign: ${assignWo} isn't in the list.` });
      return;
    }
    debugLog(`opening ${assignWo} on Assign`);
    await clickAndWait(assignRow, () => assignDetailsShowWo(assignWo));
    if (!(await waitFor(() => assignDetailsShowWo(assignWo), 10000))) {
      finish({ ok: false, error: `${cloudText} Then on Assign: clicked ${assignWo}, but its details didn't open.` });
      return;
    }
    const openButton = await waitFor(() => detailsButton(/^(open|start)$/i), 5000);
    const lastRun = textOf(detailsCard()?.querySelector('[class*="WorkOrderSelectionDetails_row"]')) || "";
    if (!openButton) {
      finish({ ok: false, error: `${cloudText} Then on Assign: ${assignWo} is open, but there's no Open / Start button.` });
      return;
    }
    const openEnabled = isEnabled(openButton);
    debugLog(`${textOf(openButton)} found for ${assignWo}: ${openEnabled ? "enabled - would click it" : "disabled"} (NOT clicked - test mode)`);
    finish({
      ok: true, reserveFound: true, reserveEnabled: enabled, openFound: true, openEnabled,
      summary: `${cloudText} Assign · ${assignWo}${lastRun ? ` (${lastRun})` : ""}: ` +
        `${textOf(openButton)} found, ${openEnabled ? "enabled - would click it" : "DISABLED"}, not clicked (test mode).`,
    });
  } catch (error) {
    finish({ ok: false, error: `TEMS: ${error.message}` });
  }
})();
