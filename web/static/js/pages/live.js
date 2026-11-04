// Live Testing: drive the test phones (TMO 1 / TMO 2) from the app, between Start and End Ticket.
// Built to sit in half the screen (the other half is the phones in Vysor).
//   WO        - the ticket being tested; every speed test is saved on it (record.speedTests)
//   Desk      - phones unlocked + Service Mode / Speedtest, Vysor windows, Chrome left half, phones right
//   Desk sets up everything (skips what's done); per phone: the network it's on (NR / LTE / no service),
//   Full test and Speed test (both save the speed and network on the WO), Airplane (toggle only)
//   Test all  - full test on each phone in turn (never two speed tests at once)
//   TEMS map  - the TEMS Paragon map (grid, route, track, car), live
import { $, api, copyText, enc, esc, icon, toast } from "../core.js";
import { jobPanel, woBox } from "../components.js";
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
    let info = null, record = null, wo = "", busy = false, timer = null;
    let pending = [];  // phones being tested right now, in test order
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
              <button class="btn btnPurple lg" data-action="temsPlay" title="TEMS Paragon: opens Control and presses play (only when TEMS shows it ready, green) - then stays on TEMS">${icon("play")}<span>Start ticket</span></button>
              <button class="btn btnGreen lg" data-action="fullTestAll" title="Each phone in turn, NR phones first then LTE: Service Mode + Speedtest, airplane toggle, speed test, wait for the result - then the next phone">${icon("gauge")}<span>Test all, one by one</span></button>
            </div>
            </div>
            <div class="liveHint allHint"></div>
            <div class="msg"></div>
          </div>
        </div>
        <div class="liveMain">
          <div class="mapSlot"></div>
          <div class="liveGrid phones"></div>
        </div>
        <div class="jobSlot"></div>
        <div class="card liveWo">
          <div class="cardHead"><h2>Results on this WO</h2><span class="hint woHint"></span></div>
          <div class="cardBody stack">
            <div class="kv info"></div>
            <div class="techSummary"></div>
            <div class="tests"></div>
          </div>
        </div>
      </div>`;
    const q = (s) => $(s, root);
    const job = jobPanel(); q(".jobSlot").replaceWith(job.el);
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
        if (next !== wo && !busy) { clearLast(); job.hide(); }
        wo = next; record = rec; paintWo(); paintPhones();
      },
      onEnter: () => {},
    });
    q(".woSlot").replaceWith(box.el);
    // ---------- WO and its saved tests ----------
    // Once TEMS has made the WO's result file (GridSummary), its speed results are done with: not shown.
    const finished = () => Boolean(record?.resultReady);
    const tests = () => (finished() ? [] : record?.speedTests || []);
    function best(filter) {
      let top = null;
      for (const t of tests()) if (filter(t) && mbps(t) > mbps(top)) top = t;
      return top;
    }

    function paintWo() {
      const r = record;
      q(".woHint").textContent = wo ? `${tests().length} test${tests().length === 1 ? "" : "s"}` : "";
      q(".info").innerHTML = r ? [
        ["Ticket", r.ticketId || "—"], ["Cluster", r.cluster || "—"], ["Grid key", r.gridKey || "—"], ["Location", r.location || "—"],
      ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v" title="${esc(v)}">${esc(v)}</div></div>`).join("") : "";
      if (!wo) {
        q(".techSummary").innerHTML = "";
        q(".tests").innerHTML = `<div class="callout info">${icon("info", "sm")}<div>Pick the WO you're driving to save the speed results on it. Tests still run without one.</div></div>`;
        return;
      }
      if (finished()) {
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
        if (!driving || busy) return;
        toast(`${wo}: result file is in. Switched to ${driving.wo}.`, "ok", 6000);
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
        : info && !phones.length ? callout("No phones set up. Add PHONES=TMO 1=<serial>,TMO 2=<serial> in .env.", "warn")
        : info?.unconfigured?.length ? callout(`Connected but not in PHONES: ${info.unconfigured.join(", ")}`, "info") : "";
      q(".phones").innerHTML = phones.map((p) => {
        // Latest result: this browser's last one, or the newest saved on the WO (e.g. run from another tab).
        const savedLatest = tests().filter((t) => t.phone === p.name).slice(-1)[0];
        const mine = last[p.name] && "wo" in last[p.name] && last[p.name].wo === wo && !finished() ? last[p.name] : null;
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
        const off = !p.connected || busy ? "disabled" : "";
        const button = (action, cls, ico, label, title) =>
          `<button class="btn ${cls}" data-action="${action}" data-phone="${esc(p.name)}" title="${esc(title)}" ${off}>${icon(ico, "sm")}<span>${label}</span></button>`;
        return `
          <div class="card phoneCard">
            <div class="cardBody">
              <div class="phoneHead">
                <h2>${icon("phone", "sm")}${esc(p.name)}</h2>
                <span class="chipSlot" data-phone="${esc(p.name)}">${p.connected ? netChip(live[p.name] || p.network, false) : ""}</span>
                <span class="spacer"></span>
                <span class="hint mono">${esc(p.serial)}</span>
              </div>
              ${p.connected ? `<div class="sigSlot" data-phone="${esc(p.name)}">${sigHtml(live[p.name] || p.network, true)}</div>` : `<div class="netLine">Plug it in over USB</div>`}
              <div class="stateDots">${dots}</div>
              <div class="speedRow">
                ${pending.includes(p.name)
                  ? `<div class="speedBig dim">--.--</div>
                     <div class="speedMeta"><span class="spinner"></span> <b>${pending[0] === p.name ? "Testing now…" : "Waiting its turn…"}</b><br>waiting for the result</div>`
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
      for (const b of root.querySelectorAll("button[data-action='desk'], button[data-action='fullTestAll']")) b.disabled = busy;
    }

    // Live signal: only the chip and the strip change (buttons stay put while you press them).
    async function pollSignal() {
      if (!document.hidden) {
        try {
          live = (await api("/api/live/signal")).phones || {};
          for (const [name, net] of Object.entries(live)) {
            const chip = root.querySelector(`.chipSlot[data-phone="${CSS.escape(name)}"]`);
            const slot = root.querySelector(`.sigSlot[data-phone="${CSS.escape(name)}"]`);
            if (chip) chip.innerHTML = netChip(net, false);
            if (slot) slot.innerHTML = sigHtml(net, true);
          }
        } catch { /* server busy: try again */ }
      }
      sigTimer = setTimeout(pollSignal, 700);
    }

    // Start ticket: TEMS's Control page, press play there (the server checks TEMS is ready first).
    let temsBusy = false;
    async function startTems(button) {
      if (temsBusy) return;
      temsBusy = true; button.disabled = true;
      try {
        const { job: started } = await api("/api/tems", { body: { action: "play" } });
        const done = await job.run(started);
        const text = done.state === "done" ? (done.result?.summary || done.result?.error) : done.error || "Stopped.";
        toast(text, done.state === "done" && done.result?.ok !== false ? "ok" : "bad", 8000);
      } catch (error) { toast(error.message, "bad", 8000); }
      finally { temsBusy = false; button.disabled = busy; }
    }

    async function loadPhones() {
      try { info = await api("/api/live/phones"); } catch (error) { info = { phones: [], adbError: error.message }; }
      paintPhones();
    }

    // Each step of a test as a short pop-up (airplane on / off, Service Mode opening / opened,
    // split set, speed test started / result...). Only the newest few stay on screen.
    function stepToast(text) {
      const clean = String(text).replace(/^\[([^\]]+)\]\s*/, "$1: ");
      const kind = /warning|failed|no speed|no internet|didn't|not found/i.test(clean) ? "warn"
        : /ready|done:|back online|split set|opened|reusing/i.test(clean) ? "ok" : "info";
      toast(clean.replace(/^WARNING:\s*/i, ""), kind, 4500);
      const steps = [...document.querySelectorAll("#toasts .toast")];
      steps.slice(0, Math.max(0, steps.length - 3)).forEach((node) => node.remove());
    }

    async function run(action, phone) {
      if (busy) return;
      busy = true;
      // Phones about to be tested show --.-- until their new result is in (never last time's speed).
      pending = action === "fullTestAll" ? (info?.phones || []).filter((p) => p.connected).map((p) => p.name)
        : action === "fullTest" || action === "speedtest" ? [phone] : [];  // desk / airplane: no speed to wait for
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
            paintPhones();
          }
          if (results.length > seen) {  // a phone finished: show it now (Test all keeps going)
            results.slice(seen).forEach((x) => saveLast({ ...x, wo: runWo }));
            pending = pending.filter((name) => !results.some((r) => r.phone === name));
            seen = results.length;
            paintPhones(); reloadRecord();
          }
        });
        if (done.state === "done") toast(typeof done.result === "string" ? done.result : done.result?.summary || "Done.", "ok", 8000);
        else toast(done.state === "stopped" ? "Stopped." : done.error || "Failed.", "bad", 8000);
      } catch (error) {
        toast(error.message, "bad", 8000);
      } finally {
        busy = false; pending = [];
        loadPhones(); reloadRecord();
      }
    }

    root.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-action]");
      if (button && !button.disabled && button.dataset.action === "temsPlay") startTems(button);
      else if (button && !button.disabled) run(button.dataset.action, button.dataset.phone || "");
    });

    paintWo();
    loadPhones();
    if (params.get("wo")) box.set(params.get("wo"));
    else pickDefaultWo();
    timer = setInterval(() => { if (!busy && !document.hidden) { loadPhones(); reloadRecord(); } }, 8000);
    pollSignal();
    return () => { clearInterval(timer); clearTimeout(sigTimer); temsMap.destroy(); };
  },
};

function callout(text, kind) {
  return `<div class="callout ${kind}">${icon(kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>`;
}
