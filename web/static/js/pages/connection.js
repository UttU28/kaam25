// Connection: a QR code of this app's address on the WiFi this PC is on (its IPv4 + the port), so a
// tablet or phone on the same WiFi scans it and opens the app. Read fresh, so a new WiFi shows its own.
import { api, copyText, enc, esc, flash, icon, toast } from "../core.js";

export default {
  title: "Connection",
  sub: "Scan to open the app on a phone or tablet on the same WiFi",
  render(root) {
    let timer = null, last = "";
    root.innerHTML = `
      <div class="stack connPage">
        <div class="card">
          <div class="cardHead"><h2>Open on another device</h2><span class="hint connHint"></span>
            <span class="spacer"></span>
            <button class="btn btnGhost sm connRefresh" title="Read this PC's WiFi address again">${icon("refresh", "sm")}<span>Refresh</span></button>
          </div>
          <div class="cardBody connBody"><div class="note">Reading this PC's WiFi address…</div></div>
        </div>
      </div>`;
    const bodyEl = root.querySelector(".connBody");

    function paint(info) {
      const key = JSON.stringify(info);
      if (key === last) return;  // same address: leave the QR as it is
      last = key;
      root.querySelector(".connHint").textContent = info.ip ? `${info.ip} · port ${info.port}` : "";
      if (!info.url) {
        bodyEl.innerHTML = `<div class="callout warn">${icon("alert", "sm")}<div>This PC isn't on a WiFi / network right now, so there's no address to share. Connect to WiFi - this page updates by itself.</div></div>`;
        return;
      }
      bodyEl.innerHTML = `
        ${info.lanAccess ? "" : `<div class="callout bad">${icon("alert", "sm")}<div><b>WiFi access is off</b> (<span class="mono">LAN_ACCESS=false</span> in <span class="mono">.env</span>), so other devices can't reach the app. Set it to <span class="mono">true</span> (or delete that line) and restart the app, then scan.</div></div>`}
        <div class="qrBox connQr">
          <img class="qrImg" src="/api/qr?text=${enc(info.url)}" alt="QR code for ${esc(info.url)}">
          <a class="qrLink mono connUrl" href="${esc(info.url)}" target="_blank" rel="noopener">${esc(info.url)}</a>
          <div class="qrActions">
            <button class="btn btnPrimary connCopy" data-url="${esc(info.url)}">${icon("copy", "sm")}<span>Copy link</span></button>
          </div>
          <div class="note connSteps">Same WiFi as this laptop → open the camera → scan → the app opens.<br>
            If it doesn't load: both on the same WiFi (not guest / mobile data), and allow Python through the Windows Firewall when Windows asks.</div>
        </div>
        ${info.hotspot ? `<div class="qrBox connQr connHotspot">
          <div class="sectionT">On this laptop's own hotspot</div>
          <img class="qrImg" src="/api/qr?text=${enc(info.hotspot.url)}" alt="QR code for ${esc(info.hotspot.url)}">
          <a class="qrLink mono connUrl" href="${esc(info.hotspot.url)}" target="_blank" rel="noopener">${esc(info.hotspot.url)}</a>
          <div class="qrActions"><button class="btn btnPrimary connCopy" data-url="${esc(info.hotspot.url)}">${icon("copy", "sm")}<span>Copy link</span></button></div>
          <div class="note connSteps">For devices connected to the laptop's Mobile hotspot.</div>
        </div>` : `<div class="callout info connTip">${icon("info", "sm")}<div>
          <b>Only the phone sharing the hotspot can open it?</b> Phone hotspots often keep the devices on them apart -
          each reaches the internet and the phone, not each other. Way round it: on this laptop turn on
          <b>Windows Settings → Network &amp; internet → Mobile hotspot</b> (share the Wi-Fi), connect the tablet to the
          laptop's hotspot, and a second QR for it shows up here.</div></div>`}
        ${info.others?.length ? `<div class="connOthers"><div class="sectionT">Other addresses of this PC</div>
          ${info.others.map((o) => `<div class="connOther"><a class="mono" href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.url)}</a>
            <button class="iconBtn sm connCopy" data-url="${esc(o.url)}" title="Copy link">${icon("copy", "sm")}</button></div>`).join("")}
          <div class="note">Only if the QR doesn't work (e.g. a VPN or a second network card).</div></div>` : ""}`;
    }

    async function load() {
      try { paint(await api("/api/connection")); }
      catch (error) { last = ""; bodyEl.innerHTML = `<div class="callout bad">${icon("alert", "sm")}<div>${esc(error.message)}</div></div>`; }
    }

    root.addEventListener("click", async (e) => {
      const copy = e.target.closest(".connCopy");
      if (copy) { const ok = await copyText(copy.dataset.url); flash(copy, ok, ok ? "Copied" : "Copy failed"); }
      if (e.target.closest(".connRefresh")) { last = ""; await load(); toast("Address read again.", "ok", 1800); }
    });

    load();
    timer = setInterval(() => { if (!document.hidden) load(); }, 10000);  // WiFi changed: new QR
    return () => clearInterval(timer);
  },
};
