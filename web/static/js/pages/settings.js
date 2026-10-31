// Settings: edit every .env value (checked, saved after you confirm, then the app restarts
// itself) and the Chrome extension connection.
import { $, $$, ago, api, esc, icon, modal, niceTime, setWhatsappSend, store, toast } from "../core.js";
import { switchEl } from "../components.js";

const monoTypes = new Set(["url", "email", "dir", "path", "list", "readonly"]);
const justSavedKey = "kaamSettingsJustSaved";

export default {
  title: "Settings",
  sub: "Change any value, then Save - the app restarts with it",
  async render(root) {
    root.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    let s, env;
    try { [s, env] = await Promise.all([api("/api/settings"), api("/api/settings/env")]); }
    catch (error) { root.innerHTML = `<div class="callout bad">${esc(error.message)}</div>`; return; }

    const b = s.bridge;
    const fresh = b.lastContactAt && Date.now() / 1000 - b.lastContactAt < 75;
    const groups = [...new Set(env.fields.map((f) => f.group))];
    // An empty optional setting shows the built-in value the app is using, so nothing looks blank.
    const original = Object.fromEntries(env.fields.map((f) => [f.key, f.value === "" && f.default != null ? f.default : f.value]));
    const values = { ...original };

    // What the last Save changed - kept across the restart, shown once at the top.
    let justSaved = [];
    try { justSaved = JSON.parse(sessionStorage.getItem(justSavedKey) || "[]"); sessionStorage.removeItem(justSavedKey); } catch { /* none */ }
    const show = (v) => (v === "" || v == null ? "<i>empty</i>" : `<code>${esc(v)}</code>`);
    const changeRow = (c) => `<div class="chRow"><b>${esc(c.label)}</b> <span class="setKey">${esc(c.key)}</span><div>${show(c.old)} <span class="arrow">→</span> ${show(c.new)}</div></div>`;
    // History grouped by save (same time), newest first.
    const batches = [];
    (env.history || []).forEach((c) => {
      const last = batches[batches.length - 1];
      if (last && last.at === c.at) last.items.push(c); else batches.push({ at: c.at, items: [c] });
    });

    root.innerHTML = `
      ${justSaved.length ? `<div class="callout ok" style="margin-bottom:16px">${icon("check", "sm")}<div>
          <b>Saved and restarted - ${justSaved.length} setting${justSaved.length === 1 ? "" : "s"} changed:</b>
          <div class="changeList" style="margin-top:8px">${justSaved.map(changeRow).join("")}</div></div></div>` : ""}
      <div class="card">
        <div class="cardHead"><h2>Chrome extension</h2></div>
        <div class="cardBody stack">
          <div class="row"><span class="dot ${b.running ? (fresh ? "on" : "warn") : "off"}"></span>
            <b>${b.running ? (fresh ? "Connected" : "Waiting for the extension") : "Bridge not running"}</b>
            <span class="note">${b.running ? `port ${b.port} · last check-in ${ago(b.lastContactAt)}` : ""}</span></div>
          ${b.error ? `<div class="callout bad">${icon("alert", "sm")}<div>${esc(b.error)}</div></div>` : ""}
          ${b.running && !fresh ? `<div class="callout warn">${icon("info", "sm")}<div>The extension checks in every 30 seconds. If it never shows as connected, open chrome://extensions and click reload on Kaam25 Helper.</div></div>` : ""}
          <div class="note">Extension on disk: v${esc(b.diskVersion || "?")}${b.extensionVersion ? ` · running in Chrome: v${esc(b.extensionVersion)}` : ""}</div>
          ${b.running ? "" : `<div><button class="btn btnPrimary startBridge">${icon("plug", "sm")}<span>Start the bridge</span></button></div>`}
        </div>
      </div>
      <div class="setGroups">${groups.map((group) => `
        <div class="card">
          <div class="cardHead"><h2>${esc(group)}</h2></div>
          <div class="cardBody stack">${env.fields.filter((f) => f.group === group).map(fieldHtml).join("")}</div>
        </div>`).join("")}
      </div>
      <div class="saveBar">
        <span class="note saveInfo"></span><span class="spacer"></span>
        <button class="btn btnGhost reset">${icon("refresh", "sm")}<span>Undo changes</span></button>
        <button class="btn btnPrimary save">${icon("save", "sm")}<span>Save settings</span></button>
      </div>
      <div class="note" style="margin-top:10px">Saved in ${esc(env.envPath)} · a copy of the old file goes to backups/ first.</div>
      <div class="card" style="margin-top:16px">
        <div class="cardHead"><h2>Change history</h2><span class="hint">Every change saved here, newest first</span></div>
        <div class="cardBody">${batches.length ? batches.map((b) => `
          <div class="chBatch"><div class="chTime">${esc(niceTime(b.at))} · ${b.items.length} change${b.items.length === 1 ? "" : "s"}</div>
            ${b.items.map(changeRow).join("")}</div>`).join("")
          : `<div class="note">Nothing changed from this page yet.</div>`}</div>
      </div>`;

    function fieldHtml(f) {
      const id = `set_${f.key}`;
      let control;
      if (f.type === "bool") control = `<div class="boolSlot" data-key="${f.key}"></div>`;
      else if (f.type === "choice") {
        control = `<select class="input" id="${id}" data-key="${f.key}">${f.options.map((o) =>
          `<option ${o === original[f.key] ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      } else {
        const type = f.type === "int" ? "number" : f.type === "time" ? "time" : "text";
        control = `<input class="input ${monoTypes.has(f.type) ? "mono" : ""}" id="${id}" data-key="${f.key}" type="${type}"
          ${f.type === "int" ? `min="${f.min ?? 0}" max="${f.max ?? ""}"` : ""} ${f.type === "readonly" ? "readonly" : ""}
          spellcheck="false" autocomplete="off" placeholder="${f.optional ? "empty = built-in default" : ""}" value="${esc(original[f.key])}">`;
      }
      return `<div class="field setField" data-field="${f.key}">
          <label class="label" for="${id}">${esc(f.label)}<span class="setKey">${esc(f.key)}</span></label>
          ${control}${f.help ? `<div class="note">${esc(f.help)}</div>` : ""}</div>`;
    }

    // ----- controls -----
    const switches = {};
    $$(".boolSlot", root).forEach((slot) => {
      const key = slot.dataset.key;
      const sw = switchEl((on) => (on ? "<b>On</b>" : "<b>Off</b>"), values[key] === "true", (on) => { values[key] = on ? "true" : "false"; paint(); });
      switches[key] = sw;
      slot.replaceWith(sw.el);
    });
    $$(".setGroups [data-key]", root).forEach((input) => {
      input.addEventListener("input", () => { values[input.dataset.key] = input.value; paint(); });
      input.addEventListener("change", () => { values[input.dataset.key] = input.value; paint(); });
    });

    const changedKeys = () => env.fields.filter((f) => f.type !== "readonly" && values[f.key] !== original[f.key]).map((f) => f.key);
    function paint() {
      const changed = changedKeys();
      $$(".setField", root).forEach((el) => el.classList.toggle("changed", changed.includes(el.dataset.field)));
      $(".saveInfo", root).textContent = changed.length ? `${changed.length} unsaved change${changed.length === 1 ? "" : "s"}` : "No changes";
      $(".save", root).disabled = !changed.length;
      $(".reset", root).disabled = !changed.length;
    }
    paint();

    $(".reset", root).addEventListener("click", () => {
      Object.assign(values, original);
      $$(".setGroups [data-key]", root).forEach((input) => { input.value = original[input.dataset.key]; });
      Object.entries(switches).forEach(([key, sw]) => sw.set(original[key] === "true"));
      paint();
    });

    // ----- save: confirm, write .env, restart, reload -----
    $(".save", root).addEventListener("click", async () => {
      const changed = changedKeys();
      if (!changed.length) return;
      const byKey = Object.fromEntries(env.fields.map((f) => [f.key, f]));
      const running = store.state?.jobs?.length || 0;
      const ok = await modal({
        title: `Save ${changed.length} setting${changed.length === 1 ? "" : "s"}?`,
        body: `<div class="changeList">${changed.map((k) =>
            changeRow({ key: k, label: byKey[k].label, old: original[k], new: values[k] })).join("")}</div>` +
          `\nThis writes them to .env and restarts the app (a few seconds).` +
          (running ? `\n<b>${running} job${running === 1 ? " is" : "s are"} running and will be stopped.</b>` : ""),
        buttons: [{ label: "Cancel", value: false }, { label: "Save & restart", value: true, cls: "btnPrimary" }],
      });
      if (!ok) return;
      const button = $(".save", root);
      button.disabled = true;
      let saved;
      try {
        saved = await api("/api/settings/env", { body: { changes: Object.fromEntries(changed.map((k) => [k, values[k]])) } });
      } catch (error) {
        toast(error.message, "bad", 9000);
        paint();
        return;
      }
      if (changed.includes("WHATSAPP_SEND")) setWhatsappSend(values.WHATSAPP_SEND === "true");  // End's switch follows
      (saved.warnings || []).forEach((w) => toast(w, "warn", 9000));
      try { sessionStorage.setItem(justSavedKey, JSON.stringify(saved.changes || [])); } catch { /* storage blocked */ }
      await restartAndReload();
    });

    async function restartAndReload() {
      const overlay = document.createElement("div");
      overlay.className = "backdrop";
      overlay.innerHTML = `<div class="modal"><h3>Restarting…</h3><div class="mBody"><span class="spinner"></span> Settings saved. The app is restarting with them - this page reloads by itself.</div></div>`;
      $("#modalRoot").append(overlay);
      let before;
      try { before = (await api("/api/restart", { method: "POST" })).bootedAt; } catch { /* it may already be going */ }
      const end = Date.now() + 40000;
      while (Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        try {
          const state = await api("/api/state");
          if (state.bootedAt && state.bootedAt !== before) { location.reload(); return; }
        } catch { /* still restarting */ }
      }
      $(".mBody", overlay).innerHTML = "The settings are saved, but the app didn't come back. Double-click the Kaam25 shortcut (or runWeb.bat) to start it.";
    }

    $(".startBridge", root)?.addEventListener("click", async () => {
      try { await api("/api/bridge/start", { method: "POST" }); toast("Bridge started.", "ok"); this.render(root); }
      catch (error) { toast(error.message, "bad", 7000); }
    });
  },
};
