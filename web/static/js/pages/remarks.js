// Remarks: the skip causes, driver texts and test remarks from the skip / force-test sheet. Click a
// remark to copy it, ready to paste (End Ticket's Remarks, TEMS, the ticket).
import { $, copyText, esc, flash, icon } from "../core.js";
import { remarkGroups } from "../remarksData.js";

export default {
  title: "Remarks",
  sub: "Skip causes and remarks - click one to copy it",
  render(root) {
    const all = [];  // every copyable text, by index
    root.innerHTML = `
      <div class="stack remarksPage">
        <div class="card">
          <div class="cardBody row wrap" style="gap:10px">
            <div class="searchBox" style="flex:1;min-width:220px">${icon("search", "sm")}
              <input class="input rmSearch" placeholder="Filter: alarm, rural, 4G, road…" spellcheck="false"></div>
            <span class="note">Click a remark to copy it. Wording is exact - paste it as it is.</span>
          </div>
        </div>
        ${remarkGroups.map((group) => `
          <div class="card rmGroup" data-group="${group.key}">
            <div class="cardHead"><h2>${esc(group.title)}</h2><span class="hint">${esc(group.note)}</span></div>
            <div class="cardBody rmList">
              ${group.items.map((item) => `
                <div class="rmItem" data-search="${esc([item.scenario, item.cause, item.action, ...item.texts, item.note].filter(Boolean).join(" ").toLowerCase())}">
                  <div class="rmScenario">${esc(item.scenario)}</div>
                  ${item.action ? `<div class="rmAction">${icon("info", "sm")}<span>${esc(item.action)}</span></div>` : ""}
                  <div class="rmMeta">
                    ${item.cause ? `<span class="rmLabel">Skip Cause</span><button class="rmChip" data-copy="${all.push(item.cause) - 1}" title="Copy the skip cause">${esc(item.cause)}${icon("copy", "sm")}</button>` : ""}
                    ${item.revisit !== undefined ? `<span class="badge ${item.revisit ? "bAmber" : "bRed"}">Revisit: ${item.revisit ? "Yes" : "No"}</span>` : ""}
                  </div>
                  <div class="rmTexts">
                    ${item.texts.map((text) => `<button class="rmText" data-copy="${all.push(text) - 1}" title="Click to copy">
                      <span>${esc(text)}</span>${icon("copy", "sm")}</button>`).join("")}
                  </div>
                  ${item.note ? `<div class="rmNote">${icon("alert", "sm")}<span>${esc(item.note)}</span></div>` : ""}
                </div>`).join("")}
            </div>
          </div>`).join("")}
        <div class="empty rmNone hidden">${icon("search")}<p>Nothing matches.</p></div>
      </div>`;

    root.addEventListener("click", async (e) => {
      const button = e.target.closest("[data-copy]");
      if (!button) return;
      const ok = await copyText(all[Number(button.dataset.copy)]);
      flash(button, ok, ok ? "Copied" : "Copy failed");
    });
    $(".rmSearch", root).addEventListener("input", (e) => {
      const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      root.querySelectorAll(".rmGroup").forEach((group) => {
        let inGroup = 0;
        group.querySelectorAll(".rmItem").forEach((item) => {
          const match = words.every((w) => item.dataset.search.includes(w));
          item.classList.toggle("hidden", !match);
          inGroup += match;
        });
        group.classList.toggle("hidden", !inGroup);
        shown += inGroup;
      });
      $(".rmNone", root).classList.toggle("hidden", shown > 0);
    });
  },
};
