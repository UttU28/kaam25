// Today: the day at a glance - cloud ticket, counts, the plan import (checked against TEMS Cloud)
// and every ticket touched today.
import { $, api, clock, copyText, copyWithFlash, esc, flash, icon, niceTime, onDataChange, refreshState, shortGridKey, store, toast } from "../core.js";
import { jobPanel, progressBadge, statusBadge, typeBadge, waDot } from "../components.js";

export default {
  title: "Today",
  sub: () => new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
  render(root) {
    root.innerHTML = `<div class="stack"><div class="todayHero"></div><div class="waitingSlot"></div><div class="importSlot"></div><div class="todayTickets"></div></div>`;
    const plan = importCard(), waiting = waitingCard();
    $(".waitingSlot", root).replaceWith(waiting.el);
    $(".importSlot", root).replaceWith(plan.el);
    const paint = (s) => { if (s) draw(root, s); };
    paint(store.state);
    refreshState();
    const offStore = store.on(paint);
    const offData = onDataChange(() => { plan.load(); waiting.load(); });
    return () => { offStore?.(); offData?.(); };
  },
};

function draw(root, s) {
  const c = s.counts;
  const cloud = s.cloudStart;
  const cloudCard = cloud
    ? `<div class="eyebrow">Today's cloud ticket</div>
       <h2>${esc(cloud.cluster || cloud.wo)}</h2>
       <div class="note mono" style="font-family:var(--mono)">${esc(cloud.wo)}</div>
       <div class="bigId">${esc(cloud.ticketId || "—")}</div>
       <div class="row wrap" style="margin-top:12px">
         ${progressBadge(cloud)} ${statusBadge(cloud.status)}
         <span class="spacer"></span>
         <button class="btn btnGhost sm copyId">${icon("copy", "sm")}<span>Copy ID</span></button>
         ${cloud.progress === "inProgress" ? `<a class="btn btnGreen sm" href="#/end?wo=${encodeURIComponent(cloud.wo)}">End ticket ${icon("arrow", "sm")}</a>` : ""}
         ${cloud.readyToClose ? `<a class="btn btnAmber sm" href="#/close?wo=${encodeURIComponent(cloud.wo)}">${icon("lock", "sm")}Close</a>` : ""}
       </div>`
    : `<div class="eyebrow">Today's cloud ticket</div>
       <h2>Not started yet</h2>
       <p class="note">The first WO of the day gets the real TechInsights ticket. Every one after it is a local start (${esc(s.nextLocalId)} next).</p>
       <div class="row" style="margin-top:14px"><a class="btn btnPrimary" href="#/start">${icon("rocket", "sm")}Start the first WO</a></div>`;

  const stats = [
    ["To start", c.toStart, "#/start", "var(--accent)"],
    ["In progress", c.open, "#/end", "var(--amber)"],
    ["Completed today", c.completedToday, "#/records?filter=today", "var(--green)"],
    ["WhatsApp pending", c.whatsappPending, "#/records?filter=wa", "var(--wa)"],
    ["Ready to close", c.readyToClose, "#/close", "var(--purple)"],
    ["All records", c.total, "#/records", "var(--muted)"],
  ];

  $(".todayHero", root).innerHTML = `
    <div class="hero">
      <div class="heroCard">${cloudCard}</div>
      <div class="stats">${stats.map(([t, n, href, color]) =>
        `<a class="stat" href="${href}"><div class="n" style="color:${n ? color : "var(--faint)"}">${n}</div><div class="t">${t}</div></a>`).join("")}</div>
    </div>`;
  $(".todayTickets", root).innerHTML = `
    <div class="card">
      <div class="cardHead"><h2>Today's tickets</h2><span class="hint">${s.today.length} · Shift ${esc(s.shift)} (PM from ${esc(s.pmFrom)})</span>
        <div class="actions">
          <a class="btn btnGhost sm" href="#/start">${icon("rocket", "sm")}Start</a>
          <a class="btn btnGhost sm" href="#/end">${icon("end", "sm")}End</a>
        </div></div>
      <div class="cardBody" style="padding:6px 0 4px">
        ${s.today.length ? `<div class="flow">${s.today.map(row).join("")}</div>`
          : `<div class="empty">${icon("calendar")}<p>Nothing touched today yet.</p><a class="btn btnPrimary sm" href="#/start">Start a WO</a></div>`}
      </div>
    </div>`;
  $(".copyId", root)?.addEventListener("click", (e) => copyWithFlash(e.currentTarget, cloud.ticketId));
}

function row(r) {
  const tone = { closed: "var(--green)", completed: "var(--green)", inProgress: "var(--amber)" }[r.progress] || "var(--accent)";
  const ico = r.startType === "local" ? "laptop" : r.startType === "cloud" ? "cloud" : "file";
  const eq = ["eq3", "eq6"].map((k) => `${k.toUpperCase()} ${r[k] ? "✓" : "–"}`).join("  ");
  const action = r.progress === "inProgress"
    ? `<a class="btn btnGreen sm" href="#/end?wo=${encodeURIComponent(r.wo)}">End ${icon("arrow", "sm")}</a>`
    : r.readyToClose ? `<a class="btn btnAmber sm" href="#/close?wo=${encodeURIComponent(r.wo)}">${icon("lock", "sm")}Close</a>`
    : r.progress === "notStarted" ? `<a class="btn btnPrimary sm" href="#/start?wo=${encodeURIComponent(r.wo)}">Start</a>` : "";
  return `<div class="flowRow">
      <div class="stepIco" style="background:color-mix(in srgb, ${tone} 14%, transparent);color:${tone}">${icon(ico, "sm")}</div>
      <div style="min-width:0">
        <a class="wo" href="#/records?wo=${encodeURIComponent(r.wo)}" title="Open in Records">${esc(r.wo)}</a>
        <div class="meta"><span class="mono">${esc(r.ticketId || "no ticket yet")}</span>${typeBadge(r.startType)}${progressBadge(r)}${statusBadge(r.status)}
          <span class="mono">${eq}</span>${waDot(r)}<span>${clock(r.startedAt) ? "started " + clock(r.startedAt) : ""}</span></div>
      </div>
      <div class="row">${action}<a class="btn btnGhost sm" href="#/records?wo=${encodeURIComponent(r.wo)}">Open</a></div>
    </div>`;
}

// ---------- the plan: import it, then check every WO is in TEMS Cloud ----------
const planDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "");

function temsBadge(r) {
  if (r.temsCheck === "found") {
    const where = r.temsWhere === "assign" ? "On Assign" : "In TEMS";
    return `<span class="badge ${r.temsWhere === "assign" ? "bBlue" : "bGreen"}" title="TEMS: ${esc(r.temsName)}">${icon("check", "sm")}${where}</span>`;
  }
  if (r.temsCheck === "missing") return `<span class="badge bRed">${icon("x", "sm")}Not in TEMS</span>`;
  return `<span class="badge bGrey">Not checked</span>`;
}

function importCard() {
  const settings = store.settings || {};
  const el = document.createElement("div");
  el.className = "card importCard";
  el.innerHTML = `
    <div class="cardHead"><h2>Import plan</h2><span class="hint planInfo">Excel or CSV · team ${esc(settings.employeeId || "")} only · checked against TEMS Cloud</span>
      <div class="actions">
        <button class="btn btnGhost sm checkTems" title="Read every WO in TEMS Cloud (scrolled to the end) and on Assign, and mark this plan's WOs">${icon("refresh", "sm")}<span>Check TEMS</span></button>
      </div></div>
    <div class="cardBody stack">
      <label class="dropzone">${icon("sheet", "lg")}<div><b>Drop the day's plan here</b> or click to pick</div>
        <div class="note">Columns are found by their values, so header names don't matter. Every WO is then looked up in TEMS Cloud.</div>
        <input type="file" accept=".xlsx,.xlsm,.csv,.xls" hidden></label>
      <div class="importMsg"></div>
      <div class="jobSlot"></div>
      <div class="planChips row wrap"></div>
      <div class="sheetWrap planTable"></div>
    </div>`;
  const job = jobPanel();
  $(".jobSlot", el).replaceWith(job.el);
  let plan = { rows: [] }, checking = false;

  const fileInput = $("input[type=file]", el), zone = $(".dropzone", el), checkButton = $(".checkTems", el);
  const say = (kind, text) => {
    $(".importMsg", el).innerHTML = text
      ? `<div class="callout ${kind}">${icon(kind === "ok" ? "check" : kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>` : "";
  };

  async function load() {
    try { plan = await api("/api/import/last"); } catch { return; }
    paint();
  }

  function paint() {
    const rows = plan.rows || [];
    checkButton.disabled = checking || !rows.length;
    const count = (test) => rows.filter(test).length;
    const found = count((r) => r.temsCheck === "found"), missing = rows.filter((r) => r.temsCheck === "missing");
    const scrollToWaiting = missing.length ? ` <a href="#" class="toWaiting">see Waiting on TEMS</a>` : "";
    const unchecked = count((r) => !r.temsCheck);
    const checkedAt = rows.map((r) => r.temsCheckAt).filter(Boolean).sort().pop();
    $(".planInfo", el).textContent = rows.length
      ? `${plan.source} · imported ${niceTime(plan.importedAt)}${checkedAt ? ` · TEMS checked ${niceTime(checkedAt)}` : ""}`
      : `Excel or CSV · team ${settings.employeeId || ""} only · checked against TEMS Cloud`;
    $(".planChips", el).innerHTML = rows.length ? [
      ["WOs in the plan", rows.length, "var(--text)"],
      ["In TEMS", found, "var(--green)"],
      ["Not in TEMS", missing.length, missing.length ? "var(--red)" : "var(--faint)"],
      ["Not checked", unchecked, unchecked ? "var(--amber)" : "var(--faint)"],
    ].map(([label, n, color]) => `<span class="chip">${label} <b style="color:${color}">${n}</b></span>`).join("") + scrollToWaiting : "";
    $(".toWaiting", el)?.addEventListener("click", (e) => { e.preventDefault(); document.querySelector(".waitingCard")?.scrollIntoView({ behavior: "smooth", block: "start" }); });

    $(".planTable", el).innerHTML = rows.length
      ? `<table class="sheet"><thead><tr><th>#</th><th>WO</th><th>Date</th><th>Grid</th><th>TEMS</th><th>Records</th></tr></thead>
          <tbody>${rows.map((r, n) => `<tr class="${r.temsCheck === "missing" ? "missingRow" : ""}">
            <td class="num">${n + 1}</td>
            <td><a class="wo" href="#/records?wo=${encodeURIComponent(r.wo)}" title="Open in Records">${esc(r.wo)}</a>
              ${r.excelWo && r.excelWo !== r.wo ? `<div class="note">plan: ${esc(r.excelWo)}</div>` : ""}</td>
            <td>${esc(planDate(r.planDate))}</td>
            <td class="mono" title="${esc(r.gridKey || "")}">${esc(shortGridKey(r.gridKey))}${r.gridCount > 1 ? ` +${r.gridCount - 1}` : ""}</td>
            <td>${temsBadge(r)}</td>
            <td>${progressBadge(r)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">${icon("sheet")}<p>No plan imported yet.</p></div>`;
  }

  async function checkTems() {
    if (checking) return;
    checking = true; paint();
    try {
      const { job: started } = await api("/api/import/check", { body: {} });
      const done = await job.run(started);
      await load();
      if (done.state === "done") {
        const r = done.result || {};
        toast(r.summary || "TEMS checked.", r.missing?.length ? "warn" : "ok", 7000);
        if (r.problems?.length) say("warn", r.problems.join("\n"));
      } else toast(done.error || "TEMS check stopped.", "bad");
    } catch (error) {
      toast(error.message, "bad");
    } finally { checking = false; paint(); }
  }
  checkButton.addEventListener("click", checkTems);

  const importFile = async (file) => {
    if (!file) return;
    const form = new FormData(); form.append("file", file);
    say("info", `Reading ${file.name}…`);
    try {
      const r = await api("/api/import", { form });
      const parts = [`Imported ${r.count} WOs from ${r.source}`, `${r.added} new`];
      if (r.updated) parts.push(`${r.updated} already in Records`);
      if (r.alreadyStarted) parts.push(`${r.alreadyStarted} already started`);
      let text = parts.join(" · ") + ". Checking them in TEMS Cloud…";
      if (r.notes?.length) text += "\n" + r.notes.map((n) => `• ${n}`).join("\n");
      say(r.notes?.length ? "warn" : "ok", text);
      refreshState();
      await load();
      if (r.count) checkTems();
    } catch (error) {
      say("bad", error.message);
    } finally { fileInput.value = ""; }
  };
  fileInput.addEventListener("change", () => importFile(fileInput.files[0]));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); importFile(e.dataTransfer.files[0]); });

  load();
  return { el, load };
}

// A one-column table (header "WO"): pastes into Excel as cells, WOs kept as text.
async function copyWos(wos, button) {
  const tsv = ["WO", ...wos].join("\r\n");
  const html = `<table><tr><th>WO</th></tr>${wos.map((wo) => `<tr><td style="mso-number-format:'\\@'">${esc(wo)}</td></tr>`).join("")}</table>`;
  flash(button, await copyText(tsv, html), `Copied ${wos.length}`);
}

// ---------- WOs waiting on TEMS: imported, but not in TEMS Cloud yet ----------
// Saved on each WO (tickets.json), so the list is still here after the app is closed. They stay off
// Start's To start list until Recheck finds them in TEMS (the coordinators added them).
function waitingCard() {
  const el = document.createElement("div");
  el.className = "card waitingCard hidden";
  el.innerHTML = `
    <div class="cardHead"><h2>${icon("alert", "sm")} Waiting on TEMS</h2><span class="hint waitingInfo"></span>
      <div class="actions">
        <button class="btn btnPrimary sm recheck" title="Read TEMS Cloud again; every one it now has goes to Start's To start list">${icon("refresh", "sm")}<span>Recheck TEMS</span></button>
      </div></div>
    <div class="cardBody stack">
      <div class="note">Not in TEMS Cloud yet, so they're not on Start's list. Send them to your coordinators, then press <b>Recheck TEMS</b>.</div>
      <div class="jobSlot"></div>
      <div class="sheetWrap waitingTable"></div>
      <div class="row wrap">
        <button class="btn btnGhost sm copyWaiting">${icon("copy", "sm")}<span>Copy for Excel</span></button>
        <a class="btn btnGhost sm" href="/api/import/missing.xlsx" download>${icon("sheet", "sm")}<span>Download Excel</span></a>
      </div>
    </div>`;
  const job = jobPanel();
  $(".jobSlot", el).replaceWith(job.el);
  let rows = [], busy = false;

  async function load() {
    try { rows = await api("/api/import/notInTems"); } catch { return; }
    paint();
  }
  function paint() {
    el.classList.toggle("hidden", !rows.length && !busy);
    const checkedAt = rows.map((r) => r.temsCheckAt).filter(Boolean).sort().pop();
    $(".waitingInfo", el).textContent = `${rows.length} WO${rows.length === 1 ? "" : "s"}${checkedAt ? ` · last checked ${niceTime(checkedAt)}` : ""}`;
    $(".recheck", el).disabled = busy || !rows.length;
    $(".copyWaiting", el).disabled = !rows.length;
    $(".waitingTable", el).innerHTML = rows.length
      ? `<table class="sheet"><thead><tr><th>#</th><th>WO</th><th>Date</th><th>Grid</th><th>From</th></tr></thead>
          <tbody>${rows.map((r, n) => `<tr class="missingRow"><td class="num">${n + 1}</td>
            <td class="mono">${esc(r.wo)}</td><td>${esc(planDate(r.planDate))}</td>
            <td class="mono" title="${esc(r.gridKey)}">${esc(shortGridKey(r.gridKey))}</td>
            <td class="note">${esc(r.importSource)}</td></tr>`).join("")}</tbody></table>`
      : "";
  }
  $(".copyWaiting", el).addEventListener("click", (event) => copyWos(rows.map((r) => r.wo), event.currentTarget));
  $(".recheck", el).addEventListener("click", async () => {
    if (busy || !rows.length) return;
    busy = true; paint();
    const wos = rows.map((r) => r.wo);
    try {
      const { job: started } = await api("/api/import/check", { body: { wos } });
      const done = await job.run(started);
      if (done.state === "done") {
        const found = done.result?.found?.length || 0;
        toast(found ? `${found} of ${wos.length} now in TEMS - added to Start's To start list.`
          : `Still not in TEMS: all ${wos.length}.`, found ? "ok" : "warn", 7000);
      } else toast(done.error || "TEMS check stopped.", "bad");
    } catch (error) {
      toast(error.message, "bad");
    } finally { busy = false; await load(); refreshState(); }
  });
  load();
  return { el, load };
}
