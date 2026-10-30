// Settings: what .env is set to, where files live, and the Chrome extension connection.
import { $, ago, api, esc, icon, setWhatsappSend, store, toast } from "../core.js";
import { switchEl } from "../components.js";

export default {
  title: "Settings",
  sub: "From .env - edit that file and restart the server to change these",
  async render(root) {
    root.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    let s;
    try { s = await api("/api/settings"); } catch (error) { root.innerHTML = `<div class="callout bad">${esc(error.message)}</div>`; return; }
    const yes = (v) => (v ? "On" : "Off");
    const table = (rows) => `<div class="setTable">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join("")}</div>`;
    const b = s.bridge;
    const fresh = b.lastContactAt && Date.now() / 1000 - b.lastContactAt < 75;
    root.innerHTML = `
      <div class="grid cols2" style="align-items:start">
        <div class="stack">
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
          <div class="card"><div class="cardHead"><h2>You</h2></div><div class="cardBody">${table([
            ["Employee / team", s.employeeId], ["Region · Market", `${s.region} · ${s.market}`],
            ["Drive shift PM from", s.pmFrom], ["Logs uploaded previous day", s.logsPreviousDay],
          ])}</div></div>
          <div class="card"><div class="cardHead"><h2>Report defaults</h2></div><div class="cardBody">${table([
            ["Total · attempted · skipped", `${s.defaults.total} · ${s.defaults.attempted} · ${s.defaults.skipped}`],
            ["Status", s.defaults.status], ["Folder name prefix", s.folderNamePrefix], ["Equipments", s.equipments.join(", ")],
          ])}</div></div>
        </div>
        <div class="stack">
          <div class="card"><div class="cardHead"><h2>WhatsApp</h2></div><div class="cardBody stack">
            <div class="waSlot"></div>
            <div class="note">Used by WhatsApp on End and Records. Remembered in this browser; .env default: ${yes(s.whatsappSend)}.</div>
          </div></div>
          <div class="card"><div class="cardHead"><h2>Automation</h2></div><div class="cardBody">${table([
            ["Start: Submit by default", yes(s.defaultSubmit)], ["ActixOne: Submit", yes(s.actixSubmit)],
            ["WhatsApp group", s.whatsappGroup],
            ["WhatsApp retries", s.whatsappRetries], ["Close tabs when done", yes(s.closeTabsWhenDone)],
          ])}</div></div>
          <div class="card"><div class="cardHead"><h2>Web pages</h2></div><div class="cardBody">${table(Object.entries(s.urls))}</div></div>
          <div class="card"><div class="cardHead"><h2>Files</h2></div><div class="cardBody">${table(Object.entries(s.paths))}</div></div>
        </div>
      </div>`;
    const wa = switchEl((on) => on ? "<b>Send ON</b> · presses Send in WhatsApp" : "<b>Send OFF</b> · fills the message, you press Send",
      store.whatsappSend, (on) => { setWhatsappSend(on); toast(`WhatsApp: Send ${on ? "ON" : "OFF"}`, "info"); }, "var(--wa)");
    $(".waSlot", root).replaceWith(wa.el);
    $(".startBridge", root)?.addEventListener("click", async () => {
      try { await api("/api/bridge/start", { method: "POST" }); toast("Bridge started.", "ok"); this.render(root); }
      catch (error) { toast(error.message, "bad", 7000); }
    });
  },
};
