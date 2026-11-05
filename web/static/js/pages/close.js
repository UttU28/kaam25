// Close: finish the day's cloud ticket (PASSED, SKIPPED or FAILED) in TechInsights, step by step.
import { $, api, enc, esc, icon, niceTime, onDataChange, refreshState, toast } from "../core.js";
import { jobPanel, statusBadge, woBox } from "../components.js";

export default {
  title: "Close Ticket",
  sub: "Finish the day's cloud ticket in TechInsights",
  render(root, params) {
    let record = null, busy = false;
    root.innerHTML = `
      <div class="grid colsMainSide">
        <div class="stack">
          <div class="card">
            <div class="cardHead"><h2>Ticket</h2><span class="hint">Cloud tickets: PASSED, SKIPPED or FAILED</span></div>
            <div class="cardBody stack">
              <div class="woSlot"></div>
              <div class="kv woInfo"></div>
              <div class="divider"></div>
              <div class="sectionT">Close steps</div>
              <div class="steps"></div>
              <div class="msg"></div>
              <div class="row"><button class="btn btnAmber lg block go">${icon("lock")}<span>Close TKT</span></button></div>
              <div class="jobSlot"></div>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="cardHead"><h2>Ready to close</h2><span class="hint readyCount"></span></div>
            <div class="list listScroll ready" style="padding:6px 0"></div>
          </div>
        </div>
      </div>`;
    const q = (s) => $(s, root);
    const job = jobPanel(); q(".jobSlot").replaceWith(job.el);
    const msg = (text, kind = "info") => { q(".msg").innerHTML = text ? `<div class="callout ${kind}">${icon(kind === "ok" ? "check" : kind === "info" ? "info" : "alert", "sm")}<div>${esc(text)}</div></div>` : ""; };

    let shownKey = "";
    const box = woBox({
      placeholder: "Pick from Ready to close, or paste its WO / Ticket ID",
      compact: true, preview: true,
      picker: {
        label: "Ready to close", empty: "Nothing ready to close.",
        load: async () => (await api("/api/close/ready")).map((r) => ({ wo: r.wo, title: r.cluster || r.wo, sub: r.ticketId || "no ticket ID" })),
      },
      onResolve: (wo, rec) => {
        record = rec;
        const key = (wo || "").replace(/\s+/g, "").toUpperCase();
        if (key !== shownKey && !busy) { shownKey = key; job.hide(); }  // a different WO: no old job log
        paint(wo);
      },
      onEnter: () => {},
    });
    q(".woSlot").replaceWith(box.el);

    function paint(wo, keepMessage = false) {
      const r = record || {};
      const close = r.close || { steps: [], canClose: false };
      q(".woInfo").innerHTML = record ? [
        ["Ticket", r.ticketId || "—"], ["Status", statusBadge(r.status) || "—"], ["EQ3", r.eq3 || "—"], ["EQ6", r.eq6 || "—"],
      ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${k === "Status" ? v : esc(v)}</div></div>`).join("") : "";
      const steps = close.steps.length ? close.steps : [
        { name: "Step 1", what: "Start Driving task → Completed (Save, then OK)" },
        { name: "Step 2", what: "Check Out: Route Completion Status → Completed, task → Completed" },
        { name: "Step 3", what: "Upload Collection: EQ3, EQ6, GridSummary CSV, grid counts → Completed, Save, OK" }];
      q(".steps").innerHTML = steps.map((s, n) => `
        <div class="step ${s.doneAt ? "done" : ""}">
          <div class="ball">${s.doneAt ? icon("check", "sm") : n + 1}</div>
          <div><div class="sName">${esc(s.name)}</div><div class="sWhat">${esc(s.what)}</div></div>
          <div class="note ${s.doneAt ? "ok" : ""}" style="padding-top:6px">${s.doneAt ? `done ${esc(niceTime(s.doneAt))}` : "pending"}</div>
        </div>`).join("") + (r.closedAt ? `<div class="callout ok" style="margin-top:8px">${icon("lock", "sm")}<div>Closed ${esc(niceTime(r.closedAt))}</div></div>` : "");
      q(".go").classList.toggle("hidden", !(close.canClose && !busy));
      if (!busy && !keepMessage) {
        if (!wo) msg("Pick a ticket from Ready to close, or type its WO.", "info");
        else msg(close.reason || "Not in Records - run Start / End Ticket for it first.",
          close.canClose ? "info" : record ? "warn" : "bad");
      }
    }

    async function loadReady() {
      let list = [];
      try { list = await api("/api/close/ready"); } catch (e) { toast(e.message, "bad"); }
      box.setPickerCount(list.length);
      q(".readyCount").textContent = list.length ? `${list.length}` : "";
      q(".ready").innerHTML = list.length ? list.map((r) => `
          <div class="listItem" data-wo="${esc(r.wo)}">
            <div style="min-width:0;flex:1"><div class="t1">${esc(r.cluster || r.wo)}</div><div class="t2">${esc(r.ticketId || "no ticket ID")} · ${esc(niceTime(r.endedAt || r.startedAt))}</div></div>
            <span style="color:var(--faint)">${icon("arrow", "sm")}</span>
          </div>`).join("")
        : `<div class="empty">${icon("lock")}<p>Nothing ready to close.</p></div>`;
    }
    q(".ready").addEventListener("click", (e) => {
      const item = e.target.closest(".listItem");
      if (item && !busy) box.set(item.dataset.wo);
    });

    q(".go").addEventListener("click", async () => {
      if (!record || busy) return;
      busy = true; q(".go").classList.add("hidden");
      msg("Closing: opening TechInsights in your Chrome… (refreshes between steps)", "info");
      try {
        const { job: started } = await api("/api/close/run", { body: { wo: record.wo } });
        const done = await job.run(started);
        if (done.state === "done") { msg(done.result, "ok"); toast("Close steps done.", "ok"); }
        else msg(done.state === "stopped" ? "Stopped by you." : done.error, "bad");
      } catch (error) { msg(error.message, "bad"); }
      finally {
        busy = false;
        try { record = await api(`/api/records/${enc(record.wo)}`); } catch { /* keep */ }
        paint(record?.wo || box.get(), true); loadReady(); refreshState();
      }
    });

    paint("");
    loadReady();
    if (params.get("wo")) box.set(params.get("wo"));
    else {
      // Nothing carried over: pick the ready-to-close WO started first (we close in the order we started).
      api("/api/close/ready").then((ready) => {
        if (box.get() || !ready.length) return;
        box.set(ready.slice().sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""))[0].wo);
      }).catch(() => {});
    }
    setTimeout(() => box.focus(), 50);
    // ----- live: list, count and the picked ticket's steps when data changes -----
    const offData = onDataChange(async () => {
      box.refreshPicker();
      loadReady();
      if (busy || !record) return;
      try { record = await api(`/api/records/${enc(record.wo)}`); } catch { return; }
      paint(record.wo, true);
    });
    return offData;
  },
};
