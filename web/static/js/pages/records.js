// Records: everything saved in tickets.json - search, filter, edit status (saves as you change it),
// share, move to today, delete.
import { $, $$, api, clock, confirmBox, copyWithFlash, dayLabel, debounce, enc, esc, flash, icon, isToday, niceTime, onDataChange, refreshState, store, toast } from "../core.js";
import { jobPanel, locationTarget, progressBadge, seg, shareLocation, statusBadge, typeBadge, waDot } from "../components.js";

const filters = [
  ["all", "All"], ["today", "Today"], ["inProgress", "In progress"], ["completed", "Completed"], ["notStarted", "Not started"],
  ["cloud", "Cloud"], ["local", "Local"], ["wa", "WhatsApp pending"], ["close", "Ready to close"],
];
const matches = {
  all: () => true,
  today: (r) => isToday(r.day),
  inProgress: (r) => r.progress === "inProgress",
  completed: (r) => r.progress === "completed" || r.progress === "closed",
  notStarted: (r) => r.progress === "notStarted",
  cloud: (r) => r.startType === "cloud",
  local: (r) => r.startType === "local",
  wa: (r) => (r.progress === "completed" || r.progress === "closed") && !r.whatsappSentAt,
  close: (r) => r.readyToClose,
};
const openFolds = new Set();  // "report" / "history": closed until you open them
const keyOf = (wo) => String(wo || "").replace(/\s+/g, "").toUpperCase();
const callout = (text, kind) => text ? `<div class="callout ${kind}">${icon(kind === "ok" ? "check" : kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>` : "";

export default {
  title: "Records",
  sub: "Everything Start and End Ticket saved",
  render(root, params) {
    let list = [], filter = params.get("filter") || "all", selected = params.get("wo") || null, detailShown = false;
    const checked = new Set();

    // Half width: one page scroll, list OR details (tap a record -> its details; Back / ‹ › to move on).
    // Full width: list on the left, details on the right, as before.
    const narrow = window.matchMedia("(max-width: 1180px)");
    root.innerHTML = `<div class="recPage ${selected ? "showDetail" : ""}">
      <div class="recToolbar">
        <div class="searchBox">${icon("search")}
          <input class="input search" placeholder="Search WO, Ticket ID, grid key, EQ Job ID, cluster…" spellcheck="false"></div>
        <span class="note count"></span>
        <div class="bulkBar">
          <button class="btn btnGhost selAll">${icon("check", "sm")}<span>Select all pending</span></button>
          <button class="btn btnPurple move hidden">${icon("calendar", "sm")}<span>Move to today</span></button>
          <button class="btn btnPurple moveTomorrow hidden">${icon("calendar", "sm")}<span>Move to tomorrow</span></button>
          <button class="btn btnGhost done hidden">${icon("check", "sm")}<span>Mark done</span></button>
          <button class="btn btnDanger del hidden">${icon("x", "sm")}<span>Delete</span></button>
        </div>
      </div>
      <div class="filters"></div>
      <div class="records">
        <div class="card recList"></div>
        <div class="detailCol">
          <div class="detailNav">
            <button class="btn btnGhost back">${icon("arrow", "sm")}<span>All records</span></button>
            <span class="pos note"></span>
            <button class="iconBtn prev" title="Previous record">${icon("chevron", "sm")}</button>
            <button class="iconBtn next" title="Next record">${icon("chevron", "sm")}</button>
          </div>
          <div class="card detail"><div class="empty">${icon("records")}<p>Pick a record on the left.</p></div></div>
        </div>
      </div></div>`;
    const q = (s) => $(s, root);
    const page = q(".recPage");
    let listScroll = 0;
    function showDetail() {
      if (!narrow.matches || page.classList.contains("showDetail")) return;
      listScroll = window.scrollY;
      page.classList.add("showDetail");
      window.scrollTo(0, 0);
    }
    function showList() {
      if (!page.classList.contains("showDetail")) return;
      page.classList.remove("showDetail");
      if (!narrow.matches) return;
      window.scrollTo(0, listScroll);
      const row = $(".rec.sel", root);
      if (row) { const r = row.getBoundingClientRect(); if (r.top < 70 || r.bottom > innerHeight) row.scrollIntoView({ block: "center" }); }
    }
    function paintPos() {
      const i = lastShown.findIndex((r) => keyOf(r.wo) === keyOf(selected));
      q(".pos").textContent = i >= 0 ? `${i + 1} of ${lastShown.length}` : "";
      q(".prev").disabled = i <= 0;
      q(".next").disabled = i < 0 || i >= lastShown.length - 1;
    }
    function step(by) {
      const i = lastShown.findIndex((r) => keyOf(r.wo) === keyOf(selected));
      const r = lastShown[i + by];
      if (!r) return;
      select(r.wo);
      if (narrow.matches) window.scrollTo(0, 0);
    }
    q(".back").addEventListener("click", showList);
    q(".prev").addEventListener("click", () => step(-1));
    q(".next").addEventListener("click", () => step(1));

    async function load() {
      try { list = await api(`/api/records?q=${enc(q(".search").value)}`); }
      catch (error) { toast(error.message, "bad"); list = []; }
      drawList();
    }

    function drawList() {
      q(".filters").innerHTML = filters.map(([k, label]) => {
        const n = list.filter(matches[k]).length;
        return `<button class="filter ${k === filter ? "on" : ""}" data-f="${k}">${label}<span class="n">${n}</span></button>`;
      }).join("");
      const shown = list.filter(matches[filter] || matches.all);
      q(".count").textContent = `${shown.length} record${shown.length === 1 ? "" : "s"}`;
      const keys = new Set(shown.filter((r) => r.progress === "notStarted").map((r) => r.key));
      [...checked].forEach((k) => { if (!keys.has(k)) checked.delete(k); });
      lastShown = shown;
      paintMove();

      const dayCounts = {};
      shown.forEach((r) => { const d = dayLabel(r.day); dayCounts[d] = (dayCounts[d] || 0) + 1; });
      let lastDay = null, html = "";
      for (const r of shown) {
        const d = dayLabel(r.day);
        if (d !== lastDay) { lastDay = d; html += `<div class="dayDiv ${d === "TODAY" ? "today" : ""}">${d} · ${dayCounts[d]}</div>`; }
        const eq = ["eq3", "eq6"].map((k) => `${k.toUpperCase()} ${r[k] ? "✓" : "–"}`).join("  ");
        const time = r.closedAt ? `Closed ${clock(r.closedAt)}` : r.endedAt ? `Done ${clock(r.endedAt)}`
          : r.startedAt ? `Started ${clock(r.startedAt)}` : r.importedAt ? "Imported" : "";
        html += `<div class="rec ${keyOf(r.wo) === keyOf(selected) ? "sel" : ""}" data-key="${esc(r.key)}" data-wo="${esc(r.wo)}">
            ${r.progress === "notStarted"
              ? `<input type="checkbox" class="check" ${checked.has(r.key) ? "checked" : ""} title="Tick to move to today, mark done or delete">`
              : "<span></span>"}
            <div class="main">
              <div class="wo" title="${esc(r.wo)}">${esc(r.wo)}</div>
              <div class="sub">${esc(r.ticketId || "no ticket")} · ${eq}</div>
              <div class="tags">${typeBadge(r.startType)}${progressBadge(r)}</div>
            </div>
            <div class="side">${statusBadge(r.status) || ""}<span class="time">${time}</span>${r.startedAt && r.startType !== "manual" ? waDot(r) : ""}</div>
          </div>`;
      }
      q(".recList").innerHTML = html || `<div class="empty">${icon("search")}<p>${q(".search").value ? "No matches." : "No records yet."}</p></div>`;
      const inList = selected && shown.some((r) => keyOf(r.wo) === keyOf(selected));
      if (inList && !detailShown) select(selected);
      else if (!inList && shown[0] && (!selected || (!q(".search").value && filter === "all"))) select(shown[0].wo);
      // Wide: the list has its own scroll box, keep the picked one in view there.
      // Narrow: the page is the scroll, so don't jump it on every live refresh.
      if (!narrow.matches) $(".rec.sel", root)?.scrollIntoView({ block: "nearest" });
      paintPos();
    }

    // Ticked not-started WOs: Move to today (only the ones not already today's), Mark done, Delete.
    let lastShown = [];
    const pendingShown = () => lastShown.filter((r) => r.progress === "notStarted");
    const tickedRecords = () => list.filter((r) => checked.has(r.key));
    const notToday = (r) => dayLabel(r.day) !== "TODAY";
    function paintMove() {
      const ticked = tickedRecords(), movable = ticked.filter(notToday), n = ticked.length;
      const pending = pendingShown();
      const allTicked = pending.length > 0 && pending.every((r) => checked.has(r.key));
      q(".selAll").innerHTML = `${icon("check", "sm")}<span>${allTicked ? "Clear selection" : `Select all pending${pending.length ? ` (${pending.length})` : ""}`}</span>`;
      q(".selAll").disabled = !pending.length;
      const move = q(".move");
      move.classList.toggle("hidden", !movable.length);  // already today's: nothing to move
      move.innerHTML = `${icon("calendar", "sm")}<span>Move ${movable.length} to today</span>`;
      move.title = "Brings not-started WOs to today: under Today here and at the top of Start's To start list";
      // Everything ticked is a not-started WO of today: they can go to tomorrow (set up the next day tonight).
      const allTodayPending = n > 0 && ticked.every((r) => r.progress === "notStarted" && isToday(r.day));
      const tomorrowButton = q(".moveTomorrow");
      tomorrowButton.classList.toggle("hidden", !allTodayPending);
      tomorrowButton.innerHTML = `${icon("calendar", "sm")}<span>Move ${n} to tomorrow</span>`;
      tomorrowButton.title = "Moves them to tomorrow: under Tomorrow here now, under Today and in Start's To start list from midnight";
      q(".done").classList.toggle("hidden", !n);
      q(".done").innerHTML = `${icon("check", "sm")}<span>Mark ${n} done</span>`;
      q(".done").title = "Driven / submitted outside the app: marks them started, ended and closed now";
      q(".del").classList.toggle("hidden", !n);
      q(".del").innerHTML = `${icon("x", "sm")}<span>Delete ${n}</span>`;
    }
    q(".selAll").addEventListener("click", () => {
      const pending = pendingShown();
      const allTicked = pending.length > 0 && pending.every((r) => checked.has(r.key));
      if (allTicked) checked.clear(); else pending.forEach((r) => checked.add(r.key));
      drawList();
    });
    async function bulk(action, ask) {
      const wos = tickedRecords().map((r) => r.wo);
      if (!wos.length) return;
      if (ask && !await confirmBox(...ask(wos))) return;
      // Second check - these can't be undone from the app.
      const n = wos.length, count = `${n} WO${n > 1 ? "s" : ""}`;
      if (!await confirmBox("Are you sure?", (action === "delete" ? `Really delete ${count}?` : `Really mark ${count} as done?`) + "\n\n" +
        (action === "delete" ? "They won't come back in the app by themselves (copies stay in tickets.deleted.json)."
          : "They'll leave Start, End and Close as done by hand."),
        action === "delete" ? `Yes, delete ${n}` : `Yes, mark ${n} done`, action === "delete" ? "btnDanger" : "btnPrimary")) return;
      try {
        const r = await api("/api/records/bulk", { body: { action, wos } });
        checked.clear();
        toast(action === "delete" ? `Deleted ${r.count}. Copies are kept in tickets.deleted.json.` : `Marked ${r.count} done.`, "ok");
        load(); refreshState();
      } catch (error) { toast(error.message, "bad"); }
    }
    const listWos = (wos) => wos.slice(0, 8).map((w) => `• ${esc(w)}`).join("\n") + (wos.length > 8 ? `\n… and ${wos.length - 8} more` : "");
    q(".del").addEventListener("click", () => bulk("delete", (wos) => ["Delete these?",
      `Delete ${wos.length} not-started WO${wos.length > 1 ? "s" : ""}?\n\n${listWos(wos)}\n\nCopies are kept in tickets.deleted.json.`, "Yes, delete", "btnDanger"]));
    q(".done").addEventListener("click", () => bulk("done", (wos) => ["Mark done?",
      `Mark ${wos.length} WO${wos.length > 1 ? "s" : ""} as done by hand (started, ended and closed now)?\n\n${listWos(wos)}`, "Mark done", "btnPrimary"]));

    q(".recList").addEventListener("click", (e) => {
      const row = e.target.closest(".rec");
      if (!row) return;
      if (e.target.classList.contains("check")) {
        e.target.checked ? checked.add(row.dataset.key) : checked.delete(row.dataset.key);
        return paintMove();
      }
      select(row.dataset.wo);
      showDetail();
    });
    q(".search").addEventListener("input", debounce(load, 220));
    q(".filters").addEventListener("click", (e) => {
      const b = e.target.closest(".filter");
      if (b) { filter = b.dataset.f; drawList(); }
    });
    q(".move").addEventListener("click", async () => {
      const wos = tickedRecords().filter(notToday).map((r) => r.wo);
      if (!wos.length) return;
      try {
        const r = await api("/api/records/moveToday", { body: { wos } });
        checked.clear(); toast(`Moved ${r.moved} to today - they're at the top of Start's To start list.`, "ok"); load(); refreshState();
      } catch (error) { toast(error.message, "bad"); }
    });

    q(".moveTomorrow").addEventListener("click", async () => {
      const wos = tickedRecords().filter((r) => r.progress === "notStarted" && isToday(r.day)).map((r) => r.wo);
      if (!wos.length) return;
      try {
        const r = await api("/api/records/moveToday", { body: { wos, tomorrow: true } });
        checked.clear(); toast(`Moved ${r.moved} to tomorrow - they show under Today and in Start's To start list from midnight.`, "ok"); load(); refreshState();
      } catch (error) { toast(error.message, "bad"); }
    });

    // ---------- detail ----------
    async function select(wo) {
      selected = wo;
      detailShown = Boolean(wo);
      $$(".rec", root).forEach((row) => row.classList.toggle("sel", keyOf(row.dataset.wo) === keyOf(wo)));
      paintPos();
      if (!wo) { q(".detail").innerHTML = `<div class="empty">${icon("records")}<p>Pick a record on the left.</p></div>`; return; }
      try { drawDetail(await api(`/api/records/${enc(wo)}`)); }
      catch (error) { q(".detail").innerHTML = `<div class="empty">${icon("alert")}<p>${esc(error.message)}</p></div>`; }
    }

    let shownRecord = null;  // what the detail panel shows now (for live updates)
    function drawDetail(r) {
      shownRecord = r;
      const d = q(".detail");
      const verified = r.isLocal ? `<span class="note">no TechInsights ticket</span>`
        : r.ticketVerified ? `<span class="badge bGreen">${icon("check", "sm")}Ticket verified</span>`
        : r.ticketId ? `<span class="badge bAmber">Not verified yet</span>` : `<span class="badge bGrey">No ticket yet</span>`;
      const meta = [r.cluster, r.startedAt && `Started ${niceTime(r.startedAt)}`, r.endedAt && `Completed ${niceTime(r.endedAt)}`,
        r.closedAt && `Closed ${niceTime(r.closedAt)}`].filter(Boolean).join("  ·  ");
      const kv = [["Ticket ID", r.ticketId], ["EQ3", r.eq3], ["EQ6", r.eq6], ["Grid key", r.gridKey], ["Location", r.location],
        ["Folder name", r.folderName], ["Imported", r.importSource]];
      const started = Boolean(r.startedAt);

      d.innerHTML = `
        <div class="dHead">
          <div class="dTitle"><h2>${esc(r.wo)}</h2>
            <button class="iconBtn sm cpWo" title="Copy the WO">${icon("copy", "sm")}</button>
            <span class="spacer"></span>
            <button class="btn btnDanger sm del" title="Delete this record">${icon("trash", "sm")}<span>Delete</span></button></div>
          <div class="dMeta">${esc(meta || "Not started yet")}</div>
          <div class="dTags">${typeBadge(r.startType)}${progressBadge(r)}${statusBadge(r.status)}${verified}
            ${started && r.startType !== "manual" ? `${waDot(r)}<span class="note">${r.whatsappSentAt ? `shared ${esc(niceTime(r.whatsappSentAt))}` : "not shared yet"}</span>` : ""}</div>
          <div class="dActions">
            <button class="btn btnPrimary cpReport">${icon("copy", "sm")}<span>Copy ${started ? "report" : "preview"}</span></button>
            ${started ? `<button class="btn btnWa share">${icon("whatsapp", "sm")}<span>WhatsApp</span></button>` : ""}
            <button class="btn btnGhost open">${icon("folder", "sm")}<span>Open file</span></button>
            <span class="spacer"></span>
            ${started ? `<a class="btn btnGreen" href="#/end?wo=${encodeURIComponent(r.wo)}">End Ticket ${icon("arrow", "sm")}</a>`
              : `<a class="btn btnPrimary" href="#/start?wo=${encodeURIComponent(r.wo)}">${icon("rocket", "sm")}Start</a>`}
          </div>
        </div>
        <div class="dBody">
          <div class="spanAll dMsgWrap"><div class="dMsg"></div><div class="jobSlot"></div></div>
          <div class="panel">
            <h3>Details<span class="aside">
              <button class="btn btnGhost sm send" ${r.lat && r.long ? "" : "disabled"} title="${esc(locationTarget().title)}">${icon("qr", "sm")}<span>${locationTarget().apeksha ? "Send" : "QR"}</span></button>
              <button class="btn btnGhost sm cpLoc" title="Copy WO · Grid Key · Location">${icon("pin", "sm")}<span>Copy</span></button></span></h3>
            ${kv.map(([k, v], n) => `<div class="kvRow"><span class="k">${k}</span><span class="v ${v ? "" : "none"}" title="${esc(v || "")}">${esc(v || "—")}</span>
              <button class="iconBtn sm cp" data-n="${n}" ${v ? "" : "disabled"} title="Copy ${k}">${icon("copy", "sm")}</button></div>`).join("")}
            ${r.gridKeys?.length > 1 ? `<div class="note" style="margin-top:8px">${r.gridKeys.length} grids: ${esc(r.gridKeys.join(", "))}</div>` : ""}
          </div>
          <div class="panel">
            <h3>Status<span class="aside sHint">Saves as you change it</span></h3>
            <div class="stack" style="gap:12px">
              <div class="formGrid">
                <div class="field"><label class="label">Total grids</label><input class="input eTotal" inputmode="numeric"></div>
                <div class="field"><label class="label">Attempted</label><div class="eAtt"></div></div>
                <div class="field"><label class="label">Skipped</label><div class="eSkip"></div></div>
              </div>
              <div class="eStatus"></div>
              <div class="field"><label class="label">Remarks (optional)</label><textarea class="textarea eRemarks" rows="2" placeholder="Saved when you click away"></textarea></div>
            </div>
          </div>
          <details class="panel spanAll fold" data-fold="report" ${openFolds.has("report") ? "open" : ""}>
            <summary><h3>${icon("chevron", "sm")}${started ? "Report" : "Start preview"}<span class="aside">${started && r.isLocal ? "Ticket ID goes out blank on WhatsApp" : ""}</span></h3></summary>
            <pre class="pre report">${esc(r.report)}</pre>
          </details>
          ${r.previousTickets?.length ? `<div class="panel spanAll"><h3>Previous tickets</h3>${r.previousTickets.map((p) =>
            `<div class="kvRow"><span class="k">${esc(p.startType || "ticket")}</span><span class="v">${esc(p.ticketId || "—")}</span><span></span></div>`).join("")}</div>` : ""}
          <details class="panel spanAll fold" data-fold="history" ${openFolds.has("history") ? "open" : ""}>
            <summary><h3>${icon("chevron", "sm")}History<span class="aside">${(r.history || []).length} events</span></h3></summary>
            <div class="timeline">${(r.history || []).map((h) =>
              `<div class="tItem"><span class="tDot"></span><span class="t">${esc(niceTime(h.at))}</span><span>${esc(h.event)}</span></div>`).join("") || `<div class="note">No history.</div>`}</div>
          </details>
        </div>`;
      // Report / History open or closed stays as you left it while you switch records.
      $$(".fold", d).forEach((fold) => fold.addEventListener("toggle", () => {
        fold.open ? openFolds.add(fold.dataset.fold) : openFolds.delete(fold.dataset.fold);
      }));

      const job = jobPanel(); $(".jobSlot", d).replaceWith(job.el);
      const dmsg = (text, kind = "info") => { $(".dMsg", d).innerHTML = callout(text, kind); };
      $(".cpWo", d).addEventListener("click", (e) => copyWithFlash(e.currentTarget, r.wo, ""));
      $$(".cp", d).forEach((b) => b.addEventListener("click", () => copyWithFlash(b, kv[+b.dataset.n][1], "")));
      $(".cpLoc", d).addEventListener("click", (e) => copyWithFlash(e.currentTarget, r.locationPreview));
      $(".cpReport", d).addEventListener("click", (e) => copyWithFlash(e.currentTarget, $(".report", d).textContent));
      $(".send", d).addEventListener("click", (e) => shareLocation(r, e.currentTarget));
      $(".open", d).addEventListener("click", async () => {
        try { const o = await api(`/api/records/${enc(r.wo)}/openFile`, { method: "POST" }); dmsg(`Opened ${o.opened}`, "ok"); }
        catch (error) { dmsg(error.message, "bad"); }
      });
      $(".share", d)?.addEventListener("click", async (e) => {
        const button = e.currentTarget; button.disabled = true;
        try {
          await saving;
          const { job: started2 } = await api("/api/whatsapp", { body: { wo: r.wo, report: $(".report", d).textContent, send: store.whatsappSend } });  // the Send switch lives in Settings
          const done = await job.run(started2);
          if (done.state === "done") { dmsg(done.result.summary, "ok"); load(); }
          else dmsg(done.error || "Stopped.", "bad");
        } catch (error) { dmsg(error.message, "bad"); }
        finally { button.disabled = false; }
      });
      $(".del", d).addEventListener("click", async () => {
        if (!await confirmBox("Delete record?", `Delete the record for\n<b>${esc(r.wo)}</b>?\n\nIts Ticket ID, EQ Job IDs, report and history will be removed from Records.`, "Delete", "btnDanger")) return;
        if (!await confirmBox("Are you sure?", `Really delete <b>${esc(r.wo)}</b>?\n\nA copy is kept in tickets.deleted.json, but it won't come back in the app by itself.`, "Yes, delete", "btnDanger")) return;
        try { const o = await api(`/api/records/${enc(r.wo)}`, { method: "DELETE" }); toast(o.message, "ok"); selected = null; showList(); load(); refreshState(); }
        catch (error) { toast(error.message, "bad"); }
      });

      // ----- status: toggles save at once, typed boxes when you click away -----
      const rf = r.reportFields;
      const opposite = (v) => (v === "1" ? "0" : "1");
      const total = $(".eTotal", d), remarks = $(".eRemarks", d), sHint = $(".sHint", d);
      total.value = rf.total; remarks.value = r.remarks || "";
      const att = seg([{ value: "0", label: "0" }, { value: "1", label: "1" }], rf.attempted, (v) => { skip.set(opposite(v)); save(); });
      const skip = seg([{ value: "0", label: "0" }, { value: "1", label: "1" }], rf.skipped, (v) => { att.set(opposite(v)); save(); });
      const status = seg(["PASSED", "SKIPPED", "FAILED"].map((s) => ({ value: s, label: s })), r.status || "", () => save(), "statusSeg");
      $(".eAtt", d).replaceWith(att.el); $(".eSkip", d).replaceWith(skip.el); $(".eStatus", d).replaceWith(status.el);
      total.addEventListener("change", save);
      remarks.addEventListener("change", save);
      total.addEventListener("keydown", (e) => { if (e.key === "Enter") total.blur(); });
      const current = () => [total.value.trim(), att.get(), skip.get(), status.get(), remarks.value.trim()].join("|");
      let lastSaved = current(), saving = Promise.resolve();
      function save() {
        if (current() === lastSaved) return;
        if (!status.get()) { sHint.textContent = "Pick a status to save"; sHint.style.color = "var(--amber)"; return; }
        const body = { total: total.value, attempted: att.get(), skipped: skip.get(), status: status.get(), remarks: remarks.value };
        const snapshot = current();
        sHint.textContent = "Saving…"; sHint.style.color = "var(--muted)";
        saving = saving.then(async () => {
          try {
            const saved = await api(`/api/records/${enc(r.wo)}`, { method: "PATCH", body });
            lastSaved = snapshot;
            shownRecord = saved;  // our own save: no need to redraw this panel
            sHint.textContent = `Saved ${clock(new Date().toISOString())}`; sHint.style.color = "var(--green)";
            $(".report", d).textContent = saved.report;
            // keep the list row in step without redrawing this panel
            const row = list.find((x) => keyOf(x.wo) === keyOf(r.wo));
            if (row) { row.status = saved.status; drawListKeepDetail(); }
            refreshState();
          } catch (error) { sHint.textContent = "Not saved"; sHint.style.color = "var(--red)"; toast(error.message, "bad"); }
        });
      }
    }
    function drawListKeepDetail() {
      const keep = detailShown;
      detailShown = true;  // don't reload the open detail
      drawList();
      detailShown = keep;
    }

    // ----- live: list, counts and the open record follow changes made anywhere -----
    const offData = onDataChange(async () => {
      try { list = await api(`/api/records?q=${enc(q(".search").value)}`); } catch { return; }
      drawListKeepDetail();
      if (!selected || !shownRecord) return;
      const d = q(".detail");
      const editing = d.contains(document.activeElement) && document.activeElement.matches("input, textarea");
      const jobRunning = $(".job:not(.hidden) .spinner:not(.hidden)", d);
      if (editing || jobRunning) return;
      let fresh;
      try { fresh = await api(`/api/records/${enc(selected)}`); } catch { return; }
      if (fresh.updatedAt !== shownRecord.updatedAt || fresh.closedAt !== shownRecord.closedAt) {
        const scroll = d.scrollTop;
        drawDetail(fresh);
        d.scrollTop = scroll;
      }
    });

    load();
    return offData;
  },
};
