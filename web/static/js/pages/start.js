// Start: one cloud start a day (real TechInsights ticket), local starts (LM_N_date) after it.
import { $, api, copyWithFlash, enc, esc, icon, modal, onDataChange, refreshState, store, toast } from "../core.js";
import { jobPanel, locationCard, seg, switchEl, woBox } from "../components.js";

export default {
  title: "Start Ticket",
  sub: "Cloud start once a day · local starts after it",
  render(root, params) {
    const settings = store.settings || {};
    let mode = store.state?.cloudStart ? "local" : "cloud";
    let busy = false, lastWo = "";

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
              <div class="row"><button class="btn btnGhost lg block tems" title="Open TEMS Paragon's Cloud tab in Chrome and log in to TEMS Cloud if needed">${icon("cloud")}<span>TEMS</span></button></div>
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
          <div class="locSlot"></div>
          <div class="card">
            <div class="cardHead"><h2>Import plan</h2><span class="hint">Excel or CSV · team ${esc(settings.employeeId || "")} only</span></div>
            <div class="cardBody stack">
              <label class="dropzone">${icon("sheet", "lg")}<div><b>Drop the day's plan here</b> or click to pick</div>
                <div class="note">Columns are found by their values, so header names don't matter.</div>
                <input type="file" accept=".xlsx,.xlsm,.csv,.xls" hidden></label>
              <div class="importMsg"></div>
            </div>
          </div>
          <div class="card">
            <div class="cardHead"><h2>To start</h2><span class="hint waitCount"></span></div>
            <div class="list listScroll waiting" style="padding:6px 0"></div>
          </div>
        </div>
      </div>`;

    const msg = (text, kind = "info") => { $(".msg", root).innerHTML = text ? `<div class="callout ${kind}">${icon(kind === "ok" ? "check" : kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>` : ""; };
    const loc = locationCard();
    $(".locSlot", root).replaceWith(loc.el);
    const job = jobPanel();
    $(".jobSlot", root).replaceWith(job.el);

    const box = woBox({
      placeholder: "Paste a WO, grid key or Ticket ID",
      picker: {
        label: "To start", empty: "Nothing imported to start. Import the day's plan.",
        load: async () => (await api("/api/start/waiting")).map((r) => ({
          wo: r.wo, title: r.cluster || r.wo, sub: r.gridKey ? `${r.gridKey}${r.gridCount > 1 ? ` · ${r.gridCount} grids` : ""}` : r.wo,
        })),
      },
      onResolve: (wo, record, matchedBy) => {
        loc.show(wo, record);
        if (busy) return;
        if (record?.importedAt && wo) {
          msg(`Found in your imported list${record.cluster ? ` (${record.cluster})` : ""}, ${record.startedAt ? "already started" : "not started yet"}. Grid key and location loaded.`, "info");
        } else if (record && matchedBy && matchedBy !== "wo") {
          msg(`Matched this WO (${record.startedAt ? "already started" : "not started yet"}).`, "info");
        } else resetMsg();
      },
      onEnter: () => start(),
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
      msg(mode === "local" ? "Marks the WO as started today with an LM_N_date ID instead of a ticket. No TechInsights, nothing opens in Chrome."
        : submit.get() ? "Creates the ticket in TechInsights (in your Chrome) and gets its ID. Saved to Records."
        : "Opens Create Ticket in TechInsights and fills it. You click Create yourself.", "info");
    }

    async function loadWaiting() {
      let list = [];
      try { list = await api("/api/start/waiting"); } catch (e) { toast(e.message, "bad"); }
      box.setPickerCount(list.length);
      $(".waitCount", root).textContent = list.length ? `${list.length} imported` : "";
      $(".waiting", root).innerHTML = list.length ? list.map((r) => `
          <div class="listItem" data-wo="${esc(r.wo)}">
            <div style="min-width:0;flex:1"><div class="t1">${esc(r.cluster || r.wo)}</div><div class="t2">${esc(r.gridKey || r.wo)}${r.gridCount > 1 ? ` · ${r.gridCount} grids` : ""}</div></div>
            ${r.hasLocation ? `<span title="Has a location" style="color:var(--faint)">${icon("pin", "sm")}</span>` : ""}
            <span style="color:var(--faint)">${icon("arrow", "sm")}</span>
          </div>`).join("")
        : `<div class="empty">${icon("sheet")}<p>Nothing imported to start.</p></div>`;
    }
    $(".waiting", root).addEventListener("click", (e) => {
      const item = e.target.closest(".listItem");
      if (item && !busy) { box.set(item.dataset.wo); msg("Picked from your imported list. Press Start (or Enter).", "info"); box.focus(); }
    });

    // ----- import -----
    const fileInput = $("input[type=file]", root), zone = $(".dropzone", root);
    const importFile = async (file) => {
      if (!file) return;
      const form = new FormData(); form.append("file", file);
      $(".importMsg", root).innerHTML = `<div class="note">Reading ${esc(file.name)}…</div>`;
      try {
        const r = await api("/api/import", { form });
        const parts = [`Imported ${r.count} WOs from ${r.source}`, `${r.added} new`];
        if (r.updated) parts.push(`${r.updated} already in Records`);
        if (r.alreadyStarted) parts.push(`${r.alreadyStarted} already started`);
        let text = parts.join(" · ") + ".";
        if (r.notes?.length) text += "\n" + r.notes.map((n) => `• ${n}`).join("\n");
        $(".importMsg", root).innerHTML = `<div class="callout ${r.notes?.length ? "warn" : "ok"}">${icon(r.notes?.length ? "alert" : "check", "sm")}<div>${esc(text)}</div></div>`;
        toast(`Imported ${r.count} WOs.`, "ok");
        loadWaiting(); refreshState(); box.refresh();
      } catch (error) {
        $(".importMsg", root).innerHTML = `<div class="callout bad">${icon("alert", "sm")}<div>${esc(error.message)}</div></div>`;
      } finally { fileInput.value = ""; }
    };
    fileInput.addEventListener("change", () => importFile(fileInput.files[0]));
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); importFile(e.dataTransfer.files[0]); });

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
    async function start(force = false, existingTicketId = null) {
      const wo = box.get();
      if (!wo) { msg("Enter a WO first.", "bad"); box.focus(); return; }
      if (busy) return;
      $(".result", root).classList.add("hidden");
      if (mode === "local" && !force) {  // force = re-create the cloud ticket: always cloud
        try {
          const r = await api("/api/start", { body: { wo, mode: "local" } });
          msg(r.summary, r.isNew ? "ok" : "warn");
          showResult(r.wo, r.ticketId, "local");
          toast(r.isNew ? `Started ${r.ticketId}` : r.summary, r.isNew ? "ok" : "warn");
          await refreshState(); paintMode(false); loadWaiting();
        } catch (error) { msg(`Couldn't save the local start: ${error.message}`, "bad"); }
        return;
      }
      setBusy(true);
      msg("Opening TechInsights in your Chrome… (watch progress below)", "info");
      let asking = false;
      try {
        const { job: started } = await api("/api/start", { body: { wo, mode: "cloud", submit: submit.get(), force, existingTicketId } });
        const done = await job.run(started);
        const r = done.result;
        if (done.state !== "done") { msg(done.state === "stopped" ? "Stopped by you." : done.error, "bad"); return; }
        if (r.ask) { asking = true; msg(r.summary, "warn"); setBusy(false); askExisting(r); return; }
        msg(r.summary, "ok");
        showResult(r.wo, r.ticketId, "cloud");
        if (r.ticketId) toast(`Ticket ${r.ticketId} created.`, "ok");
      } catch (error) {
        msg(error.message, "bad");
      } finally {
        if (!asking) {  // while the "ticket exists" question is open, leave the mode alone
          setBusy(false);
          await refreshState(); autoMode(); loadWaiting();
        }
      }
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
        } catch (error) { msg(error.message, "bad"); }
      } else {
        msg("Nothing changed - the existing ticket wasn't used and no new one was made.", "warn");
        await refreshState(); autoMode(); loadWaiting();
      }
    }

    $(".go", root).addEventListener("click", () => start());
    // TEMS (test button for now - later the last step of Start): Cloud tab + TEMS Cloud login.
    $(".tems", root).addEventListener("click", async (e) => {
      const button = e.currentTarget;
      if (busy) return;
      button.disabled = true;
      const wo = box.get();
      msg(`Opening TEMS in your Chrome… (Cloud tab, Log in if needed${wo ? `, then finds ${wo} and checks Reserve - not clicked` : ""})`, "info");
      try {
        const { job: started } = await api("/api/tems", { body: { wo } });
        const done = await job.run(started);
        if (done.state === "done") { msg(done.result.summary, "ok"); toast(wo ? `TEMS: ${wo} found.` : "TEMS Cloud is ready.", "ok"); }
        else msg(done.state === "stopped" ? "Stopped by you." : done.error, "bad");
      } catch (error) { msg(error.message, "bad"); }
      finally { button.disabled = false; }
    });
    $(".copyId", root).addEventListener("click", (e) => copyWithFlash(e.currentTarget, $(".resultId", root).textContent));
    $(".toEnd", root).addEventListener("click", () => { location.hash = `#/end?wo=${encodeURIComponent(lastWo)}`; });
    $(".next", root).addEventListener("click", () => {
      box.set(""); $(".result", root).classList.add("hidden"); job.hide();
      mode = store.state?.cloudStart ? "local" : "cloud"; modeSeg.set(mode); paintMode(); box.focus();
    });

    paintMode();
    loadWaiting();
    if (params.get("wo")) box.set(params.get("wo"));
    setTimeout(() => box.focus(), 50);
    // ----- live: chips / next local ID / cloud start on every check; lists and the WO when data changes -----
    const offState = store.on(() => { if (!busy) paintMode(false); });
    const offData = onDataChange(async () => {
      box.refreshPicker();
      if (busy) return;
      loadWaiting();
      const wo = box.get();
      if (wo) { try { loc.show(wo, await api(`/api/records/${enc(wo)}`)); } catch { /* not in Records */ } }
    });
    return () => { offState(); offData(); };
  },
};
