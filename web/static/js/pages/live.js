// Live Testing: drive the test phones (TMO 1 / TMO 2) from the app, between Start and End Ticket.
// Built to sit in half the screen (the other half is the phones in Vysor).
//   WO        - the ticket being tested; every speed test is saved on it (record.speedTests)
//   Desk      - phones unlocked + Service Mode / Speedtest, Vysor windows, Chrome left half, phones right
//   Desk sets up everything (skips what's done); per phone: the network it's on (NR / LTE / no service),
//   Full test and Speed test (both save the speed and network on the WO), Airplane (toggle only)
//   Test all  - full test on each phone in turn (never two speed tests at once)
import { $, api, enc, esc, icon, toast } from "../core.js";
import { jobPanel, woBox } from "../components.js";

const lastKey = "kaamLiveResults";  // last result per phone, also without a WO

function loadLast() {
  try { return JSON.parse(localStorage.getItem(lastKey) || "{}"); } catch { return {}; }
}
function saveLast(result) {
  const all = loadLast();
  all[result.phone] = { ...result, at: new Date().toISOString() };
  try { localStorage.setItem(lastKey, JSON.stringify(all)); } catch { /* storage blocked */ }
}
const mbps = (t) => parseFloat(t?.download) || 0;
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");

// "NR" / "LTE" / "No service" as a coloured chip, with the band.
function techOf(network) { return network?.tech || "Unknown"; }
function netChip(network) {
  const tech = techOf(network);
  const cls = tech === "NR" ? "nr" : tech === "LTE" ? "lte" : tech === "No service" ? "none" : "unknown";
  const band = network?.band || "";
  return `<span class="netChip ${cls}">${esc(tech)}${band ? ` <span style="font-weight:650">${esc(band)}</span>` : ""}</span>`;
}
function netLine(network) {
  if (!network) return "";
  return [network.pci && `PCI ${network.pci}`, network.rsrp && `RSRP ${network.rsrp}`,
    network.sinr && `SINR ${network.sinr}`].filter(Boolean).join(" · ");
}
function speed(t) {
  if (!t) return `<div class="speedBig dim">—</div>`;
  if (t.error || !t.download) return `<div class="speedBig dim">No speed</div>`;
  return `<div class="speedBig">${esc(t.download)}<small>Mbps</small></div>`;
}

export default {
  title: "Live Testing",
  sub: "Speed tests for the WO you're driving",
  render(root, params) {
    let info = null, record = null, wo = "", busy = false, timer = null;
    let pending = [];  // phones being tested right now, in test order
    root.innerHTML = `
      <div class="stack">
        <div class="card liveTop">
          <div class="cardBody stack">
            <div class="woSlot"></div>
            <div class="pair">
              <button class="btn btnPrimary lg" data-action="desk" title="Unlocks the phones, sets up Service Mode + Speedtest and Vysor where missing (skips what is already done), Chrome on the left half, TMO 1 and TMO 2 a quarter each on the right">${icon("desk")}<span>Set up desk</span></button>
              <button class="btn btnGreen lg" data-action="fullTestAll" title="Each phone in turn, NR phones first then LTE: Service Mode + Speedtest, airplane toggle, speed test, wait for the result - then the next phone">${icon("gauge")}<span>Test all, one by one</span></button>
            </div>
            <div class="liveHint allHint"></div>
            <div class="msg"></div>
          </div>
        </div>
        <div class="liveGrid phones"></div>
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

    const box = woBox({
      label: "WO under test",
      placeholder: "The WO you're driving (picked automatically)",
      picker: {
        label: "Today's open", empty: "No open tickets today.",
        load: async () => (await api("/api/end/open")).map((r) => ({
          wo: r.wo, title: r.wo, sub: `${r.ticketId || "no ticket ID"}${r.startType === "local" ? " · local" : ""}`,
        })),
      },
      onResolve: (newWo, rec) => { wo = rec ? newWo : ""; record = rec; paintWo(); paintPhones(); },
      onEnter: () => {},
    });
    q(".woSlot").replaceWith(box.el);

    // ---------- WO and its saved tests ----------
    const tests = () => record?.speedTests || [];
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
      // Best speed on NR and on LTE, and which phone got it.
      q(".techSummary").innerHTML = ["NR", "LTE"].map((tech) => {
        const t = best((x) => techOf(x.network) === tech);
        return `<div class="techBox">
            <div class="sectionT" style="margin:0 0 4px">Best on ${tech}</div>
            ${speed(t)}
            <div class="speedMeta">${t ? `<b>${esc(t.phone)}</b> · ping ${esc(t.ping || "?")} ms · ${time(t.at)}<br>${esc(netLine(t.network) || "")}` : `No ${tech} test yet`}</div>
          </div>`;
      }).join("");
      const list = tests(), bestPerPhone = {};
      for (const t of list) if (!t.error && (!bestPerPhone[t.phone] || mbps(t) > mbps(bestPerPhone[t.phone]))) bestPerPhone[t.phone] = t;
      q(".tests").innerHTML = list.length ? `
          <div class="sheetWrap"><table class="sheet"><thead><tr><th>Phone</th><th>Network</th><th>Download</th><th>Ping</th><th>Signal</th><th>Time</th><th></th></tr></thead>
            <tbody>${list.slice().reverse().map((t) => `<tr>
              <td>${esc(t.phone)}${bestPerPhone[t.phone] === t ? ` <span class="badge bGreen">Best</span>` : ""}</td>
              <td>${netChip(t.network)}</td>
              <td class="mono">${t.error ? `<span class="note bad" title="${esc(t.error)}">no speed</span>` : `${esc(t.download || "?")} Mbps`}</td>
              <td class="mono">${t.ping ? `${esc(t.ping)} ms${t.pingLoaded ? ` / ${esc(t.pingLoaded)}` : ""}` : "—"}</td>
              <td class="mono">${esc(netLine(t.network) || "—")}</td><td>${time(t.at)}</td>
              <td><button class="iconBtn sm remove" data-id="${esc(t.resultId || "")}" title="Remove this test">${icon("x", "sm")}</button></td>
            </tr>`).join("")}</tbody></table></div>`
        : `<div class="note">No speed tests on this WO yet.</div>`;
    }

    async function reloadRecord() {
      if (!wo) return;
      try { record = await api(`/api/records/${enc(wo)}`); }
      catch (error) {
        if (!/not in records/i.test(error.message)) return;  // server busy / restarting: keep what we show
        // The WO was deleted or renamed meanwhile: drop it and pick today's open one again.
        toast(`${wo} isn't in Records any more.`, "warn");
        wo = ""; record = null; box.set("");
        pickDefaultWo();
      }
      paintWo(); paintPhones();
    }

    // The WO being driven: today's open ticket started last.
    function pickDefaultWo() {
      api("/api/end/open").then((open) => {
        if (box.get() || !open.length) return;
        box.set(open.slice().sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))[0].wo);
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
        const r = [last[p.name], savedLatest].filter(Boolean)
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
                ${p.connected ? netChip(p.network) : ""}
                <span class="spacer"></span>
                <span class="hint mono">${esc(p.serial)}</span>
              </div>
              <div class="netLine">${esc(netLine(p.network) || (p.connected ? "" : "Plug it in over USB"))}</div>
              <div class="stateDots">${dots}</div>
              <div class="speedRow">
                ${pending.includes(p.name)
                  ? `<div class="speedBig dim">--.--<small>Mbps</small></div>
                     <div class="speedMeta"><span class="spinner"></span> <b>${pending[0] === p.name ? "Testing now…" : "Waiting its turn…"}</b><br>waiting for the result</div>`
                  : `${speed(r)}
                <div class="speedMeta">${r ? `${r.error ? esc(r.error) : `ping <b>${esc(r.ping || "?")}</b> ms`} · ${time(r.at)}${r.network ? ` · ${esc(techOf(r.network))}` : ""}` : "No test yet"}
                  ${top ? `<br>Best on WO <b>${esc(top.download)} Mbps</b> (${esc(techOf(top.network))})` : ""}</div>`}
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

    async function loadPhones() {
      try { info = await api("/api/live/phones"); } catch (error) { info = { phones: [], adbError: error.message }; }
      paintPhones();
    }

    async function run(action, phone) {
      if (busy) return;
      busy = true;
      // Phones about to be tested show --.-- until their new result is in (never last time's speed).
      pending = action === "fullTestAll" ? (info?.phones || []).filter((p) => p.connected).map((p) => p.name)
        : action === "fullTest" || action === "speedtest" ? [phone] : [];  // desk / airplane: no speed to wait for
      paintPhones();
      let seen = 0;
      try {
        const { job: started } = await api("/api/live/run", { body: { action, phone, wo } });
        let ordered = false;
        const done = await job.run(started, (j) => {
          const results = j.data?.results || [];
          if (!ordered && j.data?.order) {  // Test all: the server picked the order (NR phones first, then LTE)
            ordered = true;
            pending = j.data.order.filter((name) => pending.includes(name));
            paintPhones();
          }
          if (results.length > seen) {  // a phone finished: show it now (Test all keeps going)
            results.slice(seen).forEach(saveLast);
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
      if (button && !button.disabled) run(button.dataset.action, button.dataset.phone || "");
    });

    paintWo();
    loadPhones();
    if (params.get("wo")) box.set(params.get("wo"));
    else pickDefaultWo();
    timer = setInterval(() => { if (!busy && !document.hidden) { loadPhones(); reloadRecord(); } }, 8000);
    return () => clearInterval(timer);
  },
};

function callout(text, kind) {
  return `<div class="callout ${kind}">${icon(kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>`;
}
