// End: find + verify the ticket (cloud) or skip that (local), copy GridSummary, upload EQ3/EQ6,
// build the report, save it, share it on WhatsApp, mark the ticket done.
import { $, api, copyText, copyWithFlash, enc, esc, flash, formatReport, icon, modal, onDataChange, refreshState, setWhatsappSend, store, toast } from "../core.js";
import { jobPanel, redoBox, seg, switchEl, woBox } from "../components.js";

export default {
  title: "End Ticket",
  sub: "Report updates live · Ctrl+Enter copies it",
  render(root, params) {
    const settings = store.settings || {};
    const defaults = settings.defaults || { total: "1", attempted: "1", skipped: "0", status: "PASSED" };
    let record = null, loadedKey = null, busy = false;
    let shownKey = "";     // the WO the form is showing; a different one clears everything first
    let nextMsg = null;    // message to show once the new WO is in (it would be cleared otherwise)

    root.innerHTML = `
      <div class="grid cols2" style="align-items:start">
        <div class="card">
          <div class="cardHead"><h2>Details</h2><span class="hint">Enter in the WO box runs it</span>
            <button class="btn btnGreen sm endAll hidden" title="Every WO in Today's open: all uploads first, then the WhatsApp shares one by one (only the ones that ended and weren't shared yet)">${icon("check", "sm")}<span class="endAllLabel">End Tickets</span></button></div>
          <div class="cardBody stack">
            <div class="woSlot"></div>
            <div class="field">
              <label class="label">Ticket ID</label>
              <div class="inputGroup">
                <input class="input mono fTicket" placeholder="Found automatically, or type it" spellcheck="false">
                <button class="btn btnPrimary run" style="min-width:150px"></button>
              </div>
            </div>
            <div class="msg"></div>
            <div class="redoSlot"></div>
            <div class="jobSlot"></div>
            <div class="field">
              <label class="label">EQ Job IDs</label>
              <div class="inputGroup">
                <input class="input mono fEq3" placeholder="EQ3 Job ID (AJO-TX-…)" spellcheck="false">
                <input class="input mono fEq6" placeholder="EQ6 Job ID (AJO-TX-…)" spellcheck="false">
                <button class="btn btnGhost saveEq" title="Save typed Job IDs - End won't upload those again">${icon("save", "sm")}<span>Save</span></button>
              </div>
            </div>
            <div class="formGrid">
              <div class="field"><label class="label">Total grids</label><input class="input fTotal" inputmode="numeric"></div>
              <div class="field"><label class="label">Grids attempted</label><div class="attSlot"></div></div>
              <div class="field"><label class="label">Grids skipped</label><div class="skipSlot"></div></div>
            </div>
            <div class="field"><label class="label">Status</label><div class="statusSlot"></div></div>
            <div class="field"><label class="label">Remarks (optional)</label><textarea class="textarea fRemarks" rows="2"></textarea></div>
            <div class="field">
              <label class="label">Folder name</label>
              <div class="inputGroup">
                <input class="input mono fFolder" readonly>
                <button class="btn btnGhost copyFolder">${icon("copy", "sm")}<span>Copy</span></button>
                <button class="btn btnGhost openFile" title="Show the renamed CSV in Explorer">${icon("folder", "sm")}<span>Open file</span></button>
              </div>
            </div>
          </div>
        </div>
        <div class="stack stickyCol">
          <div class="card">
            <div class="cardHead"><h2>Report</h2><span class="hint savedHint"></span></div>
            <div class="cardBody stack">
              <pre class="pre tall report"></pre>
              <div class="row wrap"><div class="waSlot"></div><span class="spacer"></span><span class="note">Group: <b style="color:var(--text)">${esc(settings.whatsappGroup || "")}</b></span></div>
              <div class="toolbar">
                <button class="btn btnPrimary copyReport" style="flex:1">${icon("copy", "sm")}<span>Copy report</span></button>
                <button class="btn btnWa wa">${icon("whatsapp", "sm")}<span>WhatsApp</span></button>
              </div>
              <div class="toolbar">
                <button class="btn btnGhost clear">${icon("eraser", "sm")}<span>Clear</span></button>
                <span class="spacer"></span>
                <button class="btn btnGreen done" title="Save, mark completed and close the EQ tabs">${icon("check", "sm")}<span>Done</span></button>
              </div>
            </div>
          </div>
          <div class="card picCard">
            <div class="cardHead"><h2>TEMS picture</h2><span class="badge picBadge"></span></div>
            <div class="cardBody stack">
              <div class="picDrop" tabindex="0" title="Drop a picture here, paste one (Ctrl+V), or click to pick a file">
                <img class="picImg" alt="TEMS picture" hidden>
                <div class="picEmpty">${icon("upload")}<b>Drop the TEMS picture here</b><span>or click to pick a file · Ctrl+V pastes one</span></div>
              </div>
              <div class="picPath mono"></div>
              <div class="toolbar">
                <button class="btn btnGhost picPick">${icon("upload", "sm")}<span class="picPickLabel">Add picture</span></button>
                <button class="btn btnGhost picShow" title="Show it in the pictures folder">${icon("folder", "sm")}<span>Show in folder</span></button>
              </div>
              <input type="file" class="picFile" accept="image/png,image/jpeg,image/webp" hidden>
            </div>
          </div>
        </div>
      </div>`;

    const q = (s) => $(s, root);
    const redo = redoBox({ what: "ended", onRedo: (wos) => runAll(wos), onLater: async (forWo) => {
      try {
        await api(`/api/records/${enc(forWo)}/later`, { body: { kind: "end" } });
        toast(`${forWo}: put off - it's in Records (End later) to pick up when you're ready.`, "ok", 6000);
        refreshState();
      } catch (error) { toast(error.message, "bad"); }
      loadRedo();
    } });
    const job = jobPanel(); q(".jobSlot").replaceWith(job.el);
    q(".redoSlot").replaceWith(redo.el);
    const msg = (text, kind = "info") => { q(".msg").innerHTML = text ? `<div class="callout ${kind}">${icon(kind === "ok" ? "check" : kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>` : ""; };

    const box = woBox({
      placeholder: "Paste a WO, grid key or Ticket ID, then Enter",
      compact: true, preview: true,
      picker: {
        label: "Today's open", empty: "No open tickets today.",
        load: async () => (await api("/api/end/open")).map((r) => ({
          wo: r.wo, title: r.wo, sub: `${r.ticketId || "no ticket ID"}${r.startType === "local" ? " · local" : ""}`,
        })),
        onPick: () => { nextMsg = [`Picked from today's open tickets. Press Enter (or ${runLabel()}) to continue.`, "info"]; },
      },
      onResolve: (wo, rec) => { record = rec; onWo(wo); },
      onEnter: () => run(),
    });
    q(".woSlot").replaceWith(box.el);

    const opposite = (v) => (v === "1" ? "0" : "1");
    // Status, grids and remarks save themselves: toggles at once, typed boxes when you leave them.
    const att = seg([{ value: "0", label: "0" }, { value: "1", label: "1" }], defaults.attempted, (v) => { skip.set(opposite(v)); update(); autoSave(); });
    const skip = seg([{ value: "0", label: "0" }, { value: "1", label: "1" }], defaults.skipped, (v) => { att.set(opposite(v)); update(); autoSave(); });
    q(".attSlot").replaceWith(att.el); q(".skipSlot").replaceWith(skip.el);
    const status = seg((settings.statusOptions || ["PASSED", "SKIPPED", "FAILED"]).map((s) => ({ value: s, label: s })), defaults.status,
      (v) => { gridsFor(v); update(); autoSave(); }, "statusSeg");
    // The status sets the grid counts: SKIPPED = attempted 0, skipped 1; PASSED / FAILED = 1, 0.
    // Number of grids stays as it is.
    function gridsFor(value) {
      const skipped = value === "SKIPPED";
      att.set(skipped ? "0" : "1"); skip.set(skipped ? "1" : "0");
    }
    q(".statusSlot").replaceWith(status.el);
    const wa = switchEl((on) => on ? "<b>Send ON</b> · presses Send" : "<b>Send OFF</b> · waits for you", store.whatsappSend,
      (on) => setWhatsappSend(on), "var(--wa)");
    q(".waSlot").replaceWith(wa.el);

    const inputs = { ticket: q(".fTicket"), eq3: q(".fEq3"), eq6: q(".fEq6"), total: q(".fTotal"), remarks: q(".fRemarks") };
    inputs.total.value = defaults.total;
    Object.values(inputs).forEach((input) => input.addEventListener("input", update));
    inputs.total.addEventListener("change", autoSave);    // fires when you leave the box
    inputs.remarks.addEventListener("change", autoSave);
    inputs.total.addEventListener("keydown", (e) => { if (e.key === "Enter") inputs.total.blur(); });

    function fields() {
      return {
        wo: box.get(), ticket: inputs.ticket.value.trim(), eq3: inputs.eq3.value.trim(), eq6: inputs.eq6.value.trim(),
        total: inputs.total.value.trim(), attempted: att.get(), skipped: skip.get(), status: status.get(),
        remarks: inputs.remarks.value.trim(),
      };
    }
    const isLocal = () => record?.startType === "local";
    const runLabel = () => (isLocal() ? "Upload" : "End Ticket");

    function hint(text, color = "var(--faint)") {
      q(".savedHint").textContent = text;
      q(".savedHint").style.color = color;
    }
    function statusFields() {
      const f = fields();
      return { total: f.total, attempted: f.attempted, skipped: f.skipped, status: f.status, remarks: f.remarks };
    }
    const savedStatus = () => record && {
      total: String(record.totalGrids ?? "").trim(), attempted: String(record.attempted ?? "").trim(),
      skipped: String(record.skipped ?? "").trim(), status: record.status || "", remarks: (record.remarks || "").trim(),
    };
    let saving = Promise.resolve();
    function autoSave() {
      const wo = box.get();
      if (!wo) return;
      if (!record) { hint("Not in Records yet - start the WO first", "var(--amber)"); return; }
      const want = statusFields();
      if (JSON.stringify(want) === JSON.stringify(savedStatus())) return;
      hint("Saving…", "var(--muted)");
      saving = saving.then(async () => {
        try {
          record = await api(`/api/records/${enc(wo)}`, { method: "PATCH", body: { ...want, source: "End" } });
          hint(`Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "var(--green)");
          refreshState();
        } catch (error) { hint("Not saved", "var(--red)"); toast(error.message, "bad"); }
      });
    }
    // Background save before Copy / WhatsApp / after a run. EQ Job IDs stay as Records has them -
    // typed ones are saved only with their own Save button.
    const saveFields = () => ({ ...fields(), eq3: record?.eq3 || "", eq6: record?.eq6 || "" });
    function update() {
      const f = fields();
      q(".report").textContent = formatReport(f);
      q(".fFolder").value = f.wo ? (record?.folderName && String(record.wo).replace(/\s+/g, "").toLowerCase() === String(f.wo).replace(/\s+/g, "").toLowerCase() ? record.folderName : folderName(f.wo)) : "";
      const run = q(".run");
      run.innerHTML = isLocal() ? `${icon("upload", "sm")}<span>Upload</span>` : `${icon("check", "sm")}<span>End Ticket</span>`;
      q(".endAll").disabled = busy;
      redo.disable(busy);
      run.disabled = busy || !f.wo;
      if (!f.wo) hint("");
      else if (!record) hint("Not in Records yet", "var(--amber)");
      else if (q(".savedHint").textContent === "" || q(".savedHint").textContent.startsWith("Not in")) hint("Saves as you change it");
      q(".done").disabled = !f.wo || busy;
      paintPicture();
      q(".clear").disabled = busy;
    }
    function folderName(wo) {
      const d = new Date();
      const stamp = `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${d.getFullYear()}`;
      return `${stamp}_${settings.employeeId || ""}_${settings.folderNamePrefix || ""}${wo}`;
    }

    // Back to a blank form: the defaults, nothing from the WO before.
    function resetFields() {
      Object.values(inputs).forEach((i) => (i.value = ""));
      inputs.total.value = defaults.total; att.set(defaults.attempted); skip.set(defaults.skipped); status.set(defaults.status);
      job.hide(); hint("");
    }
    // A different WO: clear everything from the one before, then fill in what Records has for it.
    function onWo(wo) {
      const key = (wo || "").replace(/\s+/g, "").toUpperCase();
      if (key !== shownKey && !busy) {
        const hadOne = Boolean(shownKey);
        shownKey = key; loadedKey = null;
        resetFields();
        if (nextMsg) { msg(...nextMsg); nextMsg = null; }
        else if (hadOne) msg(key ? "" : "Type the WO and press Enter to look up the Ticket ID.", "info");
      }
      if (record && key && key !== loadedKey && !busy) {
        loadedKey = key;
        const filled = [];
        [["ticket", "ticketId", "Ticket ID"], ["eq3", "eq3", "EQ3"], ["eq6", "eq6", "EQ6"]].forEach(([k, rk, label]) => {
          if (record[rk] && !inputs[k].value.trim()) { inputs[k].value = record[rk]; filled.push(label); }
        });
        const rf = record.reportFields || {};
        if (record.totalGrids != null || record.status) {
          inputs.total.value = rf.total; att.set(rf.attempted); skip.set(rf.skipped); status.set(rf.status);
          if (record.remarks && !inputs.remarks.value.trim()) inputs.remarks.value = record.remarks;
          filled.push("status & grids");
        }
        if (filled.length) msg(`Loaded from Records: ${filled.join(", ")}.`, "info");
      } else if (!record) loadedKey = null;
      update();
    }

    async function reloadRecord() {
      const wo = box.get();
      if (!wo) { record = null; return update(); }
      try { record = await api(`/api/records/${enc(wo)}`); } catch { record = null; }
      update();
    }
    async function quietSave() {
      if (!box.get()) return;
      try { record = await api("/api/end/save", { body: { fields: saveFields(), event: null } }); } catch (e) { toast(e.message, "bad"); }
      update();
    }

    // ----- run: find/verify + GridSummary + uploads -----
    async function run() {
      const wo = box.get();
      if (!wo) { msg("Enter a WO first.", "bad"); return; }
      if (busy) return;
      busy = true; update();
      msg(isLocal() ? "Local start: copying GridSummary and uploading…" : "Searching TechInsights in your Chrome…", "info");
      let allDone = false;
      try {
        const { job: started } = await api("/api/end/run", { body: { wo } });
        const done = await job.run(started, (j) => {
          if (j.data.ticket) inputs.ticket.value = j.data.ticket;
          Object.entries(j.data.jobIds || {}).forEach(([eq, id]) => { if (inputs[eq.toLowerCase()]) inputs[eq.toLowerCase()].value = id; });
          update();
        });
        allDone = done.state === "done" && done.result.ok;
        if (done.state === "done") msg(done.result.ok ? "Done - check the report, then WhatsApp and Done." : "Finished with problems - see below. Run it again to finish.", done.result.ok ? "ok" : "warn");
        else msg(done.state === "stopped" ? "Stopped by you." : "Stopped - see the error below.", "bad");
      } catch (error) {
        msg(error.message, "bad");
      } finally {
        busy = false;
        await reloadRecord();
        await quietSave();
        refreshState();
      }
      // Everything is in (Ticket ID, both EQ Job IDs, GridSummary renamed): share on WhatsApp by itself.
      // Not twice - a WO already shared is left for you to share again by hand.
      if (allDone && store.settings?.whatsappAutoShare !== false && box.get() === wo) {
        const missing = [!record?.ticketId && "Ticket ID", !record?.gridSummaryPath && "GridSummary file",
          !record?.picture?.exists && "TEMS picture",
          ...(settings.equipments || ["EQ3", "EQ6"]).filter((eq) => !record?.[eq.toLowerCase()])].filter(Boolean);
        if (missing.length) msg(`Not shared on WhatsApp yet - missing ${missing.join(", ")}.`, "warn");
        else if (record?.whatsappSentAt) msg("All done. Already shared on WhatsApp before - press WhatsApp to share again.", "ok");
        else await shareWhatsapp(q(".wa"), "All done - sharing on WhatsApp by itself…");
      }
    }

    q(".run").addEventListener("click", run);

    // ----- Needs redo: the WOs End Tickets (or End Ticket) stopped on - which step and why -----
    async function loadRedo() {
      try {
        const open = await api("/api/end/open");
        redo.set(open.filter((r) => r.endProblem?.step && !r.endLater).map((r) => ({ wo: r.wo, ...r.endProblem })));
      } catch { /* keep what's shown */ }
    }

    // ----- End Tickets: every WO in Today's open (or just `only`: Redo), uploads first, then WhatsApp -----
    async function runAll(only) {
      if (busy) return;
      let open = [];
      try { open = await api("/api/end/open"); } catch (error) { msg(error.message, "bad"); return; }
      if (Array.isArray(only)) open = open.filter((r) => only.includes(r.wo));
      else open = open.filter((r) => !r.endLater);  // put off with Do later
      if (!open.length) { msg("Nothing to end - no open WO has its result file yet.", "info"); return; }
      const list = open.slice().sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
      const sendText = wa.get() ? "sends each one on WhatsApp" : "gets each one ready on WhatsApp (Send OFF: you press Send)";
      const ok = await modal({
        title: Array.isArray(only) ? `Redo ${list.length === 1 ? list[0].wo : `${list.length} tickets`}?` : `End ${list.length} tickets?`,
        body: `<p>Uploads everything for each WO first (ticket check, GridSummary, EQ uploads), then ${sendText} in
          <b>${esc(settings.whatsappGroup || "the group")}</b> - only the WOs whose every upload worked and weren't shared yet.
          A WO that stops at any step isn't shared and isn't marked ended: it's listed under Needs redo.
          ${settings.whatsappWoGroup ? `Then one message to <b>${esc(settings.whatsappWoGroup)}</b> with "&lt;WO&gt; - Done" for all of them.` : ""}</p>
          <ol style="margin:8px 0 0 18px">${list.map((r) => `<li class="mono">${esc(r.wo)}</li>`).join("")}</ol>`,
        buttons: [{ label: "Cancel", value: false }, { label: Array.isArray(only) ? "Redo" : `End ${list.length} tickets`, value: true, cls: "btnGreen" }],
      });
      if (!ok) return;
      busy = true; update();
      msg(`Ending ${list.length} tickets - uploads first, then WhatsApp…`, "info");
      try {
        const { job: started } = await api("/api/end/runAll", { body: { send: wa.get(), ...(Array.isArray(only) ? { wos: list.map((r) => r.wo) } : {}) } });
        const done = await job.run(started);
        if (done.state === "done") msg(done.result.summary, done.result.ok ? "ok" : "warn");
        else msg(done.state === "stopped" ? "Stopped by you." : done.error || "Stopped.", "bad");
      } catch (error) {
        msg(error.message, "bad");
      } finally {
        busy = false;
        box.set(""); record = null; shownKey = ""; loadedKey = null;
        await refreshState(); box.refreshPicker(); update(); loadRedo();
      }
    }
    q(".endAll").addEventListener("click", () => runAll());
    q(".saveEq").addEventListener("click", async (e) => {
      try {
        const r = await api("/api/end/eq", { body: { wo: box.get(), eq3: inputs.eq3.value, eq6: inputs.eq6.value } });
        msg(r.message, "ok"); flash(e.currentTarget, true, "Saved"); await reloadRecord();
      } catch (error) { msg(error.message, "bad"); }
    });
    q(".copyFolder").addEventListener("click", (e) => copyWithFlash(e.currentTarget, q(".fFolder").value));
    q(".openFile").addEventListener("click", async () => {
      if (!box.get()) return msg("Enter a WO first.", "bad");
      try { const r = await api(`/api/records/${enc(box.get())}/openFile`, { method: "POST" }); msg(`Opened ${r.opened}`, "info"); }
      catch (error) { msg(error.message, "bad"); }
    });
    async function copyReport(button) {
      const ok = await copyText(q(".report").textContent);
      flash(button || q(".copyReport"), ok, ok ? "Copied" : "Copy failed");
      quietSave();
    }
    q(".copyReport").addEventListener("click", (e) => copyReport(e.currentTarget));
    q(".wa").addEventListener("click", (e) => shareWhatsapp(e.currentTarget));
    async function shareWhatsapp(button, startText = "Sharing on WhatsApp…") {
      const wo = box.get();
      if (!wo) return msg("Enter a WO first.", "bad");
      button.disabled = true;
      await quietSave();
      msg(`${startText} (waiting for WhatsApp to load fully)`, "info");
      try {
        const { job: started } = await api("/api/whatsapp", { body: { wo, report: q(".report").textContent, send: wa.get() } });
        const done = await job.run(started);
        if (done.state === "done") { msg(done.result.summary, "ok"); toast(done.result.sent ? "Sent on WhatsApp." : "Ready in WhatsApp - press Send.", "ok"); }
        else msg(done.error || "Stopped.", "bad");
      } catch (error) { msg(error.message, "bad"); }
      finally { button.disabled = false; reloadRecord(); }
    }
    // ----- the TEMS picture: required for WhatsApp (goes out with the CSV and the report) -----
    let picShownFor = "";
    function paintPicture() {
      const pic = record?.picture || {};
      const has = Boolean(pic.exists);
      const img = q(".picImg");
      const key = has ? `${record.wo}|${pic.at}|${pic.path}` : "";
      if (key !== picShownFor) {
        picShownFor = key;
        if (has) img.src = `/api/records/${enc(record.wo)}/picture?t=${encodeURIComponent(pic.at || Date.now())}`;
        else img.removeAttribute("src");
      }
      img.hidden = !has;
      q(".picEmpty").hidden = has;
      const badge = q(".picBadge");
      badge.textContent = !record ? "" : has ? "Saved" : "Required";
      badge.className = `badge picBadge ${!record ? "" : has ? "bGreen" : "bAmber"}`;
      q(".picPath").textContent = has ? `${pic.path}${pic.at ? ` · ${new Date(pic.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}${pic.source ? ` · ${pic.source}` : ""}` : "";
      q(".picPickLabel").textContent = has ? "Replace" : "Add picture";
      q(".picPick").disabled = !record || busy;
      q(".picShow").disabled = !has;
      q(".picDrop").classList.toggle("off", !record);
      const wa = q(".wa");
      wa.disabled = busy || (Boolean(record) && !has);
      wa.title = record && !has ? "Add the TEMS picture first - it goes out with the CSV and the report" : "Share the CSV, the TEMS picture and the report";
    }
    async function uploadPicture(file) {
      const wo = box.get();
      if (!wo || !record) return msg("Pick a WO that's in Records first.", "bad");
      if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) return msg("That isn't a picture (PNG, JPG or WEBP).", "bad");
      if (record.picture?.exists && !(await modal({
        title: "Replace the picture?", body: `<p>${esc(wo)} already has a TEMS picture. The new one replaces it.</p>`,
        buttons: [{ label: "Cancel", value: false }, { label: "Replace", value: true, cls: "btnPrimary" }],
      }))) return;
      const form = new FormData();
      form.append("picture", file, file.name || "picture.png");
      try {
        const r = await api(`/api/records/${enc(wo)}/picture`, { form });
        if (box.get() === wo) record = r.record;
        msg(r.message, "ok"); update(); refreshState();
      } catch (error) { msg(error.message, "bad"); }
    }
    q(".picPick").addEventListener("click", () => q(".picFile").click());
    q(".picDrop").addEventListener("click", () => { if (record) q(".picFile").click(); });
    q(".picFile").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadPicture(f); });
    q(".picShow").addEventListener("click", async () => {
      try { await api(`/api/records/${enc(box.get())}/picture/show`, { method: "POST" }); } catch (error) { msg(error.message, "bad"); }
    });
    const card = q(".picCard");
    ["dragenter", "dragover"].forEach((type) => card.addEventListener(type, (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      e.preventDefault(); card.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((type) => card.addEventListener(type, (e) => {
      if (type === "dragleave" && card.contains(e.relatedTarget)) return;
      card.classList.remove("dragging");
    }));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
      if (f) uploadPicture(f); else msg("Drop a picture file (PNG, JPG or WEBP).", "bad");
    });
    const onPaste = (e) => {
      if (e.target.closest?.("input, textarea, [contenteditable='true']")) return;
      const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
      if (f) { e.preventDefault(); uploadPicture(f); }
    };
    document.addEventListener("paste", onPaste);

    function clearForm() {
      box.set(""); record = null; loadedKey = null; shownKey = "";
      resetFields(); msg("Type the WO and press Enter to look up the Ticket ID.", "info"); update(); box.focus();
    }
    q(".clear").addEventListener("click", clearForm);
    q(".done").addEventListener("click", async () => {
      try {
        await saving;
        await api("/api/end/done", { body: { fields: saveFields() } });
        toast(`${box.get()} marked done.`, "ok");
        await refreshState();
        location.hash = "#/today";
      } catch (error) { msg(error.message, "bad"); }
    });

    const onKey = (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); copyReport(); }
    };
    document.addEventListener("keydown", onKey);

    msg("Type the WO and press Enter to look up the Ticket ID.", "info");
    update();
    if (params.get("wo")) {
      box.set(params.get("wo"));
      setTimeout(() => msg(`Carried over. Press Enter (or ${runLabel()}) to continue.`, "info"), 400);
    } else {
      // Nothing carried over: pick today's open WO you started first (we end in the order we started).
      api("/api/end/open").then((open) => {
        if (box.get() || !open.length) return;
        const first = open.slice().sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""))[0];
        nextMsg = [open.length > 1 ? `Picked the one you started first (${open.length} open). Press Enter (or ${runLabel()}) to continue.`
          : `Picked today's open WO. Press Enter (or ${runLabel()}) to continue.`, "info"];
        box.set(first.wo);
      }).catch(() => {});
    }
    setTimeout(() => box.focus(), 50);
    loadRedo();

    // ----- live: count from the shared state; the record (and an open list) when data changes -----
    const paintCount = (state) => {
      const count = state?.counts?.open || 0;
      box.setPickerCount(count);
      const button = q(".endAll");
      button.classList.toggle("hidden", count < 2);
      $(".endAllLabel", button).textContent = `End ${count} Tickets`;
    };
    paintCount(store.state);
    const offCount = store.on(paintCount);
    const offData = onDataChange(async () => {
      box.refreshPicker();
      if (!busy) loadRedo();
      if (busy || !box.get()) return;
      const before = JSON.stringify(savedStatus());
      const untouched = JSON.stringify(statusFields()) === before;  // form shows what was saved
      await reloadRecord();
      const after = savedStatus();
      const typing = [inputs.total, inputs.remarks].includes(document.activeElement);
      if (untouched && !typing && after && JSON.stringify(after) !== before) {
        inputs.total.value = after.total; att.set(after.attempted); skip.set(after.skipped);
        status.set(after.status); inputs.remarks.value = after.remarks;
      }
      // Fill boxes that are still empty with what was saved elsewhere (never overwrite your typing).
      [["ticket", "ticketId"], ["eq3", "eq3"], ["eq6", "eq6"]].forEach(([k, rk]) => {
        if (record?.[rk] && !inputs[k].value.trim() && document.activeElement !== inputs[k]) inputs[k].value = record[rk];
      });
      update();
    });
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("paste", onPaste); offCount(); offData(); };
  },
};
