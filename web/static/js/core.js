// Shared helpers: API, icons, toasts, dialogs, clipboard, time formatting, app state, jobs.

// ---------- API ----------
export async function api(path, options = {}) {
  const init = { method: options.method || (options.body || options.form ? "POST" : "GET"), headers: {} };
  if (options.form) init.body = options.form;
  else if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error("Can't reach the Kaam25 server. Is it still running?");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}
export const enc = (text) => encodeURIComponent(text);

// ---------- html ----------
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function h(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ---------- icons (lucide-style strokes) ----------
const paths = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  today: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  end: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  records: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  navigate: '<path d="m3 11 19-9-9 19-2-8-8-2z"/>',
  whatsapp: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>',
  laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  map: '<path d="M14.1 6.3 9.9 4.2a2 2 0 0 0-1.8 0L3.6 6.5A1 1 0 0 0 3 7.4v12a1 1 0 0 0 1.4.9l3.7-1.9a2 2 0 0 1 1.8 0l4.2 2.1a2 2 0 0 0 1.8 0l4.5-2.3a1 1 0 0 0 .6-.9v-12a1 1 0 0 0-1.4-.9l-3.7 1.9a2 2 0 0 1-1.8 0z"/><path d="M15 5.8v15M9 3.2v15"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7M5 11l9 9"/>',
};
export function icon(name, size = "") {
  return `<span class="i ${size}"><svg viewBox="0 0 24 24">${paths[name] || ""}</svg></span>`;
}
export function hydrateIcons(root = document) {
  $$("[data-icon]", root).forEach((el) => { el.outerHTML = icon(el.dataset.icon, el.className.replace(/\bi\b/, "").trim()); });
}

// ---------- toasts ----------
const toastIcons = { ok: "check", bad: "alert", warn: "alert", info: "info" };
export function toast(text, kind = "info", ms = 4200) {
  const node = h(`<div class="toast ${kind}">${icon(toastIcons[kind] || "info")}<div>${esc(text)}</div></div>`);
  $("#toasts").append(node);
  setTimeout(() => { node.style.transition = "opacity .25s"; node.style.opacity = "0"; setTimeout(() => node.remove(), 260); }, ms);
}

// ---------- modal ----------
// buttons: [{label, value, cls}] -> resolves with the clicked value (null on Esc / backdrop).
export function modal({ title, body, buttons = [{ label: "OK", value: true, cls: "btnPrimary" }] }) {
  return new Promise((resolve) => {
    const root = $("#modalRoot");
    const node = h(`<div class="backdrop"><div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3><div class="mBody">${body}</div>
        <div class="mActions">${buttons.map((b, n) => `<button class="btn ${b.cls || "btnGhost"}" data-n="${n}">${esc(b.label)}</button>`).join("")}</div>
      </div></div>`);
    const close = (value) => { node.remove(); document.removeEventListener("keydown", onKey, true); resolve(value); };
    const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(null); } };
    node.addEventListener("click", (event) => {
      if (event.target === node) return close(null);
      const button = event.target.closest("[data-n]");
      if (button) close(buttons[+button.dataset.n].value);
    });
    document.addEventListener("keydown", onKey, true);
    root.append(node);
    $(".mActions .btn:last-child", node)?.focus();
  });
}
// A popup with input boxes. fields: [{name, label, value, readonly, help}].
// Resolves {action, values: {name: text}} - action is the clicked button's value (null on Esc).
export function formModal({ title, body = "", fields = [], buttons }) {
  return new Promise((resolve) => {
    const root = $("#modalRoot");
    const node = h(`<div class="backdrop"><div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3><div class="mBody">${body}</div>
        <div class="stack" style="margin-top:12px">${fields.map((f) => `<div class="field">
            <label class="label">${esc(f.label)}</label>
            <input class="input mono" data-name="${esc(f.name)}" value="${esc(f.value || "")}" spellcheck="false" autocomplete="off" ${f.readonly ? "readonly" : ""}>
            ${f.help ? `<div class="note" style="margin-top:4px">${esc(f.help)}</div>` : ""}</div>`).join("")}</div>
        <div class="mActions">${buttons.map((b, n) => `<button class="btn ${b.cls || "btnGhost"}" data-n="${n}">${esc(b.label)}</button>`).join("")}</div>
      </div></div>`);
    const values = () => Object.fromEntries([...node.querySelectorAll("input[data-name]")].map((i) => [i.dataset.name, i.value.trim()]));
    const close = (action) => { const v = values(); node.remove(); document.removeEventListener("keydown", onKey, true); resolve({ action, values: v }); };
    const onKey = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); close(null); }
      if (event.key === "Enter" && event.target.matches?.("input[data-name]")) { event.preventDefault(); close(buttons[buttons.length - 1].value); }
    };
    node.addEventListener("click", (event) => {
      if (event.target === node) return close(null);
      const button = event.target.closest("[data-n]");
      if (button) close(buttons[+button.dataset.n].value);
    });
    document.addEventListener("keydown", onKey, true);
    root.append(node);
    const first = node.querySelector("input[data-name]:not([readonly])");
    if (first) { first.focus(); first.select(); }
  });
}
export const confirmBox = (title, body, okLabel = "OK", okCls = "btnPrimary") =>
  modal({ title, body, buttons: [{ label: "Cancel", value: false }, { label: okLabel, value: true, cls: okCls }] });

// ---------- clipboard / button feedback ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h("<textarea style='position:fixed;opacity:0'></textarea>");
    area.value = text; document.body.append(area); area.select(); document.execCommand("copy"); area.remove();
  }
}
export function flash(button, ok = true, text = ok ? "Copied" : "Failed") {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.innerHTML;
  clearTimeout(button._flash);
  button.classList.add(ok ? "flashOk" : "flashBad");
  button.innerHTML = `${icon(ok ? "check" : "x", "sm")}<span>${esc(text)}</span>`;
  button._flash = setTimeout(() => {
    button.classList.remove("flashOk", "flashBad");
    button.innerHTML = button.dataset.label; delete button.dataset.label;
  }, 1400);
}
export async function copyWithFlash(button, text, label = "Copied") {
  if (!text) return;
  await copyText(text);
  flash(button, true, label);
}

// ---------- misc ----------
export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
const parse = (iso) => (iso ? new Date(iso) : null);
export function clock(iso) {
  const d = parse(iso);
  return d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}
export function niceTime(iso) {
  const d = parse(iso);
  return d ? `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(iso)}` : "";
}
export function dayLabel(iso) {
  const d = parse(iso);
  if (!d) return "UNDATED";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "TODAY";
  if (diff === 1) return "YESTERDAY";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
}
export const isToday = (iso) => dayLabel(iso) === "TODAY";
export function ago(seconds) {
  if (seconds == null) return "never";
  const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

// ---------- report (same text as kaam/workflows.formatReport) ----------
export function formatReport(f) {
  const g = (k) => String(f[k] ?? "").trim();
  let text = `WO: ${g("wo")}\nTicket ID: ${g("ticket")}\n\nEQ3: ${g("eq3")}\nEQ6: ${g("eq6")}\n\n` +
    `TOTAL GRIDS: ${g("total")}\nGRIDS ATTEMPTED: ${g("attempted")}\nGRIDS SKIPPED: ${g("skipped")}\nSTATUS : ${g("status")}`;
  if (g("remarks")) text += `\n\nREMARKS: ${g("remarks")}`;
  return text;
}
export function cleanWo(text) {
  return String(text || "").replace(/^\s*(?:cloud\s*wo\s*-\s*|wo\s*:\s*)/i, "").trim();
}

// ---------- shared app state ----------
export const store = {
  state: null, settings: null, whatsappSend: true, listeners: new Set(),
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};
export async function refreshState() {
  try {
    store.state = await api("/api/state");
    store.listeners.forEach((fn) => { try { fn(store.state); } catch (e) { console.error(e); } });
  } catch (error) {
    console.warn(error);
  }
  return store.state;
}
// WhatsApp "press Send": set in Settings (or End), remembered in this browser; .env is the default.
const whatsappSendKey = "kaamWhatsappSend";
export function loadWhatsappSend(envDefault) {
  let saved = null;
  try { saved = localStorage.getItem(whatsappSendKey); } catch { /* storage blocked */ }
  store.whatsappSend = saved === null ? Boolean(envDefault) : saved === "1";
}
export function setWhatsappSend(on) {
  store.whatsappSend = Boolean(on);
  try { localStorage.setItem(whatsappSendKey, on ? "1" : "0"); } catch { /* storage blocked */ }
}

// fn() runs whenever the saved data changes (any page, tab or Chrome job),
// not on the first call. Returns the unsubscribe function - hand it back as a page's cleanup.
export function onDataChange(fn) {
  let seen = store.state?.dataVersion;
  return store.on((state) => {
    if (!state?.dataVersion || state.dataVersion === seen) return;
    seen = state.dataVersion;
    fn(state);
  });
}
// Live updates: check every 4 s while the page is visible, and at once when you come back to it.
export function startLiveUpdates(ms = 4000) {
  setInterval(() => { if (!document.hidden) refreshState(); }, ms);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshState(); });
  window.addEventListener("focus", () => refreshState());
}

// ---------- jobs ----------
// Polls a job until it ends; onUpdate(job) on every change. Resolves with the final job.
export function watchJob(job, onUpdate) {
  return new Promise((resolve) => {
    let seen = -1;
    const tick = async () => {
      try {
        job = await api(`/api/jobs/${job.id}`);
      } catch (error) {
        job = { ...job, state: "error", error: error.message };
      }
      const signature = job.lines.length + job.state + JSON.stringify(job.data);
      if (signature !== seen) { seen = signature; onUpdate?.(job); }
      if (job.state === "running") setTimeout(tick, 600);
      else { refreshState(); resolve(job); }
    };
    onUpdate?.(job);
    setTimeout(tick, 400);
  });
}
export async function stopAll() {
  await api("/api/stop", { method: "POST" });
  toast("Stop sent. Anything waiting on Chrome ends now.", "warn");
}
