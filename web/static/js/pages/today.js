// Today: the day at a glance - cloud ticket, counts, and every ticket touched today.
import { $, clock, copyWithFlash, esc, h, icon, refreshState, store } from "../core.js";
import { progressBadge, statusBadge, typeBadge, waDot } from "../components.js";

export default {
  title: "Today",
  sub: () => new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
  render(root) {
    root.innerHTML = "";
    const paint = (s) => { if (s) draw(root, s); };
    paint(store.state);
    refreshState();
    return store.on(paint);
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

  root.innerHTML = `
    <div class="hero">
      <div class="heroCard">${cloudCard}</div>
      <div class="stats">${stats.map(([t, n, href, color]) =>
        `<a class="stat" href="${href}"><div class="n" style="color:${n ? color : "var(--faint)"}">${n}</div><div class="t">${t}</div></a>`).join("")}</div>
    </div>
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
