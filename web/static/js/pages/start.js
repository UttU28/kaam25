// Start: one cloud start a day (real TechInsights ticket), local starts (LM_N_date) after it.
import { $, api, copyWithFlash, enc, esc, formModal, icon, modal, onDataChange, refreshState, store, toast } from "../core.js";
import { jobPanel, seg, switchEl, woBox } from "../components.js";

export default {
  title: "Start Ticket",
  sub: "Cloud start once a day · local starts after it",
  render(root, params) {
    const settings = store.settings || {};
    let mode = store.state?.cloudStart ? "local" : "cloud";
    let busy = false, lastWo = "", temsDone = null;

    root.innerHTML = `
      <div class="grid colsMainSide">
        <div class="stack">
          <div class="card">
            <div class="cardHead"><h2>Start a WO</h2><span class="hint">Enter starts it</span></div>
            <div class="cardBody stack">
              <div class="modeSlot"></div>
              <div class="modeNote note"></div>
              <div class="woSlot"></div>
              <div class="cloudOpts stack">
                <div class="row wrap chips"></div>
                <div class="submitSlot"></div>
              </div>
              <div class="row"><button class="btn btnPrimary lg block go"></button></div>
              <div class="msg"></div>
              <div class="jobSlot"></div>
            </div>
          </div>
          <div class="card result hidden">
            <div class="cardHead"><h2>Ticket ID</h2><span class="hint resType"></span></div>
            <div class="cardBody">
              <div class="row wrap">
                <div class="resultId"></div><span class="spacer"></span>
                <button class="btn btnGhost copyId">${icon("copy", "sm")}<span>Copy</span></button>
                <button class="btn btnGhost next">${icon("refresh", "sm")}<span>Start next</span></button>
                <button class="btn btnGreen toEnd">Go to End Ticket ${icon("arrow", "sm")}</button>
              </div>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="cardHead"><h2>To start</h2><span class="hint waitCount"></span></div>
            <div class="list listScroll waiting" style="padding:6px 0"></div>
          </div>
        </div>
      </div>`;

    const msg = (text, kind = "info") => { $(".msg", root).innerHTML = text ? `<div class="callout ${kind}">${icon(kind === "ok" ? "check" : kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>` : ""; };
    const job = jobPanel();
    $(".jobSlot", root).replaceWith(job.el);

    const box = woBox({
      placeholder: "Paste a WO, grid key or Ticket ID",
      compact: true, preview: true, showPreview: true,
      picker: {
        label: "To start", empty: "Nothing for today. Import today's plan on Today, or use Move to today in Records for older ones.",
        load: async () => (await api("/api/start/waiting")).map((r) => ({
          wo: r.wo, title: `${r.mapStop ? `${r.mapStop}. ` : ""}${r.cluster || r.wo}`, sub: r.gridKey ? `${r.gridKey}${r.gridCount > 1 ? ` · ${r.gridCount} grids` : ""}` : r.wo,
        })),
      },
      onResolve: (wo, record, matchedBy) => {
        if (busy) return;
        // A different WO: clear the last run's job log and Ticket ID so nothing old is left showing.
        if (wo.replace(/\s+/g, "").toLowerCase() !== String(lastWo || "").replace(/\s+/g, "").toLowerCase()) {
          $(".result", root).classList.add("hidden");
          job.hide();
        }
        if (record?.importedAt && wo) {
          msg(`Found in your imported list${record.cluster ? ` (${record.cluster})` : ""}, ${record.startedAt ? "already started" : "not started yet"}. Grid key and location loaded.`, "info");
        } else if (record && matchedBy && matchedBy !== "wo") {
          msg(matchedBy === "excelWo" ? `This is the Excel spelling of ${wo} (TEMS name) - ${record.startedAt ? "already started" : "not started yet"}. Using ${wo}.` : `Matched this WO (${record.startedAt ? "already started" : "not started yet"}).`, "info");
        } else resetMsg();
      },
      onEnter: () => startClicked(),
    });
    $(".woSlot", root).replaceWith(box.el);

    const modeSeg = seg([{ value: "cloud", label: "Cloud", icon: "cloud" }, { value: "local", label: "Local", icon: "laptop" }],
      mode, (v) => { mode = v; paintMode(); }, "lg");
    $(".modeSlot", root).replaceWith(modeSeg.el);
    const submit = switchEl((on) => on ? "<b>Submit ON</b> · clicks Create, then finds the new Ticket ID" : "<b>Submit OFF</b> · only fills the form, you click Create",
      settings.defaultSubmit ?? true, () => resetMsg());
    $(".submitSlot", root).replaceWith(submit.el);

    function paintChips() {
      const s = store.state || {};
      $(".chips", root).innerHTML = [
        ["Region", settings.region], ["Market", settings.market],
        ["Drive shift", `${s.shift || "—"} <span style="color:var(--faint)">(PM from ${esc(s.pmFrom || "")})</span>`],
        ["Logs from previous day", settings.logsPreviousDay],
      ].map(([k, v]) => `<span class="chip">${k} <b>${v ?? ""}</b></span>`).join("");
    }
    function paintMode(resetMessage = true) {
      const s = store.state || {};
      const cloud = s.cloudStart;
      const cloudText = cloud ? `Today's cloud start: ${cloud.cluster || cloud.wo} · ${cloud.ticketId || "—"}` : "No cloud start yet today";
      $(".cloudOpts", root).classList.toggle("hidden", mode !== "cloud");
      const go = $(".go", root);
      go.className = `btn lg block go ${mode === "cloud" ? "btnPrimary" : "btnPurple"}`;
      go.innerHTML = mode === "cloud" ? `${icon("rocket")}<span>Start cloud ticket</span>` : `${icon("laptop")}<span>Start local</span>`;
      const note = $(".modeNote", root);
      if (mode === "local") { note.className = "modeNote note"; note.innerHTML = `Next ID <b style="color:var(--text);font-family:var(--mono)">${esc(s.nextLocalId || "")}</b> · ${esc(cloudText)}`; }
      else if (cloud) { note.className = "modeNote note warn"; note.textContent = `⚠ ${cloudText}. Only one cloud start a day - use Local unless you need a new ticket.`; }
      else { note.className = "modeNote note"; note.textContent = "First WO of the day: creates the real ticket in TechInsights."; }
      paintChips();
      if (!busy && resetMessage) resetMsg();
    }
    function resetMsg() {
      const tems = store.settings?.temsTestMode
        ? " Then TEMS test mode: asks for two WOs and only checks Reserve / Open."
        : " TEMS first checks the WO is there; after the start it's reserved and opened in TEMS.";
      msg((mode === "local" ? "Marks the WO as started today with an LM_N_date ID instead of a ticket."
        : submit.get() ? "Creates the ticket in TechInsights (in your Chrome) and gets its ID."
        : "Opens Create Ticket in TechInsights and fills it. You click Create yourself.") + tems, "info");
    }

    let waiting = [], dragging = null, loadAgain = false;
    async function loadWaiting() {
      if (dragging) { loadAgain = true; return; }  // don't repaint under your finger: after the drop
      let list = [];
      try { list = await api("/api/start/waiting"); } catch (e) { toast(e.message, "bad"); }
      waiting = list;
      paintWaiting();
    }
    function paintWaiting() {
      const list = waiting;
      box.setPickerCount(list.length);
      $(".waitCount", root).textContent = list.length ? `${list.length} for today${list[0].mapStop ? " · map order" : ""}${list.length > 1 ? " · drag ⋮⋮ to reorder" : ""}` : "";
      $(".waiting", root).innerHTML = list.length ? list.map((r) => `
          <div class="listItem ${list.length > 1 ? "drag" : ""}" data-wo="${esc(r.wo)}" data-key="${esc(r.key)}" ${list.length > 1 ? 'draggable="true"' : ""}>
            ${list.length > 1 ? `<span class="grip" title="Drag to change the order - saved on Maps too">⋮⋮</span>` : ""}
            ${r.mapStop ? `<span class="mapStop" title="Stop ${r.mapStop} on today's map">${r.mapStop}</span>` : ""}
            <div style="min-width:0;flex:1"><div class="t1">${esc(r.cluster || r.wo)}</div><div class="t2">${esc(r.gridKey || r.wo)}${r.gridCount > 1 ? ` · ${r.gridCount} grids` : ""}</div></div>
            ${r.hasLocation ? `<span title="Has a location" style="color:var(--faint)">${icon("pin", "sm")}</span>` : ""}
            <span style="color:var(--faint)">${icon("arrow", "sm")}</span>
          </div>`).join("")
        : `<div class="empty">${icon("sheet")}<p>Nothing for today. Import today's plan on <a href="#/today">Today</a>, or use <b>Move to today</b> in Records for older ones.</p></div>`;
    }
    $(".waiting", root).addEventListener("click", (e) => {
      const item = e.target.closest(".listItem");
      if (item && !busy) { box.set(item.dataset.wo); msg("Picked from your imported list. Press Start (or Enter).", "info"); box.focus(); }
    });

    // ----- drag to reorder: the same order as Maps (saved as today's "Your order" there) -----
    const waitList = $(".waiting", root);
    const clearDrop = () => waitList.querySelectorAll(".dropBefore, .dropAfter").forEach((r) => r.classList.remove("dropBefore", "dropAfter"));
    waitList.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".listItem.drag");
      if (!row) return;
      dragging = row.dataset.key;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragging);
    });
    waitList.addEventListener("dragover", (e) => {
      if (!dragging) return;
      const row = e.target.closest(".listItem.drag");
      if (!row) return;
      e.preventDefault();
      clearDrop();
      if (row.dataset.key === dragging) return;
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? "dropBefore" : "dropAfter");
    });
    waitList.addEventListener("drop", (e) => {
      if (!dragging) return;
      e.preventDefault();
      const row = waitList.querySelector(".dropBefore, .dropAfter");
      const from = dragging;
      if (!row) return;
      const keys = waiting.map((r) => r.key).filter((k) => k !== from);
      let at = keys.indexOf(row.dataset.key);
      if (row.classList.contains("dropAfter")) at += 1;
      keys.splice(at, 0, from);
      saveOrder(keys);
    });
    waitList.addEventListener("dragend", () => {
      waitList.querySelectorAll(".dragging").forEach((r) => r.classList.remove("dragging"));
      clearDrop();
      dragging = null;
      if (loadAgain) { loadAgain = false; loadWaiting(); }
    });
    async function saveOrder(keys) {
      const before = waiting;
      const byKey = new Map(waiting.map((r) => [r.key, r]));
      waiting = keys.map((k, i) => ({ ...byKey.get(k), mapStop: i + 1 }));  // shows at once, numbered 1..n
      paintWaiting();
      try {
        await api("/api/start/order", { body: { keys } });
        toast("Order saved.", "ok", 2200);
      } catch (error) {
        waiting = before; paintWaiting();
        toast(error.message, "bad");
      }
    }

    // ----- start -----
    function setBusy(on) {
      busy = on;
      $(".go", root).disabled = on;
      modeSeg.disable(on);
    }
    function showResult(wo, ticketId, type) {
      lastWo = wo;
      $(".result", root).classList.toggle("hidden", !ticketId);
      $(".resultId", root).textContent = ticketId || "";
      $(".resType", root).textContent = type === "local" ? "Local start · blank on WhatsApp" : "Cloud ticket";
    }
    // ----- TEMS: checked before the ticket, Reserve + Open after it (test mode: check only) -----
    const temsTestMode = () => !!store.settings?.temsTestMode;
    let skipTemsFor = null;  // a WO you chose to start without TEMS
    let openInTems = null;   // the WO TEMS already has active: no Reserve / Open, straight to Live Testing
    async function runTemsJob(request) {
      const { job: started } = await api("/api/tems", { body: request });
      return job.run(started);
    }
    // Prod, before the ticket: is the WO in TEMS (Cloud list or Assign)? If not, offer to fix
    // its name. Returns the WO to start (maybe corrected), or null to stop.
    // action "find": only check (Cloud, before the ticket). "go": check + Reserve + Open in one
    // TEMS visit (Local - nothing to make in between). Returns the WO to use (TEMS's spelling), or null.
    async function temsCheck(wo, action = "find") {
      for (let tries = 0; tries < 5; tries++) {
        msg(action === "go" ? `TEMS: finding ${wo}, reserving it and opening it on Assign… (TEMS tab in Chrome)`
          : `Checking TEMS for ${wo} first… (TEMS tab in Chrome, logs in if needed)`, "info");
        let done;
        try { done = await runTemsJob({ action, wo }); }
        catch (error) { done = { state: "error", error: error.message }; }
        if (done.state === "stopped") { msg("Stopped by you.", "bad"); return null; }
        const r = done.result || {};
        if (done.state === "done" && r.ok && r.found) {
          if (action === "go") temsDone = { wo: r.matchedWo || wo, summary: r.summary };
          // TEMS found it under its d/e twin (the exact name wasn't there): use TEMS's name
          // everywhere (Records too) - already confirmed, so no second check.
          const tems = r.matchedWo || wo;
          if (tems.replace(/\s+/g, "").toLowerCase() !== wo.replace(/\s+/g, "").toLowerCase()) {
            try {
              const renamed = await api("/api/records/rename", { body: { oldWo: wo, newWo: tems } });
              toast(renamed.renamed ? `TEMS has it as ${tems} - updated in Records` : `TEMS has it as ${tems}`, "ok");
            } catch (error) { msg(error.message, "bad"); return null; }
            box.set(tems);
            loadWaiting();
          }
          msg(r.summary, "ok");
          return tems;
        }
        if (done.state !== "done" || (!r.ok && !r.notFound)) {
          // TEMS couldn't be checked (not running, project missing...): start anyway?
          const choice = await modal({
            title: "Couldn't check TEMS",
            body: `${esc(done.error || r.error || "TEMS didn't answer.")}\n\nStart <b>${esc(wo)}</b> without TEMS (no Reserve / Open), or cancel and fix TEMS first?`,
            buttons: [{ label: "Cancel", value: null }, { label: "Start without TEMS", value: "skip", cls: "btnAmber" }],
          });
          if (choice !== "skip") { msg("Not started - TEMS couldn't be checked.", "warn"); return null; }
          skipTemsFor = wo;
          return wo;
        }
        // Not in TEMS under either spelling: ask. Close TEMS names (same number and date) are only
        // offered in the popup - never used without you pressing the button.
        const suggestions = r.suggestions || [];
        const fix = await formModal({
          title: "WO not found in TEMS",
          body: `<b>${esc(wo)}</b> isn't in TEMS Cloud (${esc(store.settings?.temsProject || "")}) or on Assign.\n` +
            (suggestions.length
              ? `TEMS has <b>${suggestions.map(esc).join("</b>, <b>")}</b> - filled in below. Check it and press Use corrected WO.\n`
              : "Please check the WO - a letter may be missing or different (like <b>d</b> vs <b>e</b>).\n") +
            "Type the WO exactly as TEMS shows it; it replaces the current one everywhere (Records too).",
          fields: [{ name: "current", label: "Current WO", value: wo, readonly: true },
                   { name: "fixed", label: "Corrected WO", value: suggestions[0] || wo }],
          buttons: [{ label: "Cancel", value: null }, { label: "Start without TEMS", value: "skip" },
                    { label: "Use corrected WO", value: "fix", cls: "btnPrimary" }],
        });
        if (fix.action === "skip") { skipTemsFor = wo; return wo; }
        if (fix.action !== "fix" || !fix.values.fixed) { msg("Not started - fix the WO and try again.", "warn"); return null; }
        const fixed = fix.values.fixed;
        if (fixed !== wo) {
          try {
            const renamed = await api("/api/records/rename", { body: { oldWo: wo, newWo: fixed } });
            toast(renamed.renamed ? `Renamed in Records: ${wo} → ${fixed}` : `Using ${fixed}`, "ok");
          } catch (error) { msg(error.message, "bad"); return null; }
          box.set(fixed);
          wo = fixed;
          loadWaiting();
        }
      }
      msg("Still not found in TEMS after several tries - check the WO in TEMS.", "bad");
      return null;
    }
    // Ticket started and opened in TEMS (its Map page is up): on to Live Testing for this WO.
    function openLiveTesting(wo) {
      setTimeout(() => { location.hash = `#/live?wo=${encodeURIComponent(wo)}`; }, 1200);
    }
    // After the ticket: prod = Reserve + Open for real; test mode = ask for two WOs, click nothing.
    async function temsFinish(wo, ticketText) {
      // Local: TEMS was already done in the same visit as the check.
      if (temsDone && wo && temsDone.wo.replace(/\s+/g, "").toLowerCase() === wo.replace(/\s+/g, "").toLowerCase()) {
        msg(`${ticketText} ${temsDone.summary}`, "ok"); toast(`TEMS: ${wo} reserved and opened.`, "ok");
        temsDone = null;
        openLiveTesting(wo);
        return;
      }
      if (wo && openInTems === wo) {  // TEMS already has it active (Control / Map): nothing to reserve or open
        msg(`${ticketText} ${wo} is already open in TEMS - on to Live Testing.`, "ok");
        openInTems = null;
        openLiveTesting(wo);
        return;
      }
      if (!wo || skipTemsFor === wo) { if (skipTemsFor === wo) msg(`${ticketText} TEMS skipped.`, "warn"); return; }
      setBusy(true);
      try {
        if (temsTestMode()) {
          let lastAssign = "";
          try { lastAssign = localStorage.getItem("kaamTemsTestAssignWo") || ""; } catch { /* none */ }
          const test = await formModal({
            title: "TEMS test mode - nothing is clicked",
            body: "Pick a WO for each check. Prod mode (Settings → TEMS) reserves and opens the started WO for real.",
            fields: [{ name: "cloudWo", label: "Cloud WO (find Reserve)", value: wo },
                     { name: "assignWo", label: "Assign WO (find Open)", value: lastAssign || store.settings?.temsAssignWo || "" }],
            buttons: [{ label: "Skip", value: null }, { label: "Run test", value: "run", cls: "btnPrimary" }],
          });
          if (test.action !== "run") { msg(`${ticketText} TEMS test skipped.`, "info"); return; }
          try { localStorage.setItem("kaamTemsTestAssignWo", test.values.assignWo); } catch { /* storage blocked */ }
          msg(`${ticketText} TEMS test running… (nothing is clicked)`, "info");
          const done = await runTemsJob({ action: "test", cloudWo: test.values.cloudWo, assignWo: test.values.assignWo });
          const r = done.result || {};
          msg(`${ticketText} ${done.state === "done" ? (r.summary || r.error) : done.error || "Stopped."}`, done.state === "done" && r.ok ? "ok" : "bad");
          return;
        }
        msg(`${ticketText} Now TEMS: reserving ${wo} and opening it on Assign…`, "info");
        const done = await runTemsJob({ action: "go", wo });
        const r = done.result || {};
        if (done.state === "done" && r.ok) {
          msg(`${ticketText} ${r.summary}`, "ok"); toast(`TEMS: ${wo} reserved and opened.`, "ok");
          openLiveTesting(r.matchedWo || wo);
        }
        else msg(`${ticketText} TEMS: ${done.state === "stopped" ? "stopped by you." : r.error || done.error || "didn't finish."}`, "bad");
      } catch (error) {
        msg(`${ticketText} TEMS: ${error.message}`, "bad");
      } finally {
        setBusy(false);
      }
    }
    // Start button / Enter: TEMS check first (prod), then the ticket, then TEMS.
    async function startClicked() {
      let wo = box.get();
      if (!wo) { msg("Enter a WO first.", "bad"); box.focus(); return; }
      if (busy) return;
      skipTemsFor = null; temsDone = null; openInTems = null;
      // First: is a WO already active in TEMS (Control / Map up)? Another one -> say so; this one -> no
      // Reserve / Open needed. (Read from TEMS's own data - nothing is clicked.)
      if (!temsTestMode()) {
        let tems = null;
        try { tems = await api(`/api/tems/active?wo=${enc(wo)}`); } catch { /* TEMS check below says if it can't */ }
        if (tems?.otherWo) {
          const choice = await modal({
            title: "A different WO is running in TEMS",
            body: `The WO you want, <b>${esc(wo)}</b>, isn't running in TEMS - <b>${esc(tems.otherWo)}</b> is (${esc(tems.stateName)}).\n\n` +
              `Finish, suspend or close <b>${esc(tems.otherWo)}</b> in TEMS first, then start again. ` +
              `Or make the ticket now and leave TEMS as it is (no Reserve / Open).`,
            buttons: [{ label: "Cancel", value: null }, { label: "Start ticket, leave TEMS", value: "skip", cls: "btnAmber" }],
          });
          if (choice !== "skip") { msg(`Not started - ${tems.otherWo} is running in TEMS, not ${wo}.`, "warn"); return; }
          skipTemsFor = wo;
          await start();
          return;
        }
        if (tems?.same) {
          openInTems = wo;
          msg(`${wo} is already open in TEMS (${tems.stateName}) - no Reserve / Open needed. Making the ticket…`, "info");
          await start();
          return;
        }
        if (tems?.closed) toast(`${wo} is Closed in TEMS - reopening.`, "info", 6000);
      }
      // Always first: find the WO in TEMS and take TEMS's spelling (d / e) before anything is made.
      // Cloud: check only, then the ticket, then Reserve + Open. Local (prod): one TEMS visit does the
      // check, Reserve and Open, then the local start is saved.
      const action = mode === "local" && !temsTestMode() ? "go" : "find";
      setBusy(true);
      try { wo = await temsCheck(wo, action); } finally { setBusy(false); }
      if (!wo) return;
      await start();
    }

    async function start(force = false, existingTicketId = null) {
      const wo = box.get();
      if (!wo) { msg("Enter a WO first.", "bad"); box.focus(); return; }
      if (busy) return;
      $(".result", root).classList.add("hidden");
      if (mode === "local" && !force) {  // force = re-create the cloud ticket: always cloud
        let started = null;
        try {
          const r = await api("/api/start", { body: { wo, mode: "local" } });
          msg(r.summary, r.isNew ? "ok" : "warn");
          showResult(r.wo, r.ticketId, "local");
          toast(r.isNew ? `Started ${r.ticketId}` : r.summary, r.isNew ? "ok" : "warn");
          started = r;
          await refreshState(); paintMode(false); loadWaiting();
        } catch (error) { msg(`Couldn't save the local start: ${error.message}`, "bad"); }
        if (started) await temsFinish(started.wo, `Local start ${started.ticketId}.`);
        return;
      }
      setBusy(true);
      msg("Opening TechInsights in your Chrome… (watch progress below)", "info");
      let asking = false, created = null;
      try {
        const { job: started } = await api("/api/start", { body: { wo, mode: "cloud", submit: submit.get(), force, existingTicketId } });
        const done = await job.run(started);
        const r = done.result;
        if (done.state !== "done") { msg(done.state === "stopped" ? "Stopped by you." : done.error, "bad"); return; }
        if (r.ask) { asking = true; msg(r.summary, "warn"); setBusy(false); askExisting(r); return; }
        msg(r.summary, "ok");
        showResult(r.wo, r.ticketId, "cloud");
        if (r.ticketId) { toast(`Ticket ${r.ticketId} created.`, "ok"); created = r; }
      } catch (error) {
        msg(error.message, "bad");
      } finally {
        if (!asking) {  // while the "ticket exists" question is open, leave the mode alone
          setBusy(false);
          await refreshState(); autoMode(); loadWaiting();
        }
      }
      if (created) await temsFinish(created.wo, `Ticket ${created.ticketId} created.`);
    }
    function autoMode() {  // after the day's cloud start, the next ones are local
      if (store.state?.cloudStart) { mode = "local"; modeSeg.set(mode); }
      paintMode(false);
    }
    async function askExisting(r) {
      const choice = await modal({
        title: "Ticket already exists",
        body: `TechInsights already has Ticket <b>${esc(r.ticketId)}</b> for\n<b>${esc(r.wo)}</b>\n\n` +
          `<b>Use it</b>: marks this WO as started with ${esc(r.ticketId)}.\n` +
          `<b>Create a new ticket</b>: the WO's details (grid key, location…) stay; the new Ticket ID and today's date replace the old ones.`,
        buttons: [{ label: "Create a new ticket", value: "new", cls: "btnAmber" }, { label: `Use ${r.ticketId}`, value: "use", cls: "btnPrimary" }],
      });
      if (choice === "new") return start(true, r.ticketId);
      if (choice === "use") {
        try {
          const u = await api("/api/start/useExisting", { body: { wo: r.wo, ticketId: r.ticketId, summary: r.summary } });
          msg(u.summary, "ok"); showResult(u.wo, u.ticketId, "cloud");
          await refreshState(); autoMode(); loadWaiting();
          await temsFinish(u.wo, `Using ticket ${u.ticketId}.`);
        } catch (error) { msg(error.message, "bad"); }
      } else {
        msg("Nothing changed - the existing ticket wasn't used and no new one was made.", "warn");
        await refreshState(); autoMode(); loadWaiting();
      }
    }

    $(".go", root).addEventListener("click", () => startClicked());
    $(".copyId", root).addEventListener("click", (e) => copyWithFlash(e.currentTarget, $(".resultId", root).textContent));
    $(".toEnd", root).addEventListener("click", () => { location.hash = `#/end?wo=${encodeURIComponent(lastWo)}`; });
    $(".next", root).addEventListener("click", () => {
      box.set(""); $(".result", root).classList.add("hidden"); job.hide();
      mode = store.state?.cloudStart ? "local" : "cloud"; modeSeg.set(mode); paintMode(); box.focus();
    });

    paintMode();
    loadWaiting();
    if (params.get("wo")) box.set(params.get("wo"));
    else {
      // Nothing carried over: pick the first WO to start (the To start list follows the Maps order).
      api("/api/start/waiting").then((waiting) => {
        if (box.get() || busy || !waiting.length) return;
        box.set(waiting[0].wo);
      }).catch(() => {});
    }
    setTimeout(() => box.focus(), 50);
    // ----- live: chips / next local ID / cloud start on every check; lists and the WO when data changes -----
    const offState = store.on(() => { if (!busy) paintMode(false); });
    const offData = onDataChange(async () => {
      box.refreshPicker();
      if (busy) return;
      loadWaiting();
      const wo = box.get();
    });
    return () => { offState(); offData(); };
  },
};
