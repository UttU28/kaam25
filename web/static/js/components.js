// Reusable pieces: WO box, location card, segmented control, switch, job panel.
import { $, $$, api, cleanWo, copyWithFlash, debounce, enc, esc, flash, h, icon, stopAll, toast, watchJob } from "./core.js";

const matchedNames = { gridKey: "Grid key", ticketId: "Ticket ID", excelWo: "The Excel spelling" };

// ---------- WO box ----------
// opts: label, placeholder, picker {label, empty, load: async () => [{wo, title, sub, badge}]},
//       onResolve(wo, record, matchedBy), onEnter(wo)
//       compact: true - no Copy button, the picker is a small list button inside the box
//       tools: extra icon buttons (html) inside a compact box, left of the list button
export function woBox(opts = {}) {
  const pickerHtml = !opts.picker ? ""
    : opts.compact
      ? `<div class="pickerBtn"><button class="iconBtn sm pick" title="${esc(opts.picker.label)}">${icon("chevron", "sm")}</button></div>`
      : `<div class="pickerBtn"><button class="btn btnGhost pick" title="${esc(opts.picker.label)}">${icon("list", "sm")}<span class="pickLabel">${esc(opts.picker.label)}</span>${icon("chevron", "sm")}</button></div>`;
  const el = h(`<div class="field woBox ${opts.compact ? "compact" : ""}">
      <label class="label">${esc(opts.label || "WO")}</label>
      <div class="inputGroup">
        <div class="inputWrap">
          <input class="input mono" spellcheck="false" autocomplete="off" placeholder="${esc(opts.placeholder || "Paste a WO, grid key or Ticket ID")}">
          ${opts.compact
            ? `<div class="insideTools"><button class="iconBtn sm clear hidden" title="Clear">${icon("x", "sm")}</button>${opts.tools || ""}${pickerHtml}</div>`
            : `<button class="iconBtn sm clear hidden" title="Clear">${icon("x", "sm")}</button>`}
        </div>
        ${opts.compact ? "" : `<button class="btn btnGhost copyBtn" title="Copy the WO">${icon("copy", "sm")}<span>Copy</span></button>${pickerHtml}`}
      </div>
      <div class="match note"></div>
    </div>`);
  const input = $("input", el), clear = $(".clear", el), match = $(".match", el);
  let record = null, lastResolved = null, token = 0;

  const resolveNow = async () => {
    const raw = input.value;
    const cleaned = cleanWo(raw);
    clear.classList.toggle("hidden", !raw);
    if (!cleaned) { record = null; lastResolved = ""; match.textContent = ""; opts.onResolve?.("", null, null); return; }
    const mine = ++token;
    try {
      const data = await api(`/api/resolve?q=${enc(raw)}`);
      if (mine !== token) return;
      record = data.record;
      if (data.wo !== raw) { input.value = data.wo; }
      match.className = "match note " + (data.matchedBy && data.matchedBy !== "wo" ? "info" : "");
      if (matchedNames[data.matchedBy]) match.textContent = `${matchedNames[data.matchedBy]} ${raw.trim()} matched this WO.`;
      else if (!record) match.textContent = "Not in Records yet.";
      else match.textContent = "";
      if (data.wo !== lastResolved || data.matchedBy) { lastResolved = data.wo; opts.onResolve?.(data.wo, record, data.matchedBy, data); }
    } catch (error) {
      match.className = "match note bad"; match.textContent = error.message;
    }
  };
  const resolve = debounce(resolveNow, 220);

  input.addEventListener("input", resolve);
  input.addEventListener("keydown", async (event) => {
    // The type-to-search list: arrows move, Enter picks the highlighted WO, Esc closes it.
    if (pickerKeys(event)) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    await resolveNow();  // a pasted grid key / Ticket ID becomes its WO first
    opts.onEnter?.(cleanWo(input.value));
  });
  clear.addEventListener("click", () => { input.value = ""; resolve(); input.focus(); });
  $(".copyBtn", el)?.addEventListener("click", (event) => {
    const wo = cleanWo(input.value);
    if (wo) copyWithFlash(event.currentTarget, wo); else toast("Nothing to copy - the WO box is empty.", "warn");
  });

  let refreshPicker = () => {};
  let pickerKeys = () => false;
  if (opts.picker) {
    const holder = $(".pickerBtn", el);
    let items = [], shown = [], sel = -1, query = "";
    const squash = (text) => String(text || "").replace(/\s+/g, "").toLowerCase();
    const paint = (pop) => {
      const q = squash(query);
      shown = q ? items.filter((item) => [item.wo, item.title, item.sub].some((t) => squash(t).includes(q))) : items;
      if (sel >= shown.length) sel = shown.length - 1;
      pop.innerHTML = `<div class="popHead">${esc(opts.picker.label)}${q ? ` · matching "${esc(query.trim())}"` : ""} · ${shown.length}</div>` + (shown.length
        ? shown.map((item, n) => `<div class="popItem ${n === sel ? "sel" : ""}" data-n="${n}">
              <div style="min-width:0;flex:1"><div class="mainT">${esc(item.title)}</div><div class="subT">${esc(item.sub || "")}</div></div>
              ${item.badge || ""}</div>`).join("")
        : `<div class="popEmpty">${esc(q ? "No matches in this list." : opts.picker.empty || "Nothing here.")}</div>`);
      pop.querySelector(".popItem.sel")?.scrollIntoView({ block: "nearest" });
    };
    const fill = async (pop) => {
      try { items = await opts.picker.load(); } catch (error) { toast(error.message, "bad"); return; }
      if (pop.isConnected) paint(pop);
    };
    const choose = (pop, n) => {
      const item = shown[n];
      if (!item) return;
      pop.remove();
      setValue(item.wo);
      opts.picker.onPick?.(item);
    };
    // Opens the list (filtered by `text` when given); reuses an open one.
    const openPop = async (text = "") => {
      query = text;
      let pop = $(".popover", holder);
      if (pop) { paint(pop); return pop; }
      $$(".popover").forEach((p) => p.remove());
      pop = h(`<div class="popover"><div class="popHead">${esc(opts.picker.label)}</div><div class="popEmpty">Loading…</div></div>`);
      holder.append(pop);
      pop.addEventListener("click", (e) => {
        const row = e.target.closest(".popItem");
        if (row) choose(pop, +row.dataset.n);
      });
      sel = -1;
      await fill(pop);
      return pop;
    };
    $(".pick", el).addEventListener("click", async (event) => {
      event.stopPropagation();
      const open = $(".popover", holder);
      if (open) { open.remove(); return; }
      await openPop("");
    });
    // Typing searches the list: 2+ characters (e.g. "139") show the matching WOs.
    input.addEventListener("input", () => {
      const text = input.value.trim();
      if (text.length < 2) { $(".popover", holder)?.remove(); return; }
      sel = -1;
      openPop(text);
    });
    pickerKeys = (event) => {
      const pop = $(".popover", holder);
      if (!pop) return false;
      if (event.key === "Escape") { pop.remove(); event.preventDefault(); return true; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        sel = event.key === "ArrowDown" ? Math.min(sel + 1, shown.length - 1) : Math.max(sel - 1, 0);
        paint(pop);
        return true;
      }
      if (event.key === "Enter" && sel >= 0 && shown[sel]) { event.preventDefault(); choose(pop, sel); return true; }
      if (event.key === "Enter") pop.remove();
      return false;
    };
    // Live: an open list reloads itself when the data changes.
    refreshPicker = () => { const pop = $(".popover", holder); if (pop) fill(pop); };
  }

  function setValue(wo) { input.value = wo || ""; resolve(); }
  return {
    el, input,
    get: () => cleanWo(input.value),
    set: setValue,
    record: () => record,
    focus: () => input.focus(),
    refresh: () => { lastResolved = null; resolve(); },
    refreshPicker: () => refreshPicker(),
    setPickerCount(count) {
      const label = $(".pickLabel", el);
      if (label) label.textContent = `${opts.picker.label}${count ? ` (${count})` : ""}`;
    },
  };
}
document.addEventListener("click", (event) => {
  if (!event.target.closest(".popover")) $$(".popover").forEach((p) => p.remove());
});

// ---------- location card ----------
export function locationCard(title = "WO · Grid Key · Location") {
  const el = h(`<div class="card loc">
      <div class="cardHead"><h2>${esc(title)}</h2>
        <div class="actions">
          <button class="btn btnGhost sm send" title="Send the preview and a Maps link to Apeksha">${icon("navigate", "sm")}<span>Send</span></button>
          <button class="btn btnGhost sm copy" title="Copy all of it">${icon("copy", "sm")}<span>Copy</span></button>
        </div></div>
      <div class="cardBody"><pre class="pre"></pre><div class="note locNote" style="margin-top:8px"></div></div>
    </div>`);
  const pre = $("pre", el), send = $(".send", el), note = $(".locNote", el);
  let wo = "", hasLocation = false;
  $(".copy", el).addEventListener("click", (e) => copyWithFlash(e.currentTarget, pre.textContent));
  send.addEventListener("click", async () => {
    if (!hasLocation) return;
    send.disabled = true;
    try {
      const data = await api(`/api/records/${enc(wo)}/location`, { method: "POST" });
      flash(send, true, "Sent");
      note.className = "note locNote ok"; note.textContent = data.message;
    } catch (error) {
      flash(send, false);
      note.className = "note locNote bad"; note.textContent = `Couldn't send the location: ${error.message}`;
    } finally { send.disabled = !hasLocation; }
  });
  function show(newWo, record) {
    if (newWo !== wo) note.textContent = "";
    wo = newWo || "";
    const lat = record?.lat || "", lon = record?.long || "";
    hasLocation = Boolean(lat && lon);
    pre.textContent = `WO: ${wo}\nGrid Key: ${record?.gridKey || ""}\nLocation: ${lat || lon ? `${lat}, ${lon}` : ""}`;
    send.disabled = !hasLocation;
    send.title = hasLocation ? `Send the preview and a Maps link for ${lat}, ${lon} to Apeksha` : "No location saved for this WO";
  }
  show("", null);
  return { el, show };
}

// ---------- segmented control ----------
export function seg(options, value, onChange, cls = "") {
  const el = h(`<div class="seg ${cls}">${options.map((o) =>
    `<button type="button" data-v="${esc(o.value)}">${o.icon ? icon(o.icon, "sm") : ""}<span>${esc(o.label)}</span></button>`).join("")}</div>`);
  const set = (v, fire = false) => {
    value = v;
    $$("button", el).forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));
    if (fire) onChange?.(v);
  };
  el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && !b.disabled) set(b.dataset.v, true); });
  set(value);
  return { el, get: () => value, set, disable: (off) => $$("button", el).forEach((b) => (b.disabled = off)) };
}

// ---------- switch ----------
export function switchEl(labelFor, checked, onChange, color) {
  const el = h(`<label class="switch"${color ? ` style="--switchColor:${color}"` : ""}><input type="checkbox"><span class="track"></span><span class="swLabel"></span></label>`);
  const box = $("input", el), label = $(".swLabel", el);
  const paint = () => { label.innerHTML = labelFor(box.checked); };
  box.checked = Boolean(checked);
  box.addEventListener("change", () => { paint(); onChange?.(box.checked); });
  paint();
  return { el, get: () => box.checked, set: (v) => { box.checked = Boolean(v); paint(); } };
}

// ---------- job panel ----------
export function jobPanel() {
  const el = h(`<div class="job hidden">
      <div class="jobHead"><span class="spinner"></span><span class="jTitle"></span><span class="spacer"></span>
        <button class="btn btnStop sm stop">${icon("stop", "sm")}<span>Stop</span></button></div>
      <div class="jobLines"></div><div class="jobResult hidden"></div></div>`);
  const lines = $(".jobLines", el), result = $(".jobResult", el), stop = $(".stop", el), spin = $(".spinner", el);
  stop.addEventListener("click", () => stopAll().catch((e) => toast(e.message, "bad")));
  function render(job) {
    el.classList.remove("hidden");
    $(".jTitle", el).textContent = job.title;
    lines.innerHTML = job.lines.map((l) => `<div><span class="t">${new Date(l.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>${esc(l.text)}</div>`).join("")
      || `<div><span class="t"></span>Starting…</div>`;
    lines.scrollTop = lines.scrollHeight;
    const running = job.state === "running";
    spin.classList.toggle("hidden", !running);
    stop.classList.toggle("hidden", !running);
    result.classList.toggle("hidden", running);
    if (!running) {
      const ok = job.state === "done" && job.result?.ok !== false;
      result.className = `jobResult ${ok ? "ok" : "bad"}`;
      const text = job.state === "done" ? (typeof job.result === "string" ? job.result : job.result?.summary || "Done.")
        : job.state === "stopped" ? "Stopped by you." : job.error || "Failed.";
      result.textContent = text;
    }
  }
  return {
    el, render,
    hide: () => el.classList.add("hidden"),
    // Watch a job (from an API reply) until it ends; returns the final job.
    run: (job, onUpdate) => watchJob(job, (j) => { render(j); onUpdate?.(j); }),
  };
}

// ---------- small renderers ----------
export function statusBadge(status) {
  const cls = { PASSED: "bGreen", SKIPPED: "bAmber", FAILED: "bRed" }[status];
  return status ? `<span class="badge ${cls || "bGrey"}">${esc(status)}</span>` : "";
}
export function typeBadge(startType) {
  if (startType === "cloud") return `<span class="badge bBlue">${icon("cloud", "sm")}Cloud</span>`;
  if (startType === "local") return `<span class="badge bPurple">${icon("laptop", "sm")}Local</span>`;
  if (startType === "manual") return `<span class="badge bGrey">${icon("check", "sm")}Done by hand</span>`;
  return "";
}
export const waDot = (record) =>
  `<span class="waDot ${record?.whatsappSentAt ? "sent" : ""}" title="${record?.whatsappSentAt ? "Shared on WhatsApp" : "Not shared on WhatsApp yet"}">W</span>`;
export function progressBadge(r) {
  return {
    closed: `<span class="badge bGreen">${icon("lock", "sm")}Closed</span>`,
    completed: `<span class="badge bGreen">${icon("check", "sm")}Completed</span>`,
    inProgress: `<span class="badge bAmber">${icon("clock", "sm")}In progress</span>`,
    notStarted: `<span class="badge bBlue">Not started</span>`,
  }[r.progress] || "";
}
