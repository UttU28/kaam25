// Runs on TechInsights. When the Kaam25 app opened the tickets page
// (#kaamWo=...&kaamId=...), it either:
//   - "find" mode: finds the ticket ID for that WO, or
//   - "create" mode: clicks Create Ticket and fills New WO, Region, Market and
//     Drive Shift. With submit on, it then clicks the form's Create button, reloads
//     and finds the new ticket's ID like "find" mode; with submit off it stops there.
// If TechInsights sends you to /login, it clicks Sign In once Chrome has filled your
// saved email and password (it never reads or types them), then goes back to tickets.
(async () => {
  const signInWaitMs = 15000;   // how long to wait for Chrome to fill the login form
  const settleMs = 2000;        // how long a page must stay put before we go back to tickets
  const retrySignInMs = 8000;   // still on the login page this long after clicking: try again
  const searchAfterMs = 5000;   // when to try the page's search box
  const giveUpMs = 55000;       // how long to look for the ticket on the tickets page
  const maxSignInClicks = 2;

  const params = new URLSearchParams(location.hash.slice(1));
  const startWo = params.get("kaamWo");
  const requestId = params.get("kaamId");
  if (startWo && requestId) {
    // Reuse the TechInsights tab from the last run: the job moves there and this tab closes.
    if (await chrome.runtime.sendMessage({ type: "reuseTab", kind: "ticket", url: location.href })) return;
    history.replaceState(null, "", location.pathname + location.search);
    sessionStorage.removeItem("kaamSignInClicks");
    // The app sends the tickets URL, because a redirect to /login keeps the #... part.
    const ticketsUrl = params.get("kaamUrl") || location.origin + location.pathname + location.search;
    await chrome.runtime.sendMessage({
      type: "jobStart", kind: "ticket", requestId,
      data: {
        wo: startWo, ticketsUrl, mode: params.get("kaamMode") || "find",
        region: params.get("kaamRegion") || "", market: params.get("kaamMarket") || "",
        shift: params.get("kaamShift") || "", submit: params.get("kaamSubmit") === "1",
        closeTab: params.get("kaamClose") === "1", logsPreviousDay: params.get("kaamLogsPrev") || "",
        ticketIdWanted: params.get("kaamTicket") || "",
        // Create a new ticket even though this WO already has one (you said Yes in the app).
        force: params.get("kaamForce") === "1",
        // Close Step 3 (Logfile Submittal) values from the app's record.
        logfile: {
          eq3: params.get("kaamEq3") || "", eq6: params.get("kaamEq6") || "",
          gridsTotal: params.get("kaamGridsTotal") || "", gridsTested: params.get("kaamGridsTested") || "",
          gridsSkipped: params.get("kaamGridsSkipped") || "", csvName: params.get("kaamCsv") || "",
        },
      },
    });
  }

  const job = await chrome.runtime.sendMessage({ type: "jobState" });
  if (!job || job.kind !== "ticket") return;
  const { wo, ticketsUrl, mode, region, market, shift, submit, logsPreviousDay, ticketIdWanted, force } = job.data;
  // Ticket IDs that already existed for this WO before we clicked Create: never the "new" one.
  const excludeIds = job.data.excludeIds || [];
  const ticketsPath = new URL(ticketsUrl).pathname;

  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const squashWo = (text) => String(text || "").replace(/\s+/g, "").toLowerCase();
  const debugLog = (text) => chrome.runtime.sendMessage({ type: "log", text }).catch(() => {});
  debugLog(`ticket job running on ${location.pathname}`);
  let timer = null;
  const finish = (result) => {
    debugLog(`finished: ${JSON.stringify(result)}`);
    clearInterval(timer);
    sessionStorage.removeItem("kaamSignInClicks");
    chrome.runtime.sendMessage({ type: "jobDone", result });
  };

  // ---------- finding the ticket ----------
  const rowTicketId = (row) => {
    for (const cell of row.querySelectorAll('td, [role="cell"], [role="gridcell"]')) {
      const value = (cell.innerText || "").trim();
      if (/^\d{5,}$/.test(value)) return value;
    }
    const match = (row.innerText || "").match(/\b\d{6,8}\b/);
    return match ? match[0] : null;
  };

  // Every ticket ID on the page whose row mentions the WO, top (newest) first.
  // Spaces and case are ignored, so "LM_136_ G23e" and "LM_136_G23e" / "LM_136_  G23e" all match.
  const ticketIdsForWo = () => {
    const needle = squashWo(wo);
    const ids = [];
    for (const row of document.querySelectorAll('tr, [role="row"]')) {
      const titles = Array.from(row.querySelectorAll("[title]")).map((e) => e.getAttribute("title"));
      const text = squashWo((row.innerText || "") + " " + titles.join(" "));
      if (!text.includes(needle)) continue;
      const id = rowTicketId(row);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  // With a Ticket ID to look for (the one Start Ticket saved), only that ticket counts, so an
  // older ticket for the same WO is never picked by mistake.
  const findTicketId = () => {
    const ids = ticketIdsForWo().filter((id) => !excludeIds.includes(id));
    if (ticketIdWanted) return ids.includes(ticketIdWanted) ? ticketIdWanted : null;
    return ids[0] || null;
  };

  const typeInSearchBox = () => {
    const searchBox = document.querySelector('input[placeholder^="Search"]');
    if (!searchBox) return false;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    // Search the longest space-free part of the WO, so a different spacing on the site still matches;
    // rows are then checked against the whole WO (spaces ignored).
    const term = wo.split(/\s+/).sort((a, b) => b.length - a.length)[0] || wo;
    setValue.call(searchBox, term);
    searchBox.dispatchEvent(new Event("input", { bubbles: true }));
    searchBox.dispatchEvent(new Event("change", { bubbles: true }));
    for (const type of ["keydown", "keypress", "keyup"]) {
      searchBox.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
      }));
    }
    return true;
  };

  // ---------- signing in ----------
  const findPasswordBox = () => {
    const box = document.querySelector('#password[type="password"], input[type="password"]');
    return isVisible(box) ? box : null;
  };
  const isLoginPage = () => location.pathname.startsWith("/login") || !!findPasswordBox();
  const isFilled = (box) => !!box && (box.matches(":autofill") || box.value.length > 0);
  const findSignInButton = () =>
    [document.querySelector("#form-auth-login-button"),
     ...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .find((el) => isVisible(el) && /^sign in$/i.test((el.value || el.innerText || "").trim()));

  // Real mouse click through the extension, so Chrome releases the saved password.
  const realClick = async (el) => {
    el.scrollIntoView({ block: "center" });
    const rect = el.getBoundingClientRect();
    const clicked = await chrome.runtime.sendMessage({
      type: "realClick", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    });
    if (!clicked) el.click();
  };

  // ---------- filling the Create Ticket form ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, timeoutMs, stepMs = 300) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = check();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  };
  const setInputValue = (input, value) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const clean = (text) => (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isMatch = (text, value) =>
    clean(text) === clean(value) || new RegExp(`\\b${escapeRegex(value)}\\b`, "i").test(text || "");

  // Picks `value` in one of the form's dropdowns, found by its label (e.g. "Region").
  const findLabel = (root, title) => {
    const labels = Array.from(root.querySelectorAll("label")).filter(isVisible);
    return labels.find((el) => clean(el.getAttribute("title")) === clean(title)) ||
           labels.find((el) => clean(el.innerText).replace(/^\*\s*/, "").startsWith(clean(title)));
  };

  const pickDropdown = async (scope, title, value) => {
    const label = findLabel(scope, title) || findLabel(document, title);
    const picker = label && label.closest(".form-group") && label.closest(".form-group").querySelector(".dropdown-picker");
    if (!picker) throw new Error(`Couldn't find the ${title} dropdown.`);
    const shown = () => (picker.querySelector(".dropdown-toggle .placeholder") || {}).innerText || "";
    if (isMatch(shown(), value)) {
      debugLog(`${title} already ${shown().trim()}`);
      return;
    }

    picker.querySelector(".dropdown-toggle").click();
    const menu = picker.querySelector(".dropdown-menu");
    await sleep(300);
    const search = menu && menu.querySelector('input[type="text"]');
    if (search) setInputValue(search, value);

    const item = await waitFor(() => {
      const items = Array.from(menu.querySelectorAll(".dropdown-item:not(.disabled)")).filter(isVisible);
      return items.find((el) => clean(el.innerText) === clean(value)) ||
             items.find((el) => isMatch(el.innerText, value));
    }, 10000);
    if (!item) {
      document.body.click(); // close the menu
      throw new Error(`Couldn't find "${value}" in the ${title} dropdown.`);
    }
    item.click();
    if (!(await waitFor(() => isMatch(shown(), value), 3000))) {
      throw new Error(`Picked "${value}" for ${title}, but it didn't stick.`);
    }
    debugLog(`${title} set to ${shown().trim()}`);
  };

  // A ticket for this WO may already exist (e.g. made by hand): then don't create another.
  const findExistingTicket = async () => {
    await waitFor(() => document.querySelectorAll('tbody tr, [role="row"]').length > 1, 20000);
    await sleep(1000); // let the list finish filling in
    const listed = ticketIdsForWo();
    if (listed.length) return listed[0];
    if (!typeInSearchBox()) return null;
    debugLog("not in the visible list, searching tickets for this WO before creating");
    return (await waitFor(() => ticketIdsForWo()[0], 10000, 500)) || null;
  };

  const fillCreateForm = async () => {
    const existingId = await findExistingTicket();
    if (existingId && !force) {
      debugLog(`a ticket already exists for this WO: ${existingId} - not creating another`);
      return { existingId, existingIds: ticketIdsForWo() };
    }
    if (existingId) debugLog(`ticket(s) ${ticketIdsForWo().join(", ")} exist for this WO - creating a new one anyway (you said Yes)`);

    const createButton = await waitFor(() => Array.from(document.querySelectorAll("button, a"))
      .find((el) => isVisible(el) && /^\s*create ticket\s*$/i.test(el.innerText || "")), 30000);
    if (!createButton) throw new Error("Couldn't find the Create Ticket button.");
    debugLog("clicking Create Ticket");
    createButton.click();

    const newWoInput = await waitFor(() => {
      const el = document.querySelector('input[name="new_wo_if_not_available_in_wo_dropdown"]');
      return isVisible(el) ? el : null;
    }, 20000);
    if (!newWoInput) throw new Error("The Create New Ticket form didn't open.");
    await sleep(1000); // let the form load its own defaults (Drive Tester, Company)

    setInputValue(newWoInput, wo);
    debugLog("New WO filled");
    const scope = newWoInput.closest(".card-pane-body") || document;
    await pickDropdown(scope, "Region", region);
    await pickDropdown(scope, "Market", market);
    await pickDropdown(scope, "Drive Shift", shift);
    if (logsPreviousDay) await pickDropdown(scope, "Logs uploaded from previous day", logsPreviousDay);
    if (!submit) {
      debugLog("form filled - Create NOT clicked (submit is off)");
      return `Create Ticket form filled: New WO, Region ${region}, Market ${market}, ` +
        `Drive Shift ${shift}. Check it and click Create yourself.`;
    }

    // From here the job may only search, so a reload can never create a second ticket.
    // Also remember the tickets already listed for this WO: the new ID must be a different one.
    const olderIds = ticketIdsForWo();
    debugLog(`tickets already listed for this WO: ${olderIds.join(", ") || "none"}`);
    await chrome.runtime.sendMessage({ type: "jobUpdate", data: { mode: "find", excludeIds: olderIds } });
    const formCreateButton = Array.from(document.querySelectorAll("button"))
      .find((el) => isVisible(el) && /^\s*create\s*$/i.test(el.innerText || ""));
    if (!formCreateButton) throw new Error("Form filled, but its Create button wasn't found. Click Create yourself.");
    const formProblems = () => Array.from(scope.querySelectorAll(".invalid-feedback"))
      .map((el) => el.innerText.trim()).filter(Boolean);
    const problemsBefore = new Set(formProblems());
    if (!(await chrome.runtime.sendMessage({ type: "stillWanted" }))) {
      throw new Error("Stopped from the app - Create was not clicked.");
    }
    debugLog("clicking Create");
    formCreateButton.click();

    const outcome = await waitFor(() => {
      if (!document.contains(newWoInput) || !isVisible(newWoInput)) return { done: true };
      const newProblems = formProblems().filter((text) => !problemsBefore.has(text));
      return newProblems.length ? { error: newProblems.join("; ") } : null;
    }, 30000, 500);
    if (!outcome) throw new Error("Clicked Create, but the form didn't close. Check the TechInsights tab.");
    if (outcome.error) throw new Error(`Create was refused: ${outcome.error}`);
    debugLog("ticket created; reloading to find its ID");
    return null; // created: the caller reloads and "find" mode takes over
  };

  // ---------- closing a ticket: Step 1 = "Start Driving" task -> Completed ----------
  // With a saved Ticket ID, only that exact row: never an older ticket for the same WO.
  const findTicketRow = () => {
    const rows = Array.from(document.querySelectorAll('tr[role="row"], tr.k-master-row'));
    if (ticketIdWanted) return rows.find((row) => rowTicketId(row) === ticketIdWanted) || null;
    return rows.find((row) => squashWo(row.innerText).includes(squashWo(wo))) || null;
  };
  const visibleSheet = () => Array.from(document.querySelectorAll(".sheet-modal")).find(isVisible) || null;
  const buttonWithText = (root, pattern) => Array.from(root.querySelectorAll('button, [role="button"]'))
    .find((el) => isVisible(el) && pattern.test((el.innerText || "").trim()));

  // A text/number box in the task panel, found by its label.
  const fillField = async (scope, title, value) => {
    const label = findLabel(scope, title);
    const group = label && label.closest(".form-group");
    const input = group && group.querySelector('input:not([type="file"]):not([type="hidden"]), textarea');
    if (!input) throw new Error(`Couldn't find the ${title} box.`);
    if ((input.value || "").trim() === String(value)) {
      debugLog(`${title} already ${value}`);
      return;
    }
    input.focus();
    setInputValue(input, String(value));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(300);
    if ((input.value || "").trim() !== String(value)) throw new Error(`Typed ${value} in ${title}, but it didn't stick.`);
    debugLog(`${title} set to ${value}`);
  };

  const base64ToBytes = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  // The renamed GridSummary CSV from the app, put in the Grid Summary upload box.
  const attachGridSummary = async (scope) => {
    const label = findLabel(scope, "Grid Summary");
    const group = label && label.closest(".form-group");
    const fileInput = group && group.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("Couldn't find the Grid Summary upload box.");
    const reply = await chrome.runtime.sendMessage({ type: "getFiles" });
    const file = reply && reply.files && reply.files[0];
    if (!file) throw new Error((reply && reply.error) || "Couldn't get the GridSummary CSV from the app.");
    const shortName = file.name.replace(/\.csv$/i, "");
    if ((group.innerText || "").includes(shortName)) {
      debugLog("Grid Summary file already attached");
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(new File([base64ToBytes(file.data)], file.name, { type: "text/csv", lastModified: file.lastModified }));
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    if (!(await waitFor(() => (group.innerText || "").includes(shortName), 8000))) {
      // Some upload boxes only listen for a drop.
      const dropZone = group.querySelector('[class*="drop"], [class*="upload"]') || fileInput.parentElement;
      for (const type of ["dragenter", "dragover", "drop"]) {
        dropZone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
      if (!(await waitFor(() => (group.innerText || "").includes(shortName), 15000))) {
        throw new Error("Put the GridSummary CSV in the Grid Summary box, but it didn't show as attached.");
      }
    }
    debugLog(`Grid Summary attached: ${file.name}`);
    await sleep(1500); // let it finish uploading
  };

  const fillLogfileSubmittal = async (sheet) => {
    const values = job.data.logfile || {};
    const missing = [["EQ3 ID", values.eq3], ["EQ6 ID", values.eq6], ["grids in WO", values.gridsTotal],
      ["grids tested", values.gridsTested], ["grids skipped", values.gridsSkipped], ["GridSummary CSV", values.csvName]]
      .filter(([, value]) => value === "").map(([name]) => name);
    if (missing.length) throw new Error(`Logfile Submittal needs these from the app's record: ${missing.join(", ")}.`);
    await fillField(sheet, "EQ3 [TMO] Actixone Upload ID", values.eq3);
    await fillField(sheet, "EQ6 [TMO] Actixone Upload ID", values.eq6);
    await attachGridSummary(sheet);
    await fillField(sheet, "Num Of Grids in WO", values.gridsTotal);
    await fillField(sheet, "Num Of Grids Tested", values.gridsTested);
    await fillField(sheet, "Num of Grids Skipped", values.gridsSkipped);
    await sleep(800);
  };

  // The close steps, by the task name TechInsights shows in the ticket's Tasks column.
  // fill(sheet) does the task's own fields before Status -> Completed, (Submit,) Save, OK.
  const closeTasks = {
    "start driving": { step: 1, fill: async () => {} },
    "check out": {
      step: 2,
      fill: async (sheet) => {
        await pickDropdown(sheet, "Route Completion Status", "Completed"); // exact: not "Partially Completed"
        await sleep(800);
      },
    },
    // The Tasks column calls it "Upload Collection"; its panel has the Logfile Submittal section.
    // Footer has Save and Close only: Completed, then Save, then OK.
    "upload collection": { step: 3, match: /upload\s*collection/i, fill: fillLogfileSubmittal },
  };
  const taskDefinition = (name) => {
    const key = (name || "").trim().toLowerCase();
    return closeTasks[key] || Object.values(closeTasks).find((def) => def.match && def.match.test(key)) || null;
  };

  const findRowAgain = async () => {
    await waitFor(() => document.querySelectorAll('tbody tr, [role="row"]').length > 1, 20000);
    await sleep(1000);
    let row = findTicketRow();
    if (!row && typeInSearchBox()) {
      debugLog("ticket not in the visible list, searching for the WO");
      row = await waitFor(findTicketRow, 12000, 500);
    }
    if (!row) throw new Error(`Couldn't find the ticket${ticketIdWanted ? ` ${ticketIdWanted}` : ""} for this WO in the tickets list.`);
    return row;
  };
  const rowTaskLinks = (row) => Array.from(row.querySelectorAll(".tasks-column a, .tasks-column button"))
    .filter((el) => (el.innerText || "").trim());

  // One task: open it, fill its fields, Status -> Completed, Save, OK.
  const completeTask = async (taskLink, taskName, definition) => {
    debugLog(`opening the ${taskName} task`);
    taskLink.click();
    const namePattern = new RegExp(escapeRegex(taskName), "i");
    const sheet = await waitFor(() => {
      const el = visibleSheet();
      return el && namePattern.test((el.querySelector(".sheet-header") || el).innerText || "") &&
        el.querySelector(".task-item-status .dropdown-toggle") ? el : null;
    }, 20000);
    if (!sheet) throw new Error(`Clicked ${taskName}, but its task panel didn't open.`);
    await sleep(1200);
    await definition.fill(sheet);

    const statusToggle = sheet.querySelector(".task-item-status .dropdown-toggle");
    const statusShown = () => (statusToggle.innerText || "").trim();
    if (!/^completed$/i.test(statusShown())) {
      statusToggle.click();
      const completedItem = await waitFor(() => Array.from(sheet.querySelectorAll(".task-item-status .dropdown-item"))
        .find((el) => isVisible(el) && /^\s*completed\s*$/i.test(el.innerText || "")), 8000);
      if (!completedItem) throw new Error("Opened the Status dropdown, but Completed wasn't in it.");
      completedItem.click();
      if (!(await waitFor(() => /completed/i.test(statusShown()), 4000))) {
        throw new Error("Picked Completed, but the Status didn't change.");
      }
    }
    debugLog("Status set to Completed, letting the other fields fill in");
    await sleep(2500);

    if (definition.submit) {
      const submitButton = buttonWithText(sheet, /^submit$/i);
      if (!submitButton) throw new Error("Status is Completed, but the Submit button wasn't found. Click Submit and Save yourself.");
      const problemsBefore = new Set(Array.from(sheet.querySelectorAll(".invalid-feedback"))
        .map((el) => el.innerText.trim()).filter(Boolean));
      if (!(await chrome.runtime.sendMessage({ type: "stillWanted" }))) {
        throw new Error("Stopped from the app - Submit was not clicked.");
      }
      debugLog("clicking Submit");
      submitButton.click();
      await sleep(3000);
      const newProblems = Array.from(sheet.querySelectorAll(".invalid-feedback"))
        .map((el) => el.innerText.trim()).filter((text) => text && !problemsBefore.has(text));
      if (newProblems.length) throw new Error(`Submit was refused: ${newProblems.join("; ")}`);
    }

    const saveButton = buttonWithText(sheet.querySelector(".sheet-footer") || sheet, /^save$/i);
    if (!saveButton) throw new Error("Status is Completed, but the Save button wasn't found. Click Save yourself.");
    if (!(await chrome.runtime.sendMessage({ type: "stillWanted" }))) {
      throw new Error("Stopped from the app - Save was not clicked.");
    }
    debugLog("clicking Save");
    saveButton.click();

    const okButton = await waitFor(() => {
      const box = Array.from(document.querySelectorAll(".modal-content")).find(
        (el) => isVisible(el) && /complete/i.test(el.innerText || ""));
      return box ? buttonWithText(box.querySelector(".modal-footer") || box, /^ok$/i) : null;
    }, 15000);
    if (!okButton) throw new Error("Clicked Save, but the \"Save & Complete\" confirmation didn't show up.");
    debugLog("confirming: OK");
    okButton.click();
    if (!(await waitFor(() => !isVisible(okButton), 15000))) {
      throw new Error("Clicked OK, but the confirmation didn't close. Check the TechInsights tab.");
    }
    await sleep(2500);
  };

  // Runs once per page load: do the ticket's current task if it's one we know, then reload
  // (so the Tasks column updates) and the next page load does the next one.
  // Steps done by hand before this run are worked out from the ticket's current task: if it shows
  // Check Out, Start Driving was already done; if it shows none of ours, all of ours were done.
  const runNextCloseStep = async () => {
    const stepsDone = job.data.stepsDone || [];
    const knownSteps = Object.values(closeTasks).map((def) => def.step).sort((a, b) => a - b);
    const row = await findRowAgain();
    debugLog(`found ticket ${rowTicketId(row)}`);
    // The Tasks column can fill in a moment after the row.
    await waitFor(() => rowTaskLinks(row).length > 0, 5000, 300);
    const links = rowTaskLinks(row);
    const names = links.map((el) => el.innerText.trim());
    debugLog(`ticket tasks: ${names.join(", ") || "(none)"}`);
    const index = names.findIndex((name) => taskDefinition(name));
    if (index < 0) {
      // No open tasks at all: every step was done. An unknown task: we can't tell where it sits,
      // so only what we already worked out counts as done by hand.
      const alreadyDone = job.data.alreadyDone ||
        (names.length ? [] : knownSteps.filter((step) => !stepsDone.includes(step)));
      return { finished: true, stepsDone, alreadyDone, nextTasks: names };
    }
    const taskName = names[index];
    const definition = taskDefinition(taskName);
    if (stepsDone.includes(definition.step)) {
      throw new Error(`"${taskName}" still shows after it was completed - check the ticket in TechInsights.`);
    }
    if (!job.data.alreadyDone) {
      const alreadyDone = knownSteps.filter((step) => step < definition.step && !stepsDone.includes(step));
      job.data.alreadyDone = alreadyDone;
      await chrome.runtime.sendMessage({ type: "jobUpdate", data: { alreadyDone } });
      if (alreadyDone.length) debugLog(`step ${alreadyDone.join(", ")} already done by hand, starting at ${taskName}`);
    }
    await completeTask(links[index], taskName, definition);
    stepsDone.push(definition.step);
    await chrome.runtime.sendMessage({ type: "jobUpdate", data: { stepsDone } });
    debugLog(`Step ${definition.step} (${taskName}) done, refreshing for the next task`);
    return { reload: true };
  };

  // ---------- main loop ----------
  let isCreating = false;
  let lastPath = location.pathname;
  let pathSince = Date.now();
  let loginSeenAt = null;
  let ticketsSeenAt = null;
  let signInClickedAt = null;
  let lastLoginState = "";
  let hasSearched = false;
  let redirected = false;

  timer = setInterval(() => {
    const path = location.pathname;
    if (path !== lastPath) { lastPath = path; pathSince = Date.now(); }

    if (isLoginPage()) {
      ticketsSeenAt = null;
      loginSeenAt = loginSeenAt || Date.now();
      if (signInClickedAt && Date.now() - signInClickedAt < retrySignInMs) return; // let it submit
      const passwordBox = findPasswordBox();
      const signIn = findSignInButton();
      const loginState = `login page: passwordBox=${!!passwordBox} autofill=${!!passwordBox && passwordBox.matches(":autofill")} ` +
        `valueLength>0=${!!passwordBox && passwordBox.value.length > 0} signInButton=${signIn ? signIn.id || "found" : "none"}`;
      if (loginState !== lastLoginState) { lastLoginState = loginState; debugLog(loginState); }
      if (isFilled(passwordBox) && signIn) {
        const clicks = Number(sessionStorage.getItem("kaamSignInClicks") || 0);
        if (clicks >= maxSignInClicks) {
          finish({ error: "Couldn't sign in to TechInsights. Sign in in Chrome, then try again." });
          return;
        }
        sessionStorage.setItem("kaamSignInClicks", String(clicks + 1));
        signInClickedAt = Date.now();
        debugLog(`clicking Sign In (attempt ${clicks + 1})`);
        realClick(signIn);
      } else if (!signInClickedAt && Date.now() - loginSeenAt > signInWaitMs) {
        finish({ error: "TechInsights wants you to log in, and Chrome didn't fill a saved password. Sign in in Chrome, then try again." });
      }
      return;
    }
    loginSeenAt = null;
    signInClickedAt = null;

    if (path.startsWith(ticketsPath) && mode === "close") {
      if (isCreating) return;
      isCreating = true; // (one run per page)
      clearInterval(timer);
      debugLog("on tickets page, closing: looking at the ticket's current task");
      runNextCloseStep().then(
        (result) => {
          if (result.reload) {
            setTimeout(() => location.reload(), 1500); // the next page load does the next task
            return;
          }
          const listSteps = (steps) => `step${steps.length > 1 ? "s" : ""} ${steps.join(" and ")}`;
          const parts = [];
          if (result.alreadyDone.length) parts.push(`${listSteps(result.alreadyDone)} already done by hand`);
          if (result.stepsDone.length) parts.push(`did ${listSteps(result.stepsDone)}`);
          const next = result.nextTasks.length
            ? ` Next task: ${result.nextTasks.join(", ")} (not automated yet).`
            : " The ticket shows no open tasks.";
          // Nothing left for you on the ticket: close the tab. A task still to do by hand: keep it open.
          finish({ ok: true, stepsDone: result.stepsDone, alreadyDone: result.alreadyDone,
                   summary: `Done: ${parts.join(", ") || "nothing to do"}.${next}`, closeTab: !result.nextTasks.length });
        },
        async (error) => {
          const latest = await chrome.runtime.sendMessage({ type: "jobState" });
          const data = (latest && latest.data) || job.data;
          finish({ error: error.message, stepsDone: data.stepsDone || [], alreadyDone: data.alreadyDone || [] });
        });
      return;
    }

    if (path.startsWith(ticketsPath) && mode === "create") {
      if (isCreating) return;
      isCreating = true;
      clearInterval(timer);
      debugLog("on tickets page, opening Create Ticket");
      fillCreateForm().then(
        (result) => {
          if (result && result.existingId) {
            finish({ ticketId: result.existingId, existing: true, existingIds: result.existingIds, closeTab: true });
          } else if (result) {
            finish({ ok: true, summary: result });
          } else {
            setTimeout(() => location.reload(), 1500); // created: "find" mode takes over after reload
          }
        },
        (error) => finish({ error: error.message }));
      return;
    }

    if (path.startsWith(ticketsPath)) {
      if (!ticketsSeenAt) debugLog("on tickets page, looking for the WO");
      ticketsSeenAt = ticketsSeenAt || Date.now();
      const ticketId = findTicketId();
      if (ticketId) {
        finish({ ticketId, olderIds: excludeIds, closeTab: true }); // nothing left to do in this tab
        return;
      }
      // Not in the visible rows after a few seconds: use the page's search box.
      if (!hasSearched && Date.now() - ticketsSeenAt > searchAfterMs) hasSearched = typeInSearchBox();
      const others = ticketIdsForWo();
      if (ticketIdWanted && others.length && hasSearched && Date.now() - ticketsSeenAt > searchAfterMs + 12000) {
        finish({ error: `Ticket ${ticketIdWanted} (the one saved in the app) isn't listed for this WO - ` +
                        `TechInsights shows ${others.join(", ")}. Stopped so the wrong ticket isn't used.`,
                 otherIds: others });
        return;
      }
      if (Date.now() - ticketsSeenAt > giveUpMs) {
        const listed = ticketIdsForWo();
        finish({ error: excludeIds.length && listed.length
          ? `The tickets page only shows the older ticket(s) ${listed.join(", ")} for this WO, not a new one.`
          : "No ticket found for this WO on the tickets page." });
      }
      return;
    }

    // Signed in but landed somewhere else (e.g. the home page): go back to tickets.
    if (!redirected && Date.now() - pathSince > settleMs) {
      redirected = true;
      debugLog(`signed in, on ${path}; going to the tickets page`);
      location.assign(ticketsUrl);
    }
  }, 700);
})();
