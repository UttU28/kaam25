// App shell: routing, sidebar, quick find (Ctrl+K), running-jobs pill, background refresh.
import { $, ago, api, debounce, enc, esc, h, hydrateIcons, icon, loadWhatsappSend, refreshState, startLiveUpdates, store, stopAll, toast } from "./core.js";
import { progressBadge, statusBadge, typeBadge } from "./components.js";
import today from "./pages/today.js";
import start from "./pages/start.js";
import end from "./pages/end.js";
import close from "./pages/close.js";
import records from "./pages/records.js";
import settings from "./pages/settings.js";
import maps from "./pages/maps.js";
import sheets from "./pages/sheets.js";
import live from "./pages/live.js";

const pages = { today, maps, sheets, live, start, end, close, records, settings };
const navItems = [
  ["Work", null],
  ["today", "Today", "today", "var(--accent)"],
  ["start", "Start Ticket", "rocket", "var(--accent)", "toStart"],
  ["live", "Live Testing", "gauge", "var(--green)", "driving"],
  ["end", "End Ticket", "end", "var(--green)", "open"],
  ["close", "Close Ticket", "lock", "var(--amber)", "readyToClose"],
  ["maps", "Maps", "map", "var(--green)"],
  ["sheets", "Sheets", "sheet", "var(--accent)"],
  ["Library", null],
  ["records", "Records", "records", "var(--purple)"],
  ["settings", "Settings", "settings", "var(--muted)"],
];

let cleanup = null, currentName = null;

function renderNav() {
  const counts = store.state?.counts || {};
  $("#nav").innerHTML = navItems.map(([key, label, ico, color, countKey]) => label === null
    ? `<div class="navSection">${key}</div>`
    : `<a href="#/${key}" data-page="${key}" title="${label}" class="${key === currentName ? "active" : ""}" style="--navColor:${color}">
         ${icon(ico)}<span>${label}</span>${countKey && counts[countKey] ? `<span class="count ${key === "end" || key === "live" ? "hot" : ""}">${counts[countKey]}</span>` : ""}</a>`).join("");
}

function renderFoot() {
  const s = store.state;
  if (!s) return;
  const b = s.bridge;
  const fresh = b.lastContactAt && Date.now() / 1000 - b.lastContactAt < 75;
  const dot = !b.running ? "off" : fresh ? "on" : "warn";
  const text = !b.running ? "Chrome bridge off" : fresh ? "Chrome connected" : "Waiting for Chrome";
  $("#sidebarFoot").innerHTML = `
    <a class="footRow" href="#/settings" title="${esc(b.error || `Last check-in ${ago(b.lastContactAt)}`)}"><span class="dot ${dot}"></span><span>${text}</span></a>
    <div class="footRow" title="Shift ${esc(s.shift)} · PM from ${esc(s.pmFrom)}">${icon("clock", "sm")}<span>Shift <b>${esc(s.shift)}</b> · PM from ${esc(s.pmFrom)}</span></div>
    <div class="footRow" title="Team ${esc(s.employeeId)}">${icon("key", "sm")}<span>Team <b>${esc(s.employeeId)}</b></span></div>`;
}

function renderJobsPill() {
  const running = store.state?.jobs || [];
  const pill = $("#jobsPill");
  pill.classList.toggle("hidden", !running.length);
  pill.innerHTML = running.length
    ? `<span class="spinner"></span><span>${running.length === 1 ? esc(running[0].title) : `${running.length} running`}</span>
       <button class="btn btnStop sm" title="Stop everything waiting on Chrome">${icon("stop", "sm")}</button>` : "";
  $("button", pill)?.addEventListener("click", (e) => { e.stopPropagation(); stopAll().catch((err) => toast(err.message, "bad")); });
}

async function route() {
  const [path, query = ""] = (location.hash.replace(/^#\/?/, "") || "today").split("?");
  const name = pages[path] ? path : "today";
  const page = pages[name];
  if (typeof cleanup === "function") { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  currentName = name;
  $("#pageTitle").textContent = page.title;
  $("#pageSub").textContent = typeof page.sub === "function" ? page.sub() : page.sub || "";
  document.title = `${page.title} · Kaam25: 13 Bhai gaadi chalayega`;
  renderNav();
  $("#sidebar").classList.remove("open");
  $("#modalRoot").innerHTML = "";  // a question from the previous page doesn't belong here
  const content = $("#content");
  content.innerHTML = "";
  content.scrollTop = 0; window.scrollTo(0, 0);
  try {
    cleanup = await page.render(content, new URLSearchParams(query));
  } catch (error) {
    console.error(error);
    content.innerHTML = `<div class="callout bad">${icon("alert", "sm")}<div>${esc(error.message)}</div></div>`;
  }
}

// ---------- quick find (Ctrl+K) ----------
function openPalette() {
  const root = $("#paletteRoot");
  if (root.firstChild) return;
  const node = h(`<div class="backdrop"><div class="palette">
      <div class="pInput">${icon("search")}<input placeholder="WO, grid key, Ticket ID, EQ Job ID, cluster…" spellcheck="false"><kbd>Esc</kbd></div>
      <div class="pList"><div class="popEmpty">Type to search your records.</div></div></div></div>`);
  root.append(node);
  const input = $("input", node), listEl = $(".pList", node);
  let results = [], sel = 0;
  const closeIt = () => node.remove();
  const paint = () => {
    listEl.innerHTML = results.length ? results.map((r, n) => `<div class="popItem ${n === sel ? "sel" : ""}" data-n="${n}">
        <div style="min-width:0;flex:1"><div class="mainT">${esc(r.wo)}</div><div class="subT">${esc(r.ticketId || "—")}${r.gridKey ? ` · ${esc(r.gridKey)}` : ""}</div></div>
        ${typeBadge(r.startType)}${progressBadge(r)}${statusBadge(r.status)}</div>`).join("")
      : `<div class="popEmpty">${input.value ? "No matches." : "Type to search your records."}</div>`;
  };
  const go = (r) => {
    if (!r) return;
    closeIt();
    const target = r.progress === "inProgress" ? "end" : r.progress === "notStarted" ? "start" : "records";
    location.hash = `#/${target}?wo=${encodeURIComponent(r.wo)}`;
  };
  input.addEventListener("input", debounce(async () => {
    const text = input.value.trim();
    if (!text) { results = []; return paint(); }
    try { results = (await api(`/api/records?q=${enc(text)}`)).slice(0, 12); } catch { results = []; }
    sel = 0; paint();
  }, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, results.length - 1); paint(); e.preventDefault(); }
    if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
    if (e.key === "Enter") go(results[sel]);
    if (e.key === "Escape") closeIt();
  });
  listEl.addEventListener("click", (e) => { const row = e.target.closest(".popItem"); if (row) go(results[+row.dataset.n]); });
  node.addEventListener("click", (e) => { if (e.target === node) closeIt(); });
  input.focus();
}

// ---------- boot ----------
async function boot() {
  hydrateIcons();
  $("#menuBtn").innerHTML = icon("menu");
  $("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  // Narrow window: the menu slides over the page; a tap outside it (or Esc) closes it.
  $("#navScrim").addEventListener("click", () => $("#sidebar").classList.remove("open"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#sidebar").classList.remove("open"); });
  $("#searchTrigger").addEventListener("click", openPalette);
  $("#jobsPill").addEventListener("click", () => { location.hash = "#/today"; });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    // "/" opens the search too - unless you're typing in a box.
    const typing = e.target.closest?.("input, textarea, select, [contenteditable='true']");
    if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openPalette(); }
  });
  try {
    store.settings = await api("/api/settings");
    loadWhatsappSend(store.settings.whatsappSend);
    // Teams button left of the search (Settings → Web pages → Teams link); hidden when it's empty.
    const teams = $("#teamsBtn");
    if (store.settings.teamsUrl) {
      teams.href = store.settings.teamsUrl;
      teams.innerHTML = icon("teams");
      teams.classList.remove("hidden");
    }
  } catch (error) {
    toast(error.message, "bad", 8000);
  }
  store.on(() => { renderNav(); renderFoot(); renderJobsPill(); });
  await refreshState();
  // The app was restarted (new code): reload so this tab doesn't keep running the old pages.
  const bootedAt = store.state?.bootedAt;
  store.on((s) => { if (bootedAt && s?.bootedAt && s.bootedAt !== bootedAt) location.reload(); });
  window.addEventListener("hashchange", route);
  route();
  startLiveUpdates();
}
boot();
