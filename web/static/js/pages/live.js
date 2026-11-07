// Live Testing: drive the test phones (TMO 1 / TMO 2) from the app, between Start and End Ticket.
// Built to sit in half the screen (the other half is the phones in Vysor).
//   WO        - the ticket being tested; every speed test is saved on it (record.speedTests)
//   Desk      - phones unlocked + Service Mode / Speedtest, Vysor windows, Chrome left half, phones right
//   Desk sets up everything (skips what's done); per phone: the network it's on (NR / LTE / no service),
//   Full test and Speed test (both save the speed and network on the WO), Airplane (toggle only)
//   Test all  - airplane toggle on both phones at once, then the speed tests one by one (never two at once)
//   TEMS map  - the TEMS Paragon map (grid, route, track, car), live
import { $, api, copyText, enc, esc, h, icon, modal, refreshState, store, toast } from "../core.js";
import { jobPanel, seg, woBox } from "../components.js";
import { temsMapCard } from "../temsMapCard.js";

const lastKey = "kaamLiveResults";  // last result per phone (with the WO it was run on)

function loadLast() {
  try { return JSON.parse(localStorage.getItem(lastKey) || "{}"); } catch { return {}; }
}
function clearLast() {
  try { localStorage.removeItem(lastKey); } catch { /* storage blocked */ }
}
function saveLast(result) {
  const all = loadLast();
  all[result.phone] = { ...result, at: new Date().toISOString() };
  try { localStorage.setItem(lastKey, JSON.stringify(all)); } catch { /* storage blocked */ }
}
const mbps = (t) => parseFloat(t?.download) || 0;
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");

// "NR" / "LTE" / "No service" as a coloured chip (withBand: the band too, for saved tests).
function techOf(network) { return network?.tech || "Unknown"; }
function netChip(network, withBand = true) {
  const tech = techOf(network);
  const cls = tech === "NR" ? "nr" : tech === "LTE" ? "lte" : tech === "No service" ? "none" : "unknown";
  const band = withBand ? [network?.band, network?.bw && `${network.bw} MHz`].filter(Boolean).join(" · ") : "";
  return `<span class="netChip ${cls}">${esc(tech)}${band ? ` <span style="font-weight:650">${esc(band)}</span>` : ""}</span>`;
}
// Bars like the phone's status bar (0-4).
function barsHtml(network) {
  const n = network?.bars;
  if (n == null) return "";
  const cls = n >= 3 ? "good" : n === 2 ? "ok" : n === 1 ? "weak" : "bad";
  return `<span class="bars ${cls}" title="${n} of 4 bars">${[1, 2, 3, 4].map((k) => `<i class="${k <= n ? "on" : ""}"></i>`).join("")}</span>`;
}
// The speed test's live number (from the phone's Speedtest gauge).
function liveSpeedHtml(speed) {
  if (!speed?.value) return "--.--";
  const unit = speed.label === "ping" ? "ms" : "Mbps";
  const arrow = speed.label === "upload" ? "↑ " : speed.label === "download" ? "↓ " : "";
  return `${arrow}${esc(speed.value)}<small>${unit}</small>`;
}
function netLine(network) {
  if (!network) return "";
  return [network.pci && `PCI ${network.pci}`, network.rsrp && `RSRP ${network.rsrp}`,
    network.sinr && `SINR ${network.sinr}`].filter(Boolean).join(" · ");
}
// Live signal strip: the numbers that matter while driving (also during a speed test), plain numbers.
const sigCells = [["rsrp", "RSRP"], ["sinr", "SINR"], ["band", "Band"], ["bw", "BW"], ["pci", "PCI"]];
function rsrpClass(v) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return "";
  return n >= -90 ? "good" : n >= -105 ? "ok" : n >= -115 ? "weak" : "bad";
}
function sinrClass(v) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return "";
  return n >= 13 ? "good" : n >= 5 ? "ok" : n >= 0 ? "weak" : "bad";
}
function sigHtml(net, connected) {
  if (!connected) return "";
  const live = net && net.age != null;
  const stale = live && net.age >= 6;
  const dot = `<span class="liveDot ${live ? (stale ? "off" : "on") : ""}" title="${live ? (stale ? `${Math.round(net.age)}s old` : "Live") : "Reading the phone…"}"></span>`;
  const cells = sigCells.map(([key, label]) => {
    const v = net?.[key] || "";
    const cls = key === "rsrp" ? rsrpClass(v) : key === "sinr" ? sinrClass(v) : "";
    return `<div class="sig ${key} ${cls}"><div class="k">${label}${key === "rsrp" ? dot : ""}</div><div class="v">${v ? esc(v) : "—"}</div></div>`;
  }).join("");
  return `<div class="sigGrid">${cells}</div>${stale ? `<div class="sigMeta">${Math.round(net.age)}s old</div>` : ""}`;
}
function speed(t) {
  if (!t) return `<div class="speedBig dim">—</div>`;
  if (t.error || !t.download) return `<div class="speedBig dim">No speed</div>`;
  return `<div class="speedBig" title="Mbps">${esc(t.download)}</div>`;
}

export default {
  title: "Live Testing",
  sub: "Speed tests for the WO you're driving",
  render(root, params) {
    let info = null, record = null, wo = "", timer = null;
    // What's running: "desk" (Set up desk / Close phones / Hotspot / Test All - both phones) or a
    // phone's name (its Full test / Airplane / Speed test). TMO 1 and TMO 2 run side by side.
    const lanes = new Set();
    const busy = () => lanes.size > 0;
    let pending = [];  // phones waiting for a speed result; Test All: in its test order
    let testing = new Set();  // of those, the ones testing right now
    let live = {};     // phone name -> latest live signal reading
    let sigTimer = null;
    root.innerHTML = `
      <div class="stack livePage">
        <div class="card liveTop">
          <div class="cardBody stack">
            <div class="liveTopRow">
            <div class="woSlot"></div>
            <div class="pair">
              <button class="btn btnPrimary lg" data-action="desk" title="Unlocks the phones, sets up Service Mode + Speedtest and Vysor where missing (skips what is already done), Chrome on the left half, TMO 1 and TMO 2 a quarter each on the right">${icon("desk")}<span>Set up desk</span></button>
              <button class="btn btnGhost lg" data-action="closePhones" title="Closes the TMO 1 and TMO 2 windows in Vysor (the phones keep running) - press Set up desk to open them again">${icon("x")}<span>Close phones</span></button>
              <button class="btn btnGhost lg" data-action="hotspot" title="Airplane toggle on both phones at the same time (that turns any old hotspot off). Once the first is back online it waits 2s more, then turns Mobile Hotspot on on the best of the phones back by then (NR first, then the stronger signal) - a phone slow to load the network is left out. Same name and password on both, so devices just reconnect.">${icon("hotspot")}<span>Hotspot</span></button>
              <button class="btn btnGreen lg" data-action="fullTestAll" title="Service Mode + Speedtest where missing, airplane toggle on both phones at the same time, then the speed tests one phone after the other (NR phones first, then LTE)">${icon("gauge")}<span>Test All</span></button>
            </div>
            </div>
            <div class="temsEnd" hidden>
              <div class="temsEndText">${icon("check", "sm")}<span><b>TEMS: stationary and mobility done.</b> What now?</span></div>
              <div class="temsEndBtns">
                <button class="btn btnGreen" data-tems="submit" title="Suspend in TEMS, a picture of the WO's details on Assign (saved on the WO, used for WhatsApp), open it again and press play, then Results (reloaded until Submit / Discard / Suspend show) and press Submit">${icon("check", "sm")}<span>Submit</span></button>
                <button class="btn btnGhost" data-tems="discard" title="Discard in TEMS (and Yes to its confirm)">${icon("x", "sm")}<span>Discard</span></button>
                <button class="btn btnGhost" data-tems="suspend" title="Suspend in TEMS (and OK to its &quot;summary created&quot;)">${icon("pause", "sm")}<span>Suspend</span></button>
              </div>
            </div>
            <div class="liveHint allHint"></div>
            <div class="runNote" hidden></div>
            <div class="flowStrip"></div>
            <div class="msg"></div>
          </div>
        </div>
        <div class="liveMain">
          <div class="mapSlot"></div>
          <div class="phoneSide">
            <div class="netBar">
              <button class="btn btnPurple" data-action="temsPlay" title="Closes and reopens the phones; in TEMS opens the WO from Assign if it isn't open, waits till it's ready (green), then Control and play - then stays on TEMS">${icon("play", "sm")}<span class="temsPlayLabel">Start Stationary</span></button>
              <button class="btn btnGhost" data-action="airplaneAll" title="Airplane mode on and off on TMO 1 and TMO 2 at the same time (re-attach both to the network) - no speed test">${icon("plane", "sm")}<span>Airplane</span></button>
              <button class="btn btnGhost rebootBtn" data-reboot title="Restart TMO 1 and TMO 2 at the same time (asks first). Nothing waits for it.">${icon("power", "sm")}</button>
            </div>
            <div class="liveGrid phones"></div>
          </div>
        </div>
        <div class="jobSlot"></div>
        <div class="card liveWo">
          <div class="cardHead"><h2>Results on this WO</h2><span class="hint woHint"></span></div>
          <div class="cardBody stack">
            <div class="kv woInfo"></div>
            <div class="techSummary"></div>
            <div class="tests"></div>
          </div>
        </div>
      </div>`;
    const q = (s) => $(s, root);
    // One job panel for the desk (and TEMS), one per phone so TMO 1 and TMO 2 show side by side.
    const job = jobPanel(), jobSlots = h(`<div class="stack jobSlots"></div>`), phoneJobs = {};
    jobSlots.append(job.el); q(".jobSlot").replaceWith(jobSlots);
    function panelFor(lane) {
      if (lane === "desk") return job;
      if (!phoneJobs[lane]) { phoneJobs[lane] = jobPanel(); jobSlots.append(phoneJobs[lane].el); }
      return phoneJobs[lane];
    }
    const hideJobs = () => [job, ...Object.values(phoneJobs)].forEach((panel) => panel.hide());
    const temsMap = temsMapCard(); q(".mapSlot").replaceWith(temsMap.el);

    const box = woBox({
      label: "WO under test",
      placeholder: "The WO you're driving (picked automatically)",
      compact: true,
      preview: true,
      picker: {
        label: "Today's open", empty: "No open tickets today.",
        load: async () => (await api("/api/end/open?all=1")).map((r) => ({
          wo: r.wo, title: r.wo, sub: `${r.ticketId || "no ticket ID"}${r.startType === "local" ? " · local" : ""} · ${r.resultReady ? "result ready" : "driving"}`,
        })),
      },
      onResolve: (newWo, rec) => {
        const next = rec ? newWo : "";
        // A different WO: nothing from the one before (last speeds, job log) is left showing.
        if (next !== wo && !busy()) { clearLast(); hideJobs(); }
        const changed = next !== wo;
        wo = next; record = rec; paintWo(); paintPhones();
        if (changed) setTimeout(resetRun);
      },
      onEnter: () => {},
    });
    q(".woSlot").replaceWith(box.el);
    // ---------- WO and its saved tests ----------
    // Once TEMS has made the WO's result file (GridSummary), the speed results from before it are done
    // with: not shown. Tests run after it (driving the WO again) show as usual.
    const finished = () => Boolean(record?.resultReady);
    const afterResult = (t) => !finished() || (record.resultAt && new Date(t?.at) > new Date(record.resultAt));
    const tests = () => (record?.speedTests || []).filter(afterResult);
    function best(filter) {
      let top = null;
      for (const t of tests()) if (filter(t) && mbps(t) > mbps(top)) top = t;
      return top;
    }

    // ---------- speed tests on the map: where each ran (the phone's GPS), NR / LTE and Mbps ----------
    const metres = (a, b) => {
      const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k), y = (b.lat - a.lat) * k;
      return Math.sqrt(x * x + y * y) * 6371000;
    };
    const techCls = (t) => ({ NR: "nr", LTE: "lte", "No service": "none" }[techOf(t.network)] || "unknown");
    function speedPins() {
      const placed = tests().filter((t) => t.location && Number.isFinite(t.location.lat));
      const bestOf = {};  // the fastest test per NR / LTE: its pin is gold
      for (const t of placed) { const tech = techOf(t.network); if (mbps(t) && mbps(t) > mbps(bestOf[tech])) bestOf[tech] = t; }
      // One pin per test; Test All's NR + LTE (same run, within 15 m) share one.
      const groups = [];
      for (const t of placed) {
        const g = t.runId && groups.find((x) => x.runId === t.runId && metres(x.spot, t.location) <= 15);
        if (g) g.tests.push(t); else groups.push({ runId: t.runId, spot: t.location, tests: [t] });
      }
      return groups.map((g) => {
        const best = g.tests.some((t) => Object.values(bestOf).includes(t));
        const html = `<div class="spPin${best ? " best" : ""}">${g.tests.map((t) =>
          `<div class="spL ${techCls(t)}"><b>${esc(techOf(t.network))}</b>${t.error || !t.download ? "no speed" : esc(t.download)}${Object.values(bestOf).includes(t) ? " ★" : ""}</div>`).join("")}</div>`;
        const { lat, lon } = g.spot;
        const popup = `<div class="spPop">${g.tests.map((t) => `<div class="spRow">
            <div>${netChip(t.network)} <b class="spMbps">${t.error || !t.download ? "No speed" : `${esc(t.download)} Mbps`}</b>${Object.values(bestOf).includes(t) ? ` <span class="badge bGreen">Best ${esc(techOf(t.network))}</span>` : ""}</div>
            <div class="spMeta">${esc(t.phone)} · ping ${esc(t.ping || "?")} · ${time(t.at)}${t.error ? ` · ${esc(t.error)}` : ""}</div>
            <div class="spMeta">${esc(netLine(t.network) || "")}</div></div>`).join("")}
          <div class="spMeta mono">${lat.toFixed(6)}, ${lon.toFixed(6)} · ±${Math.round(g.spot.acc || 0)} m</div>
          <div class="spBtns"><a class="btn btnPrimary sm" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving" target="_blank" rel="noopener">${icon("navigate", "sm")}Go back here</a>
            <button class="btn btnGhost sm" data-copyspot="${lat.toFixed(6)}, ${lon.toFixed(6)}">${icon("copy", "sm")}Lat, long</button></div></div>`;
        return { lat, lon, html, popup, best };
      });
    }
    root.addEventListener("click", (e) => {
      const b = e.target.closest?.("[data-copyspot]");
      if (b) copyText(b.dataset.copyspot).then((ok) => toast(ok ? "Copied the spot" : "Copy failed", ok ? "ok" : "bad"));
    });

    function paintWo() {
      temsMap.setSpeedPins(wo ? speedPins() : []);
      const r = record;
      q(".woHint").textContent = wo ? `${tests().length} test${tests().length === 1 ? "" : "s"}` : "";
      q(".woInfo").innerHTML = r ? [
        ["Ticket", r.ticketId || "—"], ["Cluster", r.cluster || "—"], ["Grid key", r.gridKey || "—"], ["Location", r.location || "—"],
      ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v" title="${esc(v)}">${esc(v)}</div></div>`).join("") : "";
      if (!wo) {
        q(".techSummary").innerHTML = "";
        q(".tests").innerHTML = `<div class="callout info">${icon("info", "sm")}<div>Pick the WO you're driving to save the speed results on it. Tests still run without one.</div></div>`;
        return;
      }
      if (finished() && !tests().length) {
        q(".techSummary").innerHTML = "";
        q(".tests").innerHTML = `<div class="callout ok">${icon("check", "sm")}<div>TEMS has made the result file for this WO, so its speed results are cleared. Pick the WO you're driving now.</div></div>`;
        return;
      }
      // Best speed on NR and on LTE, and which phone got it.
      q(".techSummary").innerHTML = ["NR", "LTE"].map((tech) => {
        const t = best((x) => techOf(x.network) === tech);
        return `<div class="techBox">
            <div class="sectionT" style="margin:0 0 4px">Best on ${tech}</div>
            ${speed(t)}
            <div class="speedMeta">${t ? `<b>${esc(t.phone)}</b> · ping ${esc(t.ping || "?")} · ${time(t.at)}<br>${esc(netLine(t.network) || "")}` : `No ${tech} test yet`}</div>
          </div>`;
      }).join("");
      const list = tests(), bestPerPhone = {};
      for (const t of list) if (!t.error && (!bestPerPhone[t.phone] || mbps(t) > mbps(bestPerPhone[t.phone]))) bestPerPhone[t.phone] = t;
      q(".tests").innerHTML = list.length ? `
          <div class="sheetWrap"><table class="sheet"><thead><tr><th>Phone</th><th>Network</th><th>Mbps</th><th>Ping</th><th>Signal</th><th>Time</th><th></th></tr></thead>
            <tbody>${list.slice().reverse().map((t) => `<tr>
              <td>${esc(t.phone)}${bestPerPhone[t.phone] === t ? ` <span class="badge bGreen">Best</span>` : ""}</td>
              <td>${netChip(t.network)}</td>
              <td class="mono">${t.error ? `<span class="note bad" title="${esc(t.error)}">no speed</span>` : esc(t.download || "?")}</td>
              <td class="mono">${t.ping ? `${esc(t.ping)}${t.pingLoaded ? ` / ${esc(t.pingLoaded)}` : ""}` : "—"}</td>
              <td class="mono">${esc(netLine(t.network) || "—")}</td><td>${time(t.at)}</td>
              <td><button class="iconBtn sm remove" data-id="${esc(t.resultId || "")}" title="Remove this test">${icon("x", "sm")}</button></td>
            </tr>`).join("")}</tbody></table></div>`
        : `<div class="note">No speed tests on this WO yet.</div>`;
    }

    async function reloadRecord() {
      if (!wo) return;
      const wasFinished = finished();
      try {
        record = await api(`/api/records/${enc(wo)}`);
        if (finished() && !wasFinished) { clearLast(); moveToDriving(); }
      }
      catch (error) {
        if (!/not in records/i.test(error.message)) return;  // server busy / restarting: keep what we show
        // The WO was deleted or renamed meanwhile: drop it and pick today's open one again.
        toast(`${wo} isn't in Records any more.`, "warn");
        wo = ""; record = null; box.set("");
        pickDefaultWo();
      }
      paintWo(); paintPhones();
    }

    // The WO being driven: today's open ticket still driving (no result yet), started last.
    function pickDefaultWo() {
      api("/api/end/open?all=1").then((open) => {
        if (box.get() || !open.length) return;
        box.set(open.slice().sort((a, b) => (a.resultReady - b.resultReady) ||
          (b.startedAt || "").localeCompare(a.startedAt || ""))[0].wo);
      }).catch(() => {});
    }

    // The WO's result is in: switch to another WO that's still being driven, if there is one.
    function moveToDriving() {
      api("/api/end/open?all=1").then((open) => {
        const driving = open.filter((r) => !r.resultReady && r.wo !== wo)
          .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))[0];
        if (!driving || busy()) return;
        toast(`${wo} done - now ${driving.wo}.`, "ok", 6000);
        box.set(driving.wo);
      }).catch(() => {});
    }

    q(".tests").addEventListener("click", async (e) => {
      const button = e.target.closest(".remove");
      if (!button || !wo) return;
      try {
        const data = await api("/api/live/tests/remove", { body: { wo, resultId: button.dataset.id } });
        record = { ...record, speedTests: data.speedTests };
        paintWo(); paintPhones();
      } catch (error) { toast(error.message, "bad"); }
    });

    // ---------- phones ----------
    function paintPhones() {
      const last = loadLast();
      const phones = info?.phones || [];
      q(".allHint").textContent = info
        ? `Phone split ${Math.round(info.splitRatio * 100)}:${100 - Math.round(info.splitRatio * 100)} (Service Mode : Speedtest) · airplane ${info.airplaneSeconds}s in Full test · phones are unlocked automatically`
        : "Checking phones…";
      q(".msg").innerHTML = info?.adbError ? callout(info.adbError, "bad")
        : info && !phones.length ? callout("No phones set up. Add the TMO 1 / TMO 2 serials in Settings > Phones.", "warn")
        : info?.unconfigured?.length ? callout(`Connected but not set as TMO 1 / TMO 2 (Settings > Phones): ${info.unconfigured.join(", ")}`, "info") : "";
      q(".phones").innerHTML = phones.map((p) => {
        // Latest result: this browser's last one, or the newest saved on the WO (e.g. run from another tab).
        const savedLatest = tests().filter((t) => t.phone === p.name).slice(-1)[0];
        const mine = last[p.name] && "wo" in last[p.name] && last[p.name].wo === wo && afterResult(last[p.name]) ? last[p.name] : null;
        const r = [mine, savedLatest].filter(Boolean)
          .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
        const onWo = tests().filter((t) => t.phone === p.name && !t.error);
        const top = onWo.reduce((a, t) => (mbps(t) > mbps(a) ? t : a), null);
        const dots = [
          p.connected ? "" : `<span class="badge bRed">Not connected</span>`,
          p.locked ? `<span class="badge bAmber">Locked</span>` : "",
          p.airplane ? `<span class="badge bAmber">${icon("plane", "sm")}Airplane</span>` : "",
          p.testScreen ? `<span class="badge bBlue">Service Mode + Speedtest</span>` : p.connected ? `<span class="badge bGrey">Not set up</span>` : "",
        ].join("");
        const off = !p.connected || lanes.has("desk") || lanes.has(p.name) ? "disabled" : "";
        const button = (action, cls, ico, label, title) =>
          `<button class="btn ${cls}" data-action="${action}" data-phone="${esc(p.name)}" title="${esc(title)}" ${off}>${icon(ico, "sm")}<span>${label}</span></button>`;
        return `
          <div class="card phoneCard">
            <div class="cardBody">
              <div class="phoneHead">
                <h2>${icon("phone", "sm")}${esc(p.name)}</h2>
                <span class="chipSlot" data-phone="${esc(p.name)}">${p.connected ? netChip(live[p.name] || p.network, false) + barsHtml(live[p.name] || p.network) : ""}</span>
                <span class="spacer"></span>
                <span class="hint mono">${esc(p.serial)}</span>
              </div>
              ${p.connected ? `<div class="sigSlot" data-phone="${esc(p.name)}">${sigHtml(live[p.name] || p.network, true)}</div>` : `<div class="netLine">Plug it in over USB</div>`}
              <div class="stateDots">${dots}</div>
              <div class="speedRow">
                ${pending.includes(p.name)
                  ? `<div class="speedBig liveSpeed ${live[p.name]?.speed ? "" : "dim"}" data-phone="${esc(p.name)}">${liveSpeedHtml(live[p.name]?.speed)}</div>
                     <div class="speedMeta"><span class="spinner"></span> <b>${testing.has(p.name) ? "Testing now…" : "Waiting its turn…"}</b><br>waiting for the result</div>`
                  : `${speed(r)}
                <div class="speedMeta">${r ? `${r.error ? esc(r.error) : `ping <b>${esc(r.ping || "?")}</b>`} · ${time(r.at)}${r.network ? ` · ${esc(techOf(r.network))}` : ""}` : "No test yet"}
                  ${top ? `<br>Best on WO <b>${esc(top.download)}</b> (${esc(techOf(top.network))})` : ""}</div>`}
              </div>
              <div class="btnGrid three">
                ${button("fullTest", "btnGreen", "gauge", "Full test", "Set up if needed, airplane toggle, speed test, wait for the result - saved on the WO")}
                ${button("airplane", "btnGhost", "plane", "Airplane", `Airplane mode on ${info?.airplaneSeconds ?? 5}s, then off, wait until online - no test`)}
                ${button("speedtest", "btnPrimary", "play", "Speed test", "Speed test on what's open now, wait for the result - saved on the WO")}
              </div>
            </div>
          </div>`;
      }).join("");
      for (const b of root.querySelectorAll("button[data-action='desk'], button[data-action='closePhones'], button[data-action='hotspot'], button[data-action='airplaneAll'], button[data-action='fullTestAll']")) b.disabled = busy();
    }

    // Live signal: only the chip and the strip change (buttons stay put while you press them).
    async function pollSignal() {
      if (!document.hidden) {
        try {
          live = (await api("/api/live/signal")).phones || {};
          for (const [name, net] of Object.entries(live)) {
            const chip = root.querySelector(`.chipSlot[data-phone="${CSS.escape(name)}"]`);
            const slot = root.querySelector(`.sigSlot[data-phone="${CSS.escape(name)}"]`);
            const speedNow = root.querySelector(`.liveSpeed[data-phone="${CSS.escape(name)}"]`);
            if (chip) chip.innerHTML = netChip(net, false) + barsHtml(net);
            if (speedNow) { speedNow.innerHTML = liveSpeedHtml(net.speed); speedNow.classList.toggle("dim", !net.speed); }
            if (slot) slot.innerHTML = sigHtml(net, true);
          }
        } catch { /* server busy: try again */ }
      }
      sigTimer = setTimeout(pollSignal, 700);
    }

    // Start Stationary: phones reopened; TEMS opens the WO from Assign if needed, waits till it's
    // green, then Control and play (the server checks TEMS's state first).
    let temsBusy = false;
    async function temsJob(body, buttons, onLine = () => {}, quietFail = false) {
      if (temsBusy) return null;
      let done = null;
      temsBusy = true; buttons.forEach((b) => (b.disabled = true));
      let linesShown = 0;
      try {
        const { job: started } = await api("/api/tems", { body });
        done = await job.run(started, (j) => {
          (j.lines || []).slice(linesShown).forEach((line) => { stepToast(line.text); onLine(line.text); });
          linesShown = (j.lines || []).length;
        });
        const failed = done.state !== "done" || done.result?.ok === false;
        const text = done.state === "done" ? (done.result?.summary || done.result?.error) : done.error || "Stopped.";
        if (done.result?.otherWo) {  // TEMS has a different WO active: say so, nothing was pressed
          await modal({
            title: "A different WO is running in TEMS",
            body: `The WO you want, <b>${esc(done.result.wantedWo || body.wo || "")}</b>, isn't running in TEMS -
              <b>${esc(done.result.otherWo)}</b> is (${esc(done.result.otherState || "active")}).\n\nNothing was pressed.
              Finish, suspend or close <b>${esc(done.result.otherWo)}</b> in TEMS first - or pick it here as the WO under test.`,
            buttons: [{ label: "OK", value: true, cls: "btnPrimary" }],
          });
        } else if (!(failed && quietFail)) toast(text, failed ? "bad" : "ok", 10000);
      } catch (error) { done = { state: "error", error: error.message }; if (!quietFail) toast(error.message, "bad", 8000); }
      finally { temsBusy = false; buttons.forEach((b) => (b.disabled = false)); pollStage(true); }
      return done;
    }
    // One start per press: never pressed again by itself. Already testing this WO -> ask first.
    // Didn't go through -> say why and let you decide: Try again or Not now.
    const startTems = async (button) => {
      if (temsBusy) return;
      const forWo = wo || status.temsWo || "the WO TEMS has open";
      const testing = ["stationary", "mobility", "complete"].includes(stage);
      const mobility = stage === "mobility";
      if (!(await modal(testing && !mobility ? {
        title: "This WO is already being tested",
        body: `<b>${esc(forWo)}</b> is at <b>${esc(stage)}</b> in TEMS.\n\nStart it again anyway?`,
        buttons: [{ label: "Cancel", value: false }, { label: "Start again", value: true, cls: "btnPrimary" }],
      } : {
        title: mobility ? "Start Mobility?" : "Start Stationary?",
        body: `On <b>${esc(forWo)}</b>: the phones are reopened, TEMS opens the WO if needed, waits till it's ready (green) and presses play once.`,
        buttons: [{ label: "Cancel", value: false }, { label: mobility ? "Start Mobility" : "Start Stationary", value: true, cls: "btnPrimary" }],
      }))) return;
      starting = true; paintPop();
      const done = await temsJob({ action: "play", wo }, [button], (line) => pop.working(line), true);
      starting = false; pollStage(true); paintPop();
      const failed = done && !done.result?.otherWo && (done.state !== "done" || done.result?.ok === false);
      if (!failed || done.state === "stopped") return;
      if (done.result?.staleResults) {
        await modal({ title: "Nothing pressed", body: esc(done.result.error), buttons: [{ label: "OK", value: true, cls: "btnPrimary" }] });
        return;
      }
      const again = await modal({
        title: "Start Stationary didn't go through",
        body: `${esc(done.result?.error || done.error || "TEMS didn't say why.")}\n\nNothing else is pressed until you decide.`,
        buttons: [{ label: "Not now", value: false }, { label: "Try again", value: true, cls: "btnPrimary" }],
      });
      if (again) startTems(button);
    };

    // ---------- where the TEMS test is: read from TEMS itself (also after a restart) ----------
    // A pop-up follows the test: stationary (stay put) -> mobility (move: beep) -> complete (Submit /
    // Discard / Suspend, double beep). It can be hidden to a small pill; a new stage shows it again.
    let stage = "", status = {}, stageTimer = null, audio = null, starting = false, ending = "";
    root.addEventListener("pointerdown", () => {  // browsers only allow sound after a click on the page
      try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch { /* no sound */ }
    });
    function beep(times = 1) {
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        for (let n = 0; n < times; n++) {
          const tone = audio.createOscillator(), gain = audio.createGain(), at = audio.currentTime + n * 0.22;
          tone.frequency.value = 880; gain.gain.setValueAtTime(0.18, at); gain.gain.exponentialRampToValueAtTime(0.001, at + 0.16);
          tone.connect(gain).connect(audio.destination); tone.start(at); tone.stop(at + 0.17);
        }
      } catch { /* no sound */ }
    }

    const pop = testPopup();
    document.body.append(pop.el, pop.pill);
    pop.onAction = async (kind) => {
      if (kind === "discard") {
        const target = status.wo || wo || "this WO";
        const sure = await modal({
          title: "Discard this test?",
          body: `Discard <b>${esc(target)}</b> in TEMS?\n\nIts test run is thrown away, then the WO is opened again in TEMS (Map page, play not pressed) - you pick what's next.`,
          buttons: [{ label: "Cancel", value: false }, { label: "Yes, discard", value: true, cls: "btnDanger" }],
        });
        if (!sure) return;
      }
      ending = kind;
      paintPop();
      temsJob({ action: kind, wo: status.wo || wo }, [...q(".temsEnd").querySelectorAll("button")], (line) => pop.working(line))
        .finally(() => { ending = ""; paintPop(); });
    };
    // Submit's own screen: its steps, the result form, and Close once it's done (or "did you
    // finish it by hand?" when it got stuck). Stays until Close, also after a reload / restart.
    pop.onSubmitDone = async (forWo) => {
      try { await api("/api/tems/submit/done", { body: { wo: forWo } }); toast(`${forWo}: submitted.`, "ok", 6000); refreshState(); }
      catch (error) { toast(error.message, "bad"); }
      pollStage(true);
    };
    pop.onSubmitClose = async (forWo) => {
      try { await api("/api/tems/submit/close", { body: { wo: forWo } }); } catch (error) { toast(error.message, "bad"); }
      status = { ...status, submit: null };
      paintPop(); pollStage(true);
    };
    function paintPop() {
      // While Submit / Discard / Suspend runs, its own screen stays up (the run is already marked
      // over as soon as TEMS suspends it, but Submit keeps going: picture, play, results, Submit).
      const shown = starting ? "starting" : status.submit || ending === "submit" ? "submit" : ending ? `ending-${ending}` : stage;
      pop.show(shown, status, { pageWo: wo, ending });
    }
    // A different WO: clean slate - no stage, pop-up, note or steps from the WO before.
    function resetRun() {
      stage = ""; status = {}; starting = false; ending = ""; seenCheckIn = undefined; failsSeen = 0;
      q(".temsEnd").hidden = true; q(".runNote").hidden = true; q(".flowStrip").innerHTML = "";
      q(".temsPlayLabel").textContent = "Start Stationary";
      paintPop();
      pollStage(true);
    }
    // The ticket's steps: done, skipped (a later one is done), where we are.
    function paintFlow(flow) {
      const at = (t) => t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      q(".flowStrip").innerHTML = flow.length ? flow.map((f) => `<span class="fStep ${f.state}" title="${esc(
        f.state === "done" ? `${f.label}: ${new Date(f.at).toLocaleString()}${f.how ? ` (${f.how})` : ""}`
          : f.state === "skipped" ? `${f.label}: skipped - a later step is done (done by hand, or not at all)`
            : f.state === "current" ? `${f.label}: next` : f.label)}">${f.state === "done" ? icon("check", "sm") : f.state === "skipped" ? icon("alert", "sm") : ""}<b>${esc(f.label)}</b>${f.state === "done" ? `<i>${esc(at(f.at))}</i>` : f.state === "skipped" ? "<i>skipped</i>" : ""}</span>`).join("") : "";
    }
    // In the grid for the first time (check-in): beep 3 times, say so. The server sets up the desk.
    let seenCheckIn;  // undefined until the first answer for this WO
    function checkInBeep(checkIn) {
      const at = checkIn?.at || "";
      const fresh = at && Date.now() - new Date(at).getTime() < 60000;
      if (at && at !== seenCheckIn && (seenCheckIn !== undefined || fresh)) {
        beep(3);
        toast(`Entered the grid - setting up desk`, "ok", 6000);
      }
      seenCheckIn = at;
    }
    // The stationary test failed in TEMS: say so (with how many times this run), and only press
    // TEMS's "start the stationary test" OK when you choose Redo.
    let failAsking = false, failsSeen = 0;
    const maxTries = 3;  // stationary tries before it can be skipped as failed
    async function stationaryFailed(alert) {
      const fails = alert?.fails || 0;
      if (fails > failsSeen) toast(`Stationary test failed (${Math.min(fails, maxTries)}/${maxTries})`, "bad", 6000);
      failsSeen = fails;
      if (!alert || failAsking || !alert.waiting) return;
      failAsking = true;
      const forWo = wo || status.temsWo || status.wo || "";
      const used = fails >= maxTries;  // 3 tries done: test again, or skip it and move on
      beep(used ? 2 : 1);  // the same beep as stationary done / test complete
      const choice = await modal(used ? {
        title: `Stationary failed ${fails} times`,
        body: `The stationary test on <b>${esc(forWo)}</b> failed <b>${fails} times</b>.

Skip it (saved on the ticket as failed ${fails}x - nothing pressed in TEMS), or test it again?`,
        buttons: [{ label: "Skip it", value: "skip", cls: "btnDanger" }, { label: "Test again", value: "redo", cls: "btnPrimary" }],
      } : {
        title: `Stationary test failed - ${fails}/${maxTries}`,
        body: `TEMS says the stationary test on <b>${esc(forWo)}</b> failed (try ${fails} of ${maxTries}) and asks to start it again.

Retry presses its OK. Cancel leaves it - nothing is pressed.`,
        buttons: [{ label: "Cancel", value: "cancel" }, { label: `Retry (${fails + 1}/${maxTries})`, value: "redo", cls: "btnPrimary" }],
      });
      try {
        if (choice === "redo") {
          const { job: started } = await api("/api/tems/stationaryRedo", { body: { wo: forWo } });
          job.run(started, () => {}).then((done) => toast(done.result?.summary || done.result?.error || done.error || "Done.",
            done.state === "done" && done.result?.ok !== false ? "ok" : "bad"));
        } else await api("/api/tems/stationaryCancel", { body: { wo: forWo, skip: choice === "skip" } });
      } catch (error) { toast(error.message, "bad"); }
      failAsking = false;
      pollStage(true);
    }
    function showStage(next, fresh) {
      const before = stage;
      stage = next;
      status = fresh || status;
      q(".temsPlayLabel").textContent = stage === "mobility" ? "Start Mobility" : "Start Stationary";
      q(".temsEnd").hidden = stage !== "complete";
      if (["stationary", "mobility", "complete"].includes(stage)) starting = false;
      // Ended here with Submit / Discard / Suspend: not a test any more (Submit's reopen included)
      // until Start Stationary begins a new run.
      const ended = stage === "ended" ? status.ended || {} : null;
      const note = q(".runNote");
      note.hidden = !ended && stage !== "otherWo" && stage !== "stale";
      paintFlow(status.flow || []);
      checkInBeep(status.checkIn);
      stationaryFailed(status.stationaryFail);
      if (stage === "otherWo") {
        note.dataset.as = "other";
        note.innerHTML = `${icon("info", "sm")}<span>TEMS has <b>${esc(status.otherWo)}</b> open, not <b>${esc(wo)}</b> - its test isn't shown here.</span>`;
      } else if (stage === "stale") {
        note.dataset.as = "stale";
        note.innerHTML = `${icon("alert", "sm")}<span>TEMS still shows an <b>earlier run</b> of ${esc(wo)} (not this ticket's) - press Start Stationary to test this ticket.</span>
          <button class="btn btnGhost sm" data-adopt title="You tested it by hand in TEMS: count what TEMS shows for this ticket">It's this ticket's run</button>`;
      } else if (ended) {
        const word = { submit: "submitted", discard: "discarded", suspend: "suspended" }[ended.as] || "ended";
        const at = ended.at ? new Date(ended.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
        // Submit is final; Discard / Suspend mean the WO gets tested again
        const next = ended.as === "submit" ? "" : " - ready to test it again: press Start Stationary.";
        note.innerHTML = `${icon(ended.as === "submit" ? "check" : ended.as === "discard" ? "x" : "pause", "sm")}<span><b>${esc(status.wo || wo || "Last run")}</b>: test ${word}${at ? ` ${esc(at)}` : ""}${next || "."}</span>`;
        note.dataset.as = ended.as || "";
      }
      paintPop();
      if (next === before || !before) return;  // first read on opening the page: no sound
      if (stage === "mobility") { beep(1); toast("Stationary done - start moving.", "ok", 8000); }
      if (stage === "complete") { beep(2); toast("Test complete.", "ok", 10000); }
    }
    async function pollStage(once = false) {
      if (!document.hidden) {
        try {
          const asked = wo;
          const now = await api(`/api/tems/status?wo=${enc(asked)}`);
          if (asked === wo) showStage(now.stage || "", now);  // the WO changed meanwhile: not this answer
        } catch { /* server busy: keep what we show */ }
      }
      if (!once) { clearTimeout(stageTimer); stageTimer = setTimeout(pollStage, 3000); }
    }
    q(".temsEnd").addEventListener("click", (e) => {
      const button = e.target.closest("button[data-tems]");
      if (button && !button.disabled) pop.onAction(button.dataset.tems);
    });

    async function loadPhones() {
      try { info = await api("/api/live/phones"); } catch (error) { info = { phones: [], adbError: error.message }; }
      paintPhones();
    }

    // Steps as pop-ups: only results and problems, kept short (the rest is debug - not shown).
    function stepToast(text) {
      const clean = String(text).replace(/^\[([^\]]+)\]\s*/, "$1: ").replace(/WARNING:\s*/i, "");
      const done = clean.match(/^(.+?): speed test done: ([\d.?]+) Mbps down, ping ([\d.?]+) ms/);
      if (done) return toast(`${done[1]}: ${done[2]} Mbps · ping ${done[3]} ms`, "ok", 5000);
      const noSpeed = clean.match(/^(.+?): no speed: ([^(]+)/);
      if (noSpeed) return toast(`${noSpeed[1]}: no speed - ${noSpeed[2].trim()}`, "warn", 6000);
      if (/^(.+?): hotspot (on|off)$/i.test(clean)) return toast(clean, "ok", 4000);
      if (/play pressed|already running/i.test(clean)) return toast("TEMS: playing", "ok", 4000);
      if (/warning|failed|no internet|didn't|not found|couldn't|could not|stuck|may still|isn't/i.test(String(text)))
        toast(clean.replace(/\s*\([^)]*\)/g, ""), "warn", 6000);
    }

    async function run(action, phone) {
      const lane = phone || "desk";
      if (lanes.has("desk") || lanes.has(lane) || (lane === "desk" && busy())) return;
      lanes.add(lane);
      // Phones about to be tested show --.-- until their new result is in (never last time's speed).
      const mine = action === "fullTestAll" ? (info?.phones || []).filter((p) => p.connected).map((p) => p.name)
        : action === "fullTest" || action === "speedtest" ? [phone] : [];  // desk / airplane: no speed to wait for
      pending = [...pending, ...mine];
      if (action === "fullTestAll") testing = new Set(mine.slice(0, 1)); else mine.forEach((name) => testing.add(name));
      const job = panelFor(lane);
      paintPhones();
      let seen = 0, linesShown = 0;
      const runWo = wo;
      try {
        const { job: started } = await api("/api/live/run", { body: { action, phone, wo } });
        let ordered = false;
        const done = await job.run(started, (j) => {
          (j.lines || []).slice(linesShown).forEach((line) => stepToast(line.text));
          linesShown = (j.lines || []).length;
          const results = j.data?.results || [];
          if (!ordered && j.data?.order) {  // Test all: the server picked the order (NR phones first, then LTE)
            ordered = true;
            pending = j.data.order.filter((name) => pending.includes(name));
            testing = new Set(pending.slice(0, 1));
            paintPhones();
          }
          if (results.length > seen) {  // a phone finished: show it now (Test all keeps going)
            results.slice(seen).forEach((x) => saveLast({ ...x, wo: runWo }));
            pending = pending.filter((name) => !results.some((r) => r.phone === name));
            if (action === "fullTestAll") testing = new Set(pending.slice(0, 1));
            seen = results.length;
            paintPhones(); reloadRecord();
          }
        });
        if (done.state === "done") toast(typeof done.result === "string" ? done.result : done.result?.summary || "Done.", "ok", 8000);
        else toast(done.state === "stopped" ? "Stopped." : done.error || "Failed.", "bad", 8000);
      } catch (error) {
        toast(error.message, "bad", 8000);
      } finally {
        lanes.delete(lane);
        pending = pending.filter((name) => !mine.includes(name));
        mine.forEach((name) => testing.delete(name));
        loadPhones(); reloadRecord();
      }
    }

    root.addEventListener("click", async (e) => {
      if (e.target.closest("[data-reboot]")) {
        const sure = await modal({
          title: "Restart both phones?",
          body: "TMO 1 and TMO 2 restart at the same time - about a minute. Anything running on them stops.",
          buttons: [{ label: "Cancel", value: false }, { label: "Restart", value: true, cls: "btnDanger" }],
        });
        if (sure) api("/api/live/reboot", { body: { wo } }).then((r) => toast(r.summary, "ok")).catch((err) => toast(err.message, "bad"));
        return;
      }
      if (e.target.closest("[data-adopt]")) {
        try { await api("/api/tems/adoptRun", { body: { wo } }); toast(`${wo}: TEMS's run counts for this ticket.`, "ok"); }
        catch (err) { toast(err.message, "bad"); }
        pollStage(true);
        return;
      }
      const button = e.target.closest("button[data-action]");
      if (button && !button.disabled && button.dataset.action === "temsPlay") startTems(button);
      else if (button && !button.disabled) run(button.dataset.action, button.dataset.phone || "");
    });

    paintWo();
    loadPhones();
    if (params.get("wo")) box.set(params.get("wo"));
    else pickDefaultWo();
    timer = setInterval(() => { if (!busy() && !document.hidden) { loadPhones(); reloadRecord(); } }, 8000);
    pollSignal();
    pollStage();
    return () => { clearInterval(timer); clearTimeout(sigTimer); clearTimeout(stageTimer); temsMap.destroy(); pop.destroy(); };
  },
};

function callout(text, kind) {
  return `<div class="callout ${kind}">${icon(kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>`;
}

// ---------- the test pop-up ----------
// One screen per stage of the TEMS run, read from TEMS (show(stage, status)). Hide keeps the test
// running and leaves a small pill at the bottom; the next stage opens the pop-up again.
const popSteps = [["stationary", "Stationary"], ["mobility", "Mobility"], ["complete", "Results"]];
const popScreens = {
  starting: { title: "Starting the stationary test", text: "Opening the WO in TEMS and pressing play. Stay with the car - this takes a moment.", step: 0, busy: true },
  stationary: { title: "Stationary test running", text: "Stay where you are. TEMS is testing this spot - we'll tell you when to move.", step: 0, busy: true, count: "stationary", unit: "stationary point", map: true },
  mobility: { title: "Time to move - mobility test", text: "Stationary is done. Drive the route; we'll let you know when it's complete.", step: 1, busy: true, count: "mobility", unit: "waypoint", move: true, map: true },
  complete: { title: "Test complete", text: "Stationary and mobility are done. Choose what to do with this run.", step: 2, done: true },
  submit: { title: "Submitting in TEMS", text: "Leave TEMS to it. Fill in the result below meanwhile - it saves as you change it.", step: 2, busy: true },
  submitDone: { title: "Submitted in TEMS", text: "Submit was pressed in TEMS. Check the result below, then Close.", step: 2, done: true },
  submitByHand: { title: "Marked as submitted", text: "You finished it in TEMS - marked done. Check the result below, then Close.", step: 2, done: true },
  submitFailed: { title: "Submit got stuck", text: "The steps below show how far it got.", step: 2, bad: true },
  "ending-suspend": { title: "Suspending the test", text: "Suspending in TEMS. You'll test this WO again with Start Stationary.", step: 2, busy: true },
  "ending-discard": { title: "Discarding the test", text: "Discarding the run in TEMS, then opening the WO again (Assign, Open, wait for play, Map) - nothing else is pressed.", step: 2, busy: true },
  paused: { title: "Test paused in TEMS", text: "The run is paused. Resume it in TEMS (Control, then play) - this updates by itself.", step: -1 },
  failed: { title: "TEMS stopped the run", text: "TEMS reports the run failed. Check the TEMS tab.", step: -1, bad: true },
};
const sinceKey = "kaamTestSince";

function testPopup() {
  const el = document.createElement("div");
  el.className = "testPop hidden";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="tpCard">
      <div class="tpTop"><span class="tpKicker">TEMS test</span><span class="spacer"></span>
        <button class="iconBtn sm tpHide" title="Hide - the test keeps running">${icon("x", "sm")}</button></div>
      <div class="tpMapSlot" hidden></div>
      <div class="tpVisual"><span class="tpRing"></span><span class="tpRing two"></span><span class="tpCore"></span></div>
      <h2 class="tpTitle"></h2>
      <p class="tpText"></p>
      <div class="tpWo mono"></div>
      <div class="tpProgress"><div class="tpBar"><i></i></div><span class="tpCount"></span></div>
      <div class="tpSteps">${popSteps.map(([key, name], n) => `<span class="tpStep" data-step="${n}"><b>${n + 1}</b>${name}</span>`).join("")}</div>
      <div class="tpSubmit" hidden>
        <ol class="tpSubSteps"></ol>
        <div class="tpFail" hidden>
          <div class="tpFailText"></div>
          <div class="tpAsk">
            <b>I couldn't finish it.</b> If you finished it in TEMS yourself (Submit pressed there), I'll mark it submitted - done and dusted - so we move on to the next one.
            <div class="tpAskBtns">
              <button class="btn btnGreen" data-sub="done">${icon("check", "sm")}<span>Yes, I did it - mark done</span></button>
              <button class="btn btnGhost" data-sub="later">${icon("clock", "sm")}<span>Not yet</span></button>
            </div>
          </div>
        </div>
        <div class="tpForm">
          <div class="tpFormHead"><span class="sectionT">Result</span><span class="tpSaved hint"></span></div>
          <div class="formGrid">
            <div class="field"><label class="label">Total grids</label><input class="input tfTotal" inputmode="numeric"></div>
            <div class="field"><label class="label">Grids attempted</label><div class="tfAtt"></div></div>
            <div class="field"><label class="label">Grids skipped</label><div class="tfSkip"></div></div>
          </div>
          <div class="field"><label class="label">Status</label><div class="tfStatus"></div></div>
          <div class="field"><label class="label">Remarks (optional)</label><textarea class="textarea tfRemarks" rows="2" placeholder="Saved when you click away"></textarea></div>
        </div>
      </div>
      <div class="tpMeta"><span class="tpTimer"></span><span class="tpWorking"></span></div>
      <div class="tpClose" hidden><button class="btn btnPrimary lg" data-sub="close">${icon("check", "sm")}<span>Close</span></button></div>
      <div class="tpActions">
        <button class="btn btnGreen lg" data-end="submit" title="Suspend, take the TEMS picture, reopen and play, then press Submit on the results page">${icon("check", "sm")}<span>Submit</span></button>
        <button class="btn btnGhost lg" data-end="suspend" title="Suspend in TEMS (OK to its summary)">${icon("pause", "sm")}<span>Suspend</span></button>
        <button class="btn btnDanger lg" data-end="discard" title="Discard the run in TEMS (asks first)">${icon("x", "sm")}<span>Discard</span></button>
      </div>
    </div>`;
  const pill = document.createElement("button");
  pill.className = "testPill hidden";
  pill.title = "Show the test";
  const $p = (sel) => el.querySelector(sel);
  let current = "", currentKey = "", hiddenFor = "", tick = null, since = 0, timerOff = false;
  // Stationary / mobility: the TEMS map, live, in a box (drag / pinch / zoom it), zoomed to the
  // grid. Made when the test starts, gone (no more polling) once it isn't running.
  let liveMap = null;
  function mapFor(stage) {
    const want = !!popScreens[stage]?.map;
    if (want && !liveMap) {
      liveMap = temsMapCard({ compact: true, fitTo: "grid", pan: { key: "kaamTemsPopPan", on: false } });
      $p(".tpMapSlot").append(liveMap.el);
    } else if (!want && liveMap) {
      liveMap.destroy(); liveMap.el.remove(); liveMap = null;
    }
    $p(".tpMapSlot").hidden = !want;
    el.classList.toggle("withMap", want);
  }

  // ----- Submit: the result form (same fields as End Ticket, saved on the WO as you change it) -----
  const settings = store.settings || {};
  const defaults = settings.defaults || { total: "1", attempted: "1", skipped: "0", status: "PASSED" };
  const opposite = (v) => (v === "1" ? "0" : "1");
  const att = seg([{ value: "0", label: "0" }, { value: "1", label: "1" }], defaults.attempted, (v) => { skip.set(opposite(v)); saveForm(); });
  const skip = seg([{ value: "0", label: "0" }, { value: "1", label: "1" }], defaults.skipped, (v) => { att.set(opposite(v)); saveForm(); });
  const statusSeg = seg((settings.statusOptions || ["PASSED", "SKIPPED", "FAILED"]).map((s) => ({ value: s, label: s })), defaults.status, (v) => {
    const skipped = v === "SKIPPED";  // SKIPPED = attempted 0, skipped 1; PASSED / FAILED = 1, 0
    att.set(skipped ? "0" : "1"); skip.set(skipped ? "1" : "0"); saveForm();
  }, "statusSeg");
  $p(".tfAtt").replaceWith(att.el); $p(".tfSkip").replaceWith(skip.el); $p(".tfStatus").replaceWith(statusSeg.el);
  const total = $p(".tfTotal"), remarks = $p(".tfRemarks");
  total.addEventListener("change", saveForm);    // when you leave the box
  remarks.addEventListener("change", saveForm);
  total.addEventListener("keydown", (e) => { if (e.key === "Enter") total.blur(); });
  let formWo = "", formRecord = null, saving = Promise.resolve();
  const savedHint = (text, color = "var(--faint)") => { $p(".tpSaved").textContent = text; $p(".tpSaved").style.color = color; };
  const formFields = () => ({ total: total.value.trim(), attempted: att.get(), skipped: skip.get(), status: statusSeg.get(), remarks: remarks.value.trim() });
  async function loadForm(forWo) {
    if (forWo === formWo) return;
    formWo = forWo; formRecord = null;
    total.value = defaults.total; att.set(defaults.attempted); skip.set(defaults.skipped); statusSeg.set(defaults.status); remarks.value = "";
    savedHint(forWo ? "Loading…" : "");
    if (!forWo) return;
    try {
      const record = await api(`/api/records/${enc(forWo)}`);
      if (formWo !== forWo) return;
      formRecord = record;
      const rf = record.reportFields || {};
      if (record.totalGrids != null || record.status) {
        total.value = rf.total ?? total.value; att.set(rf.attempted ?? att.get()); skip.set(rf.skipped ?? skip.get());
        statusSeg.set(rf.status || statusSeg.get()); remarks.value = record.remarks || "";
        savedHint("Loaded from Records - saves as you change it");
      } else {
        savedHint("Saves as you change it");
        saveForm();  // nothing saved yet: the defaults shown go on the WO
      }
    } catch (error) {
      if (formWo === forWo) savedHint(/not in records/i.test(error.message) ? "Not in Records - can't save here" : "Couldn't load the WO", "var(--amber)");
    }
  }
  function saveForm() {
    const forWo = formWo;
    if (!forWo || !formRecord) { if (forWo) savedHint("Not in Records - can't save here", "var(--amber)"); return; }
    savedHint("Saving…", "var(--muted)");
    const want = formFields();
    saving = saving.then(async () => {
      try {
        formRecord = await api(`/api/records/${enc(forWo)}`, { method: "PATCH", body: { ...want, source: "Live Testing" } });
        if (formWo === forWo) savedHint(`Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "var(--green)");
        refreshState();
      } catch (error) { savedHint("Not saved", "var(--red)"); toast(error.message, "bad"); }
    });
  }

  // ----- Submit: its steps, where it got stuck, the question, Close -----
  const stepIcon = { done: "check", working: "refresh", failed: "x" };
  function paintSubmit(run, ending) {
    const order = run?.order || ["suspend", "picture", "reopen", "play", "results", "submit"];
    const labels = run?.labels || { suspend: "Suspend in TEMS", picture: "Picture of the WO", reopen: "Opened again", play: "Play pressed",
      results: "Results showing Submit / Discard / Suspend", submit: "Submit pressed in TEMS" };
    const steps = run?.steps || (ending ? { suspend: "working" } : {});
    $p(".tpSubSteps").innerHTML = order.map((key) => {
      const state = steps[key] || "";
      const note = key === "picture" && run?.picture && state === "done" ? `<span class="hint mono">${esc(run.picture.split(/[\\/]/).pop())}</span>` : "";
      return `<li class="${state || "todo"}"><span class="sIco">${stepIcon[state] ? icon(stepIcon[state], "sm") : ""}</span><span>${esc(labels[key] || key)}</span>${note}</li>`;
    }).join("");
    const failed = run?.state === "failed";
    $p(".tpFail").hidden = !failed;
    if (failed) {
      const done = order.filter((k) => steps[k] === "done").map((k) => labels[k]);
      $p(".tpFailText").innerHTML = `${icon("alert", "sm")}<div><b>Stuck at: ${esc(labels[run.failedAt] || run.failedAt || "?")}</b><br>${esc(run.error || "")}` +
        `<br><span class="hint">Done before it: ${done.length ? esc(done.join(" · ")) : "nothing"}${run.picture ? "" : " · no picture saved"}</span></div>`;
    }
    $p(".tpClose").hidden = run?.state !== "done";
  }
  el.addEventListener("click", (e) => {
    const button = e.target.closest("[data-sub]");
    if (!button || button.disabled) return;
    const forWo = el.dataset.submitWo || "";
    if (button.dataset.sub === "done") { button.disabled = true; saving.then(() => api_.onSubmitDone(forWo)).finally(() => (button.disabled = false)); }
    if (button.dataset.sub === "close") saving.then(() => api_.onSubmitClose(forWo));
    if (button.dataset.sub === "later") $p(".tpHide").click();  // finish it in TEMS; the pill brings this back
  });

  const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function startedAt(key) {
    // when we first saw this stage of this WO (kept across reloads, so the timer doesn't restart)
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(sinceKey) || "{}"); } catch { /* storage blocked */ }
    if (!seen[key]) { seen = { [key]: Date.now() }; try { localStorage.setItem(sinceKey, JSON.stringify(seen)); } catch { /* storage blocked */ } }
    return seen[key];
  }
  function paintTimer() {
    const text = current === "complete" ? `Finished ${fmt(Date.now() - since)} ago` : `Running ${fmt(Date.now() - since)}`;
    $p(".tpTimer").textContent = since && !timerOff ? text : "";
    pill.querySelector(".pTime") && (pill.querySelector(".pTime").textContent = since ? fmt(Date.now() - since) : "");
  }

  const api_ = {
    el, pill, onAction: () => {}, onSubmitDone: () => {}, onSubmitClose: () => {},
    show(stage, status = {}, { pageWo = "", ending = "" } = {}) {
      const run = stage === "submit" ? status.submit : null;
      const submitState = stage !== "submit" ? "" : !run ? "running" : run.state === "done" ? (run.byHand ? "byHand" : "done") : run.state;
      const screenName = { running: "submit", done: "submitDone", byHand: "submitByHand", failed: "submitFailed" }[submitState] || stage;
      const screen = popScreens[screenName];
      mapFor(stage);
      $p(".tpSubmit").hidden = stage !== "submit";
      el.classList.toggle("submitting", stage === "submit");
      if (stage === "submit") {
        const forWo = run?.wo || status.wo || pageWo || "";
        el.dataset.submitWo = forWo;
        loadForm(forWo);
        paintSubmit(run, ending);
      } else {
        $p(".tpClose").hidden = true;
      }
      if (!screen) {  // idle / ready / closed / unknown: nothing running
        current = ""; el.classList.add("hidden"); pill.classList.add("hidden"); clearInterval(tick); tick = null;
        return;
      }
      const temsWo = (run && run.wo) || status.wo || pageWo || "";
      const key = `${temsWo}|${stage}`;
      if (stage !== current) { since = startedAt(key); $p(".tpWorking").textContent = ""; }
      if (submitState && submitState !== "running") $p(".tpWorking").textContent = "";
      current = stage;
      currentKey = `${key}|${submitState}`;  // Submit done / stuck shows the pop-up again even if hidden
      timerOff = !!submitState && submitState !== "running";
      el.dataset.stage = stage;
      $p(".tpTitle").textContent = screen.title;
      $p(".tpText").textContent = stage === "failed" && status.error ? `${screen.text} (${status.error})` : screen.text;
      $p(".tpWo").textContent = temsWo ? temsWo + (pageWo && temsWo !== pageWo && status.wo ? "  (picked here: " + pageWo + ")" : "") : "";
      const count = screen.count ? status[screen.count] : null;
      const hasCount = count && count.total;
      $p(".tpProgress").hidden = !hasCount;
      if (hasCount) {
        $p(".tpBar i").style.width = `${Math.min(100, Math.round((count.done / count.total) * 100))}%`;
        $p(".tpCount").textContent = `${count.done} of ${count.total} ${screen.unit}${count.total === 1 ? "" : "s"}`;
      }
      el.querySelectorAll(".tpStep").forEach((s) => {
        const n = +s.dataset.step;
        s.classList.toggle("done", screen.step > n || (!!screen.done && n <= screen.step));  // a real true / false:
        s.classList.toggle("now", n === screen.step && !screen.done);                       // undefined would flip it
      });
      el.classList.toggle("busy", !!screen.busy);
      el.classList.toggle("move", !!screen.move);
      el.classList.toggle("finished", !!screen.done);
      el.classList.toggle("bad", !!screen.bad);
      $p(".tpActions").hidden = stage !== "complete";
      el.querySelectorAll("[data-end]").forEach((b) => { b.disabled = !!ending; b.classList.toggle("working", b.dataset.end === ending); });
      if (!ending && stage === "complete") $p(".tpWorking").textContent = "";
      pill.innerHTML = `<span class="pDot"></span><span>${esc(screen.title)}</span><span class="pTime mono"></span>`;
      pill.dataset.stage = stage;
      const hidden = hiddenFor === currentKey;
      el.classList.toggle("hidden", hidden);
      pill.classList.toggle("hidden", !hidden);
      paintTimer();
      if (!tick) tick = setInterval(paintTimer, 1000);
    },
    working(line) { if (current) $p(".tpWorking").textContent = String(line).replace(/^\[[^\]]+\]\s*/, ""); },
    destroy() { clearInterval(tick); liveMap?.destroy(); el.remove(); pill.remove(); },
  };
  $p(".tpHide").addEventListener("click", () => {
    hiddenFor = currentKey;
    el.classList.add("hidden"); pill.classList.remove("hidden");
  });
  pill.addEventListener("click", () => { hiddenFor = ""; el.classList.remove("hidden"); pill.classList.add("hidden"); });
  el.addEventListener("click", (e) => {
    const button = e.target.closest("[data-end]");
    if (button && !button.disabled) api_.onAction(button.dataset.end);
  });
  return api_;
}
