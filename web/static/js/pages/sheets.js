// Sheets: today's WOs as two tables, each copied in a form Excel pastes as cells.
//   Teams Data       - WOs still to do (everything not done yet): WO, Grid Key, Long, Lat
//   Coordinator Data - WOs done today: WO only
// Same WOs as today's map; driven ones in the order you drove them, the rest in Start's To start
// order (the order picked on Maps).
import { $, api, copyText, esc, flash, icon, onDataChange, toast } from "../core.js";

const tables = [
  {
    key: "teams", title: "Teams Data", note: "WOs still to do today",
    columns: [["wo", "WO"], ["gridKey", "Grid Key"], ["long", "Long"], ["lat", "Lat"]],
    pick: (r) => r.category !== "completed", empty: "Nothing left to do today.", header: true,
  },
  {
    key: "coord", title: "Coordinator Data", note: "WOs done today",
    columns: [["wo", "WO"]],
    pick: (r) => r.category === "completed", empty: "Nothing done yet today.", header: false,
  },
];
const statusText = { completed: "Done", doing: "Driving", pending: "To do", missed: "Missed" };
const textColumns = new Set(["wo", "gridKey"]);  // kept as text in Excel (grid keys would get rounded)

export default {
  title: "Sheets",
  sub: "Today's WOs as tables - copy straight into Excel",
  render(root) {
    let rows = [];
    root.innerHTML = `<div class="stack">${tables.map((t) => `
      <div class="card sheetCard" data-t="${t.key}">
        <div class="cardHead"><h2>${t.title}</h2><span class="hint count"></span>
          <div class="actions">
            <label class="note sheetHead"><input type="checkbox" class="withHeader"> Include headings</label>
            <button class="btn btnPrimary copyAll" disabled>${icon("copy", "sm")}<span>Copy for Excel</span></button>
          </div></div>
        <div class="cardBody"><div class="sheetWrap"><div class="empty">Loading…</div></div></div>
      </div>`).join("")}
      <div class="note">Paste into Excel with Ctrl+V - each value lands in its own cell.</div></div>`;

    const card = (t) => $(`.sheetCard[data-t="${t.key}"]`, root);
    const rowsFor = (t) => rows.filter(t.pick);

    for (const t of tables) {
      const box = $(".withHeader", card(t)), store = `kaamSheetsHeader_${t.key}`;
      try { const saved = localStorage.getItem(store); box.checked = saved === null ? t.header : saved === "1"; } catch { box.checked = t.header; }
      box.addEventListener("change", () => { try { localStorage.setItem(store, box.checked ? "1" : "0"); } catch { /* storage blocked */ } });
      $(".copyAll", card(t)).addEventListener("click", (event) => copyTable(t, event.currentTarget));
    }

    function paint() {
      for (const t of tables) {
        const list = rowsFor(t), el = card(t);
        $(".count", el).textContent = `${t.note} · ${list.length}`;
        $(".copyAll", el).disabled = !list.length;
        $(".sheetWrap", el).innerHTML = list.length
          ? `<table class="sheet"><thead><tr><th>#</th>${t.columns.map(([, label]) => `<th>${label}</th>`).join("")}<th></th></tr></thead>
              <tbody>${list.map((r, n) => `<tr><td class="num">${n + 1}</td>
                ${t.columns.map(([key]) => `<td class="${key === "wo" ? "" : "mono"}">${esc(r[key] || "")}</td>`).join("")}
                <td><span class="note">${esc(statusText[r.category] || "")}</span></td></tr>`).join("")}</tbody></table>`
          : `<div class="empty">${icon("sheet")}<p>${rows.length ? t.empty : "No WOs for today yet. Import today's plan on Start Ticket."}</p></div>`;
      }
    }

    // Excel reads tab-separated text as cells; the HTML copy keeps WO / Grid Key as text.
    async function copyTable(t, button) {
      const list = rowsFor(t), header = $(".withHeader", card(t)).checked;
      const keys = t.columns.map(([key]) => key);
      const table = (header ? [t.columns.map(([, label]) => label)] : []).concat(list.map((r) => keys.map((key) => r[key] || "")));
      const tsv = table.map((cells) => cells.map((c) => String(c).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\r\n");
      const cell = (c, col) => (textColumns.has(keys[col]) ? `<td style="mso-number-format:'\\@'">${esc(c)}</td>` : `<td>${esc(c)}</td>`);
      const html = `<table>${table.map((cells, n) => `<tr>${cells.map((c, col) => (header && n === 0 ? `<th>${esc(c)}</th>` : cell(c, col))).join("")}</tr>`).join("")}</table>`;
      if (!(await copyText(tsv, html))) { flash(button, false, "Copy failed"); return; }
      flash(button, true, `Copied ${list.length}`);
    }

    async function load() {
      try { rows = (await api("/api/sheets")).rows || []; }
      catch (error) { toast(error.message, "bad"); rows = []; }
      paint();
    }

    load();
    return onDataChange(load);  // live: new imports, starts, ends, Maps order
  },
};
