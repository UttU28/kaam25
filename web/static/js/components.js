// Reusable pieces: WO box, location card, segmented control, switch, job panel.
import { $, $$, api, cleanWo, copyText, copyWithFlash, debounce, enc, esc, flash, h, icon, modal, stopAll, store, toast, watchJob } from "./core.js";

// The WO's location: Apeksha on -> its Google Maps link is posted there; off -> a QR code of the link
// (scan it to open the spot, even with little or no internet), the link, Copy link and lat / long.
export const mapsUrl = (lat, lon) => `https://www.google.com/maps?q=${String(lat).trim()},${String(lon).trim()}`;
export function locationTarget() {
  const apeksha = store.settings?.locationVia === "apeksha";
  return { apeksha, title: apeksha ? "Send the WO's Google Maps link to Apeksha" : "QR code of the WO's Google Maps link (scan to open the spot)" };
}
export async function shareLocation(record, button) {
  const lat = record?.lat, lon = record?.long, wo = record?.wo || "";
  if (!lat || !lon) { toast("No location saved for this WO.", "warn"); return; }
  if (!locationTarget().apeksha) { showLocationQr(wo, lat, lon); return; }
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/records/${enc(wo)}/location`, { method: "POST" });
    if (button) flash(button, true, "Sent");
    toast(data.message || "Sent the Maps link to Apeksha.", "ok");
  } catch (error) {
    if (button) flash(button, false);
    toast(`Couldn't send to Apeksha: ${error.message}`, "bad", 8000);
  } finally { if (button) button.disabled = false; }
}
export function showLocationQr(wo, lat, lon) {
  const url = mapsUrl(lat, lon);
  modal({
    title: wo || "Location",
    body: `<div class="qrBox">
        <img class="qrImg" src="/api/qr?text=${enc(url)}" alt="QR code for ${esc(url)}">
        <a class="qrLink mono" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>
        <div class="qrActions">
          <button class="btn btnPrimary qrCopy">${icon("copy", "sm")}<span>Copy link</span></button>
          <button class="btn btnGhost qrCopyLatLon" title="Copy lat, long">${icon("pin", "sm")}<span>${esc(lat)}, ${esc(lon)}</span></button>
        </div>
        <div class="note">Scan with a phone camera to open the spot in Google Maps.</div>
      </div>`,
    buttons: [{ label: "Close", value: true }],
  });
  const box = $("#modalRoot .qrBox");
  $(".qrCopy", box).addEventListener("click", (e) => copyWithFlash(e.currentTarget, url, "Link copied"));
  $(".qrCopyLatLon", box).addEventListener("click", (e) => copyWithFlash(e.currentTarget, `${lat}, ${lon}`, "Copied"));
}

const matchedNames = { gridKey: "Grid key", ticketId: "Ticket ID", excelWo: "The Excel spelling" };

// ---------- WO box ----------
// opts: label, placeholder, picker {label, empty, load: async () => [{wo, title, sub, badge}]},
//       onResolve(wo, record, matchedBy), onEnter(wo)
//       compact: true - no Copy button, the picker is a small list button inside the box
//       tools: extra icon buttons (html) inside a compact box, left of the list button
//       preview: true (compact) - copy / send icons: copy the preview (WO / Grid Key / Location),
//                QR icon: the Maps link as a QR code (or to Apeksha when it's on).
//       showPreview: true - the preview text (WO / Grid Key / Location) shown under the box
export function woBox(opts = {}) {
  const previewHtml = opts.compact && opts.preview
    ? `<button class="iconBtn sm copyPreview" title="Copy the preview (WO / Grid Key / Location)">${icon("copy", "sm")}</button>
       <button class="iconBtn sm sendPreview" title="${esc(locationTarget().title)}">${icon("qr", "sm")}</button>
       ${opts.picker ? `<span class="sep"></span>` : ""}`
    : "";
  const pickerHtml = !opts.picker ? ""
    : opts.compact
      ? `<div class="pickerBtn"><button class="iconBtn sm pick" title="${esc(opts.picker.label)}">${icon("chevron", "sm")}<span class="pickCount hidden"></span></button></div>`
      : `<div class="pickerBtn"><button class="btn btnGhost pick" title="${esc(opts.picker.label)}">${icon("list", "sm")}<span class="pickLabel">${esc(opts.picker.label)}</span>${icon("chevron", "sm")}</button></div>`;
  const el = h(`<div class="field woBox ${opts.compact ? "compact" : ""}">
      <label class="label">${esc(opts.label || "WO")}</label>
      <div class="inputGroup">
        <div class="inputWrap">
          <input class="input mono" spellcheck="false" autocomplete="off" placeholder="${esc(opts.placeholder || "Paste a WO, grid key or Ticket ID")}">
          ${opts.compact
            ? `<div class="insideTools"><button class="iconBtn sm clear hidden" title="Clear">${icon("x", "sm")}</button>${previewHtml}${opts.tools || ""}${pickerHtml}</div>`
            : `<button class="iconBtn sm clear hidden" title="Clear">${icon("x", "sm")}</button>`}
        </div>
        ${opts.compact ? "" : `<button class="btn btnGhost copyBtn" title="Copy the WO">${icon("copy", "sm")}<span>Copy</span></button>${pickerHtml}`}
      </div>
      <div class="match note"></div>
      ${opts.showPreview ? `<pre class="pre woPreview hidden"></pre>` : ""}
    </div>`);
  const input = $("input", el), clear = $(".clear", el), match = $(".match", el), preview = $(".woPreview", el);
  let record = null, lastResolved = null, token = 0;
  // Room for the icons inside the box: clear + copy + send + list.
  el.style.setProperty("--tools", 1 + (previewHtml ? 2 : 0) + (opts.picker ? 1 : 0));

  // Copy / send the preview of the WO in the box (as Records has it).
  const tick = (button, ok) => {
    const was = button.innerHTML;
    button.classList.add(ok ? "done" : "failed");
    button.innerHTML = icon(ok ? "check" : "x", "sm");
    setTimeout(() => { button.classList.remove("done", "failed"); button.innerHTML = was; }, 1400);
  };
  const previewText = () => {
    const wo = cleanWo(input.value);
    if (!wo) return "";
    if (record?.locationPreview) return record.locationPreview;
    return `WO: ${wo}\nGrid Key: ${record?.gridKey || ""}\nLocation: ${record?.location || ""}`;
  };
  $(".copyPreview", el)?.addEventListener("click", async (event) => {
    const button = event.currentTarget, text = previewText();
    if (!text) { toast("Type or pick a WO first.", "warn"); return; }
    const ok = await copyText(text);
    tick(button, ok);
    toast(ok ? "Preview copied." : "Couldn't copy the preview.", ok ? "ok" : "bad");
  });
  $(".sendPreview", el)?.addEventListener("click", async () => {
    const wo = cleanWo(input.value);
    if (!wo) { toast("Type or pick a WO first.", "warn"); return; }
    if (!record) { toast(`${wo} isn't in Records.`, "warn"); return; }
    if (!record.hasLocation) { toast("No location saved for this WO.", "warn"); return; }
    shareLocation({ ...record, wo: record.wo || wo });
  });

  const resolveNow = async () => {
    const raw = input.value;
    const cleaned = cleanWo(raw);
    clear.classList.toggle("hidden", !raw);
    if (!cleaned) { record = null; lastResolved = ""; match.textContent = ""; paintPreview(); opts.onResolve?.("", null, null); return; }
    const mine = ++token;
    try {
      const data = await api(`/api/resolve?q=${enc(raw)}`);
      if (mine !== token) return;
      record = data.record;
      if (data.wo !== raw) { input.value = data.wo; }
      paintPreview();
      match.className = "match note " + (data.matchedBy && data.matchedBy !== "wo" ? "info" : "");
      if (matchedNames[data.matchedBy]) match.textContent = `${matchedNames[data.matchedBy]} ${raw.trim()} matched this WO.`;
      else if (!record) match.textContent = "Not in Records yet.";
      else match.textContent = "";
      if (data.wo !== lastResolved || data.matchedBy) { lastResolved = data.wo; opts.onResolve?.(data.wo, record, data.matchedBy, data); }
    } catch (error) {
      match.className = "match note bad"; match.textContent = error.message;
    }
  };
  // The preview under the box (showPreview): only for a WO that's in Records.
  function paintPreview() {
    if (!preview) return;
    const text = record ? previewText() : "";
    preview.textContent = text;
    preview.classList.toggle("hidden", !text);
  }
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
      const badge = $(".pickCount", el);  // compact: a small number on the list button
      if (badge) { badge.textContent = count || ""; badge.classList.toggle("hidden", !count); }
      const pick = $(".pick", el);
      if (pick) pick.title = `${opts.picker.label}${count ? ` (${count})` : ""}`;
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
          <button class="btn btnGhost sm send" title="${esc(locationTarget().title)}">${icon("qr", "sm")}<span>${locationTarget().apeksha ? "Send" : "QR"}</span></button>
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
    send.title = hasLocation ? locationTarget().title : "No location saved for this WO";
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
// A badge: icon + word, or (iconOnly, for tight lists) just the icon with the word on hover.
const badge = (cls, iconName, text, iconOnly) => (iconOnly
  ? `<span class="badge ${cls} iconOnly" title="${text}" aria-label="${text}">${icon(iconName, "sm")}</span>`
  : `<span class="badge ${cls}">${iconName ? icon(iconName, "sm") : ""}${text}</span>`);
export function typeBadge(startType, iconOnly = false) {
  if (startType === "cloud") return badge("bBlue", "cloud", "Cloud", iconOnly);
  if (startType === "local") return badge("bPurple", "laptop", "Local", iconOnly);
  if (startType === "manual") return badge("bGrey", "check", "Done by hand", iconOnly);
  return "";
}
export const waDot = (record) =>
  `<span class="waDot ${record?.whatsappSentAt ? "sent" : ""}" title="${record?.whatsappSentAt ? "Shared on WhatsApp" : "Not shared on WhatsApp yet"}">${icon("whatsapp", "sm")}</span>`;
export function progressBadge(r, iconOnly = false) {
  const kind = {
    closed: ["bGreen", "lock", "Closed"],
    completed: ["bGreen", "check", "Completed"],
    inProgress: ["bAmber", "clock", "In progress"],
    notStarted: ["bBlue", iconOnly ? "play" : "", "Not started"],
  }[r.progress];
  return kind ? badge(...kind, iconOnly) : "";
}
