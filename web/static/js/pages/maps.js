// Maps: one day's WOs on a dark map, coloured live from Records.
// Driven stops are joined in the order you drove them (start time, else end time); what's left
// to drive today follows the shortest road route (travelling-salesman style), or your own order
// if you dragged the list - that order is saved per day.
import { $, api, clock, copyWithFlash, esc, icon, onDataChange, toast } from "../core.js";
import { progressBadge, statusBadge } from "../components.js";

const CATS = [
  { key: "completed", label: "Completed", color: "var(--green)", on: true },
  { key: "doing", label: "Doing (in progress)", pastLabel: "Started, not ended", color: "var(--amber)", on: true },
  { key: "pending", label: "To do today", color: "var(--accent)", on: true, today: true },
  { key: "missed", label: "Not driven (on that day's list)", color: "var(--red)", on: true, past: true },
];
const DRIVEN = new Set(["completed", "doing"]), PLANNED = new Set(["pending"]);
const FILTER_KEY = "kaamMapFilter", FROM_ME_KEY = "kaamMapFromMe", OPEN_KEY = "kaamMapFilterOpen";
const MAX_ACC = 1500;     // metres; worse is an internet-address guess, not a position
const EXACT_MAX = 15;     // up to this many stops the order is provably the shortest
const OSRM = "https://router.project-osrm.org";

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.append(css);
      const script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = () => resolve(window.L);
      script.onerror = () => { leafletPromise = null; reject(new Error("Couldn't load the map library. Check your internet connection and open Maps again.")); };
      document.head.append(script);
    });
  }
  return leafletPromise;
}

// ---------- shortest path ----------
function haversineM(a, b) {
  const r = (x) => x * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

// Exact open path from node 0 through every node (Held-Karp). D is an n×n cost matrix.
function heldKarp(D) {
  const n = D.length, m = n - 1, full = 1 << m;
  const dp = new Float64Array(full * m).fill(Infinity);
  const parent = new Int8Array(full * m).fill(-1);
  for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = D[0][j + 1];
  for (let mask = 1; mask < full; mask++) {
    for (let j = 0; j < m; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * m + j];
      if (cur === Infinity) continue;
      for (let k = 0; k < m; k++) {
        if (mask & (1 << k)) continue;
        const next = mask | (1 << k), value = cur + D[j + 1][k + 1];
        if (value < dp[next * m + k]) { dp[next * m + k] = value; parent[next * m + k] = j; }
      }
    }
  }
  let end = 0;
  for (let j = 1; j < m; j++) if (dp[(full - 1) * m + j] < dp[(full - 1) * m + end]) end = j;
  const path = [];
  for (let mask = full - 1, j = end; j !== -1;) {
    path.push(j + 1);
    const p = parent[mask * m + j];
    mask ^= 1 << j; j = p;
  }
  path.push(0);
  return path.reverse();
}

// Near-shortest open path from node 0 for big lists: nearest neighbour, then 2-opt and move-one passes.
function heuristic(D) {
  const n = D.length, cost = (p) => p.slice(1).reduce((t, v, i) => t + D[p[i]][v], 0);
  const left = new Set([...Array(n).keys()].slice(1));
  let path = [0];
  while (left.size) {
    const last = path[path.length - 1];
    let best = null;
    for (const v of left) if (best === null || D[last][v] < D[last][best]) best = v;
    path.push(best); left.delete(best);
  }
  let bestCost = cost(path), improved = true, rounds = 0;
  while (improved && rounds++ < 50) {
    improved = false;
    for (let i = 1; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const trial = [...path.slice(0, i), ...path.slice(i, k + 1).reverse(), ...path.slice(k + 1)];
      const c = cost(trial);
      if (c < bestCost - 1e-6) { path = trial; bestCost = c; improved = true; }
    }
    for (let i = 1; i < n; i++) for (let k = 1; k < n; k++) {
      if (i === k) continue;
      const trial = path.slice(); const [v] = trial.splice(i, 1); trial.splice(k, 0, v);
      const c = cost(trial);
      if (c < bestCost - 1e-6) { path = trial; bestCost = c; improved = true; }
    }
  }
  return path;
}

// Order of `nodes` for the shortest open route. fixedStart: node 0 must come first (your location).
export function solveOrder(D, fixedStart) {
  let M = D;
  if (!fixedStart) {  // free start: a dummy node 0 that costs nothing to leave from anywhere
    M = [new Array(D.length + 1).fill(0), ...D.map((row) => [0, ...row])];
  }
  const exact = M.length - 1 <= EXACT_MAX;
  let path = M.length <= 2 ? [...Array(M.length).keys()] : exact ? heldKarp(M) : heuristic(M);
  if (!fixedStart) path = path.slice(1).map((v) => v - 1);
  return { order: path, exact };
}

async function getJSON(url, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const response = await fetch(url, { signal: ctl.signal });
    return await response.json();
  } finally { clearTimeout(timer); }
}

// ---------- page ----------
const dayName = (iso, long) => new Date(iso + "T12:00:00").toLocaleDateString([], long
  ? { weekday: "long", month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric" });
const miles = (m) => (m / 1609.34).toFixed(1);
const duration = (s) => { const t = Math.round(s / 60), h = Math.floor(t / 60), m = t % 60; return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`; };

export default {
  title: "Maps",
  sub: "Your WOs on the map, live from Records · shortest way through what's left to drive",
  async render(root) {
    root.innerHTML = `
      <div class="mapsWrap">
        <aside class="card mapsSide">
          <div class="msHead">
            <div class="msTop">
              <label class="msDateWrap">${icon("calendar", "sm")}<select id="mapDate" class="msDate" title="Pick a day"></select>${icon("chevron", "sm")}</label>
              <button class="btn btnGhost sm" id="mapRefresh" title="Reload from Records">${icon("refresh", "sm")}</button>
            </div>
            <div class="msStats" id="msStats"></div>
            <div class="routeSum" id="routeSum"><span class="spinner"></span> Loading…</div>
          </div>
          <div class="stopList" id="stopList"></div>
        </aside>
        <div class="mapsMap card" id="mapsMap"><div class="empty"><span class="spinner"></span><p>Loading the map…</p></div></div>
      </div>`;
    const L = await loadLeaflet();
    const mapEl = $("#mapsMap", root);
    mapEl.innerHTML = "";
    return mountMap(L, root, mapEl);
  },
};

function mountMap(L, root, mapEl) {
  let filter = Object.fromEntries(CATS.map((c) => [c.key, c.on]));
  try { Object.assign(filter, JSON.parse(lsGet(FILTER_KEY) || "{}")); } catch { /* ignore */ }
  let fromMe = lsGet(FROM_ME_KEY) === "1";
  let day = null, data = null, points = [], markers = {};
  let me = null, meMarker = null, meCircle = null, startPoint = null;
  let tsp = { signature: null, keys: [], exact: true, road: true, busy: false };
  const legs = { driven: { key: null, layers: [], info: null }, plan: { key: null, layers: [], info: null } };
  const routeCache = new Map();
  let firstFit = true, pickMode = false, alive = true, dragging = null, renderPending = false;
  const isToday = () => Boolean(data?.isToday);

  const map = L.map(mapEl, { zoomControl: true });
  // Dark = Esri streets with a night filter (no API key needed, full street detail).
  const dark = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Tiles &copy; Esri", className: "darkTiles",
  }).addTo(map);
  const streets = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri" });
  const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri" });
  map.setView([30.3, -94.1], 8);

  // ----- filter (top right) -----
  const Filter = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create("div", "mapFilter");
      const open = lsGet(OPEN_KEY) !== "0";
      box.innerHTML = `
        <button class="mfHead" type="button">${icon("filter", "sm")}<span>Show</span><span class="mfHidden"></span>${icon("chevron", "sm")}</button>
        <div class="mfBody ${open ? "" : "hidden"}">
          ${CATS.map((c) => `<label class="mfRow" data-row="${c.key}"><input type="checkbox" data-cat="${c.key}" ${filter[c.key] ? "checked" : ""}>
            <span class="mfDot" style="background:${c.color}"></span><span class="mfLabel" data-label="${c.key}">${c.label}</span><b data-count="${c.key}">0</b></label>`).join("")}
          <div class="mfSep" data-today></div>
          <label class="mfRow" data-today><input type="checkbox" data-fromme ${fromMe ? "checked" : ""}>
            <span class="mfDot me"></span><span class="mfLabel">Start plan from my location<small data-mestate></small></span></label>
        </div>`;
      box.querySelector(".mfHead").onclick = () => {
        const body = box.querySelector(".mfBody");
        body.classList.toggle("hidden");
        lsSet(OPEN_KEY, body.classList.contains("hidden") ? "0" : "1");
      };
      box.querySelectorAll("[data-cat]").forEach((input) => input.onchange = () => {
        filter[input.dataset.cat] = input.checked;
        lsSet(FILTER_KEY, JSON.stringify(filter));
        paint();
      });
      box.querySelector("[data-fromme]").onchange = (e) => {
        fromMe = e.target.checked;
        lsSet(FROM_ME_KEY, fromMe ? "1" : "0");
        paint();
      };
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      return box;
    },
  });
  const filterBox = new Filter({ position: "topright" }).addTo(map).getContainer();
  L.control.layers({ Dark: dark, Streets: streets, Satellite: satellite }, null, { position: "topright" }).addTo(map);

  // ----- tools (top left) -----
  const Tools = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create("div", "mapTools");
      box.innerHTML = `<button type="button" data-fit>Fit all</button><button type="button" data-pick>📍 Set my spot</button>`;
      box.querySelector("[data-fit]").onclick = () => fitVisible();
      const pick = box.querySelector("[data-pick]");
      pick.onclick = () => {
        pickMode = !pickMode;
        pick.classList.toggle("on", pickMode);
        pick.textContent = pickMode ? "Click the map…" : "📍 Set my spot";
        mapEl.style.cursor = pickMode ? "crosshair" : "";
      };
      map.on("click", (e) => {
        if (!pickMode) return;
        pick.onclick();
        setMe(e.latlng.lat, e.latlng.lng, 0, true);
      });
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  new Tools({ position: "topleft" }).addTo(map);

  // ----- your location -----
  const meIcon = L.divIcon({ className: "", html: '<div class="meDot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  function setMe(lat, lon, acc, manual) {
    me = { lat, lon, acc, manual };
    const moved = !startPoint || haversineM(startPoint, me) > 1000;
    if (manual || !startPoint || (moved && Date.now() - (tsp.at || 0) > 60000)) startPoint = { lat, lon };
    if (!meMarker) {
      meMarker = L.marker([lat, lon], { icon: meIcon, zIndexOffset: 1000 }).addTo(map).bindPopup("");
      meCircle = L.circle([lat, lon], { radius: Math.max(acc, 1), color: "#e3a63d", weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng([lat, lon]);
      meCircle.setLatLng([lat, lon]).setRadius(Math.max(acc, 1));
    }
    meMarker.setPopupContent(manual ? "Your spot (set by hand)" : `You (GPS ±${Math.round(acc)} m)`);
    showMeState();
    paint();
  }
  function showMeState(text) {
    const el = filterBox.querySelector("[data-mestate]");
    if (el) el.textContent = text || (me ? (me.manual ? " · your spot" : " · GPS on") : " · waiting… or use 📍 Set my spot");
  }
  showMeState();
  let watchId = null;
  if ("geolocation" in navigator) {
    watchId = navigator.geolocation.watchPosition((p) => {
      if (p.coords.accuracy > MAX_ACC) {
        if (!me) showMeState(` · only a rough guess (±${(p.coords.accuracy / 1609).toFixed(0)} mi) - use 📍 Set my spot`);
        return;
      }
      if (me && me.manual) return;
      setMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy, false);
    }, (err) => { if (!me) showMeState(err.code === 1 ? " · location blocked - use 📍 Set my spot" : undefined); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  // ----- what goes where -----
  const catOf = (key) => CATS.find((c) => c.key === key);
  const catLabel = (p) => { const c = catOf(p.category); return !isToday() && c.pastLabel ? c.pastLabel : c.label; };
  const applies = (c) => (c.today ? isToday() : c.past ? !isToday() : true);
  const visiblePoints = () => points.filter((p) => filter[p.category] && applies(catOf(p.category)));
  const drivenStart = (p) => p.drivenAt || "";

  // Where the plan starts: the WO you're on now (drawn - it's stop 1), else you (if asked, drawn),
  // else where you finished your last WO (only used to plan from, not drawn), else anywhere.
  function planStart(done, doing) {
    if (!isToday()) return null;
    const now = doing[doing.length - 1];
    if (now) return { lat: now.lat, lon: now.lon, key: now.key, doing: true };
    if (fromMe && startPoint) return { lat: startPoint.lat, lon: startPoint.lon, me: true };
    const last = done[done.length - 1];
    return last ? { lat: last.lat, lon: last.lon, key: last.key, hidden: true } : null;
  }
  const planSignature = (planned, start) =>
    planned.map((p) => p.key).sort().join("|") + (start ? `@${start.lat.toFixed(5)},${start.lon.toFixed(5)}` : "");

  // Today: route = doing (by start time) then what's left to drive; completed are pins only, at the
  // end of the list in the order you drove them. A past day: everything driven, by start time.
  function sequence() {
    const vis = visiblePoints();
    const byTime = (a, b) => drivenStart(a).localeCompare(drivenStart(b));
    const done = vis.filter((p) => isToday() ? p.category === "completed" : DRIVEN.has(p.category)).sort(byTime);
    const doing = isToday() ? vis.filter((p) => p.category === "doing").sort(byTime) : [];
    const plannedAll = isToday() ? vis.filter((p) => PLANNED.has(p.category)) : [];
    const missed = vis.filter((p) => p.category === "missed");
    const start = planStart(done, doing);
    const saved = data?.savedOrder;
    let planned = plannedAll, mode = "waiting";
    const tspRank = new Map(tsp.keys.map((k, i) => [k, i]));
    if (saved?.length) {
      // your order; stops added since (imported / moved to today) go in where they add the least distance
      const rank = new Map(saved.map((k, i) => [k, i]));
      planned = plannedAll.filter((p) => rank.has(p.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key));
      plannedAll.filter((p) => !rank.has(p.key)).forEach((p) => {
        const from = (i) => i ? planned[i - 1] : start;
        let best = planned.length, cost = planned.length || start ? haversineM(from(planned.length), p) : 0;
        planned.forEach((q, i) => {
          const f = from(i);
          const c = f ? haversineM(f, p) + haversineM(p, q) - haversineM(f, q) : haversineM(p, q);
          if (c < cost) { best = i; cost = c; }
        });
        planned.splice(best, 0, p);
      });
      mode = "custom";
    } else if (tsp.signature === planSignature(plannedAll, start)) {
      planned = plannedAll.slice().sort((a, b) => tspRank.get(a.key) - tspRank.get(b.key));
      mode = "shortest";
    }
    const route = [...doing, ...planned];
    return { done, doing, planned, plannedAll, missed, start, mode, route, numbered: [...route, ...done] };
  }

  // ----- markers -----
  function markerClass(p) {
    if (p.category !== "completed") return p.category;
    return "completed " + ({ PASSED: "pass", FAILED: "fail", SKIPPED: "skip" }[p.status] || "");
  }
  const markerTag = (p) => p.category === "completed" ? ({ PASSED: "✓", FAILED: "✗", SKIPPED: "!" }[p.status] || "✓") : p.category === "missed" ? "–" : "";
  const badgeHtml = (p, n) => { const tag = markerTag(p); return `<span class="mk ${markerClass(p)}">${n || ""}${tag ? `<i>${tag}</i>` : ""}</span>`; };
  const navUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=driving`;
  function when(p) {
    const s = p.startedAt ? clock(p.startedAt) : "", e = p.endedAt ? clock(p.endedAt) : "";
    if (s && e) return `${s} → ${e}`;
    if (s) return `started ${s}`;
    if (e) return `ended ${e}`;
    return p.woDate ? `WO date ${dayName(p.woDate)}` : "";
  }
  function popupHtml(p, n) {
    const c = catOf(p.category), w = encodeURIComponent(p.wo);
    const action = p.category === "doing" && isToday() ? `<a class="btn btnGreen sm" href="#/end?wo=${w}">End ${icon("arrow", "sm")}</a>`
      : p.readyToClose ? `<a class="btn btnAmber sm" href="#/close?wo=${w}">${icon("lock", "sm")}Close</a>`
      : p.progress === "notStarted" ? `<a class="btn btnPrimary sm" href="#/start?wo=${w}">Start</a>` : "";
    const t = when(p);
    return `<div class="mapPop">
      <div class="mpWo">${n ? `<span class="mpNo">${n}</span>` : ""}${esc(p.wo)}</div>
      <div class="mpTags"><span class="mpCat" style="--c:${c.color}">${esc(catLabel(p))}</span>${progressBadge(p)}${statusBadge(p.status)}</div>
      <div class="mpMeta">${esc(p.ticketId || "no ticket yet")}${t ? " · " + esc(t) : ""}</div>
      <div class="mpMeta mono">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</div>
      <div class="mpActions">${action}
        <a class="btn btnGhost sm" href="#/records?wo=${w}">Open</a>
        <a class="btn btnGhost sm" href="${navUrl(p)}" target="_blank" rel="noopener">${icon("navigate", "sm")}Navigate</a>
        <button class="btn btnGhost sm" data-copywo="${esc(p.wo)}">${icon("copy", "sm")}WO</button></div>
    </div>`;
  }
  mapEl.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-copywo]");
    if (btn) copyWithFlash(btn, btn.dataset.copywo);
  });

  function fitVisible() {
    const pts = visiblePoints().map((p) => [p.lat, p.lon]);
    if (isToday() && fromMe && startPoint) pts.push([startPoint.lat, startPoint.lon]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 14 });
  }

  // ----- route line (what is left to drive) -----
  function drawLeg(name, latlngs, style) {
    const leg = legs[name];
    const key = latlngs.map(([a, b]) => `${b.toFixed(5)},${a.toFixed(5)}`).join(";");
    if (leg.key === key) return;
    leg.key = key; leg.info = null;
    leg.layers.forEach((l) => map.removeLayer(l)); leg.layers = [];
    if (latlngs.length < 2) { paintSummary(); return; }
    const put = (coords, dashed) => {
      leg.layers.forEach((l) => map.removeLayer(l));
      leg.layers = [
        L.polyline(coords, { color: style.glow, weight: 10, opacity: .16, interactive: false }).addTo(map),
        L.polyline(coords, { color: style.color, weight: 3.5, opacity: .95, dashArray: dashed ? "6 8" : style.dash || null, interactive: false }).addTo(map),
      ];
      leg.layers.forEach((l) => l.bringToBack());
    };
    put(latlngs, true);
    if (!routeCache.has(key)) {
      routeCache.set(key, getJSON(`${OSRM}/route/v1/driving/${key}?overview=full&geometries=geojson`)
        .then((d) => (d.code === "Ok" ? d.routes[0] : null)).catch(() => null));
    }
    routeCache.get(key).then((r) => {
      if (!alive || leg.key !== key) return;
      if (!r) { routeCache.delete(key); paintSummary(); return; }
      put(r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), false);
      leg.info = { distance: r.distance, duration: r.duration };
      paintSummary();
    });
  }

  async function planShortest(plannedAll, start) {
    const signature = planSignature(plannedAll, start);
    if (tsp.busy === signature) return;
    tsp.busy = signature;
    const nodes = start ? [start, ...plannedAll] : plannedAll.slice();
    let D, road = true;
    if (nodes.length > 1) {
      try {
        const d = await getJSON(`${OSRM}/table/v1/driving/${nodes.map((p) => `${p.lon},${p.lat}`).join(";")}?annotations=distance`);
        if (d.code !== "Ok") throw new Error(d.code);
        D = d.distances.map((row, i) => row.map((v, j) => v ?? haversineM(nodes[i], nodes[j]) * 1.4));
      } catch {
        road = false;
        D = nodes.map((a) => nodes.map((b) => haversineM(a, b)));
      }
    } else D = [[0]];
    if (!alive || tsp.busy !== signature) return;
    const { order, exact } = solveOrder(D, Boolean(start));
    const keys = order.map((i) => nodes[i]).filter((p) => !start || p !== start).map((p) => p.key);
    tsp = { signature, keys, exact, road, busy: false, at: Date.now() };
    paint();
  }

  // ----- paint everything -----
  let seq = null;
  function paint() {
    if (!alive || !data) return;
    seq = sequence();
    const { done, doing, planned, plannedAll, missed, start, mode, route, numbered } = seq;
    if (!data.savedOrder?.length && plannedAll.length && mode !== "shortest") planShortest(plannedAll, start);

    // filter rows: counts, and only the groups that make sense for this day
    CATS.forEach((c) => {
      filterBox.querySelector(`[data-row="${c.key}"]`).classList.toggle("hidden", !applies(c));
      filterBox.querySelector(`[data-count="${c.key}"]`).textContent = points.filter((p) => p.category === c.key).length;
      filterBox.querySelector(`[data-label="${c.key}"]`).textContent = !isToday() && c.pastLabel ? c.pastLabel : c.label;
    });
    filterBox.querySelectorAll("[data-today]").forEach((el) => el.classList.toggle("hidden", !isToday()));
    const shown = visiblePoints().length, total = points.filter((p) => applies(catOf(p.category))).length;
    filterBox.querySelector(".mfHidden").textContent = total - shown ? `${total - shown} hidden` : "";

    // markers: route stops numbered first, then completed in the order you drove them
    const numbers = new Map(numbered.map((p, i) => [p.key, i + 1]));
    const keep = new Set(visiblePoints().map((p) => p.key));
    Object.keys(markers).forEach((k) => { if (!keep.has(k)) { map.removeLayer(markers[k]); delete markers[k]; } });
    visiblePoints().forEach((p) => {
      const n = numbers.get(p.key) || "";
      if (!markers[p.key]) markers[p.key] = L.marker([p.lat, p.lon]).addTo(map).bindPopup("", { maxWidth: 340 });
      const m = markers[p.key];
      m.setLatLng([p.lat, p.lon]);
      m.setIcon(L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14], html: badgeHtml(p, n) }));
      m.setZIndexOffset(p.category === "doing" ? 600 : PLANNED.has(p.category) ? 300 : 0);
      m.getPopup().setContent(popupHtml(p, n));
    });
    if (firstFit && shown) { firstFit = false; fitVisible(); }

    // the line: only what's still to drive (doing, then the plan); completed stay as pins
    const planPts = (start?.me ? [start] : []).concat(route).map((p) => [p.lat, p.lon]);
    const planReady = mode !== "waiting" || planned.length < 2;
    drawLeg("plan", planReady ? planPts : [], { color: "#7aa2ff", glow: "#5b8cff" });

    paintStats();
    paintSummary();
    shareSequence(planned, planReady);
    if (dragging) renderPending = true; else renderList();
  }

  // Start Ticket lists today's WOs in this order (its list and the WO dropdown).
  let sharedSequence = null;
  function shareSequence(planned, ready) {
    if (!isToday() || !filter.pending || !ready) return;
    const keys = planned.map((p) => p.key), text = `${day}|${keys.join(",")}`;
    if (text === sharedSequence) return;
    sharedSequence = text;
    api("/api/map/sequence", { body: { date: day, keys } }).catch(() => { sharedSequence = null; });
  }

  function paintStats() {
    const count = (k) => points.filter((p) => p.category === k).length;
    const passed = points.filter((p) => p.category === "completed" && p.status === "PASSED").length;
    const failed = points.filter((p) => p.category === "completed" && p.status === "FAILED").length;
    const chips = [
      ["var(--green)", `${count("completed")} completed`, passed || failed ? `${passed} passed · ${failed} failed` : ""],
      ["var(--amber)", `${count("doing")} ${isToday() ? "doing" : "not ended"}`, ""],
      isToday() ? ["var(--accent)", `${count("pending")} to do`, ""] : ["var(--red)", `${count("missed")} not driven`, ""],
    ];
    $("#msStats", root).innerHTML = chips.map(([c, t, sub]) => `<div class="msChip" style="--c:${c}"><b>${t}</b>${sub ? `<small>${sub}</small>` : ""}</div>`).join("");
  }

  function paintSummary() {
    if (!seq) return;
    const { done, route, mode, start } = seq;
    const p = legs.plan.info;
    const lines = [];
    if (isToday() && route.length) {
      const how = mode === "custom" ? "your order" : mode === "shortest" ? (tsp.exact ? "shortest order" : "near-shortest order") : "working out the shortest order…";
      const from = start?.doing ? "from the WO you're on" : start?.me ? "from your location" : start ? "from where you finished last" : "";
      lines.push(`<div class="rsLine"><span class="rsDot" style="background:#7aa2ff"></span><div>
        <b>To drive${p ? ` · ${miles(p.distance)} mi · ${duration(p.duration)}` : ""}</b><small>${route.length} stop${route.length > 1 ? "s" : ""} · ${how}${from ? " · " + from : ""}${mode === "shortest" && !tsp.road ? " · straight-line (road service unavailable)" : ""}</small></div></div>`);
    }
    if (done.length) {
      lines.push(`<div class="rsLine"><span class="rsDot" style="background:#3ddc97"></span><div>
        <b>${done.length} ${isToday() ? "completed" : "driven"}</b><small>pins only, numbered in the order you drove them</small></div></div>`);
    }
    if (!lines.length) lines.push(`<div class="rsEmpty">${points.length ? "Nothing shown - turn a group on in Show (top right of the map)." : `Nothing on ${esc(dayName(day))}.`}</div>`);
    $("#routeSum", root).innerHTML = lines.join("");
  }

  // ----- the list on the left -----
  function rowHtml(p, n, draggable) {
    const c = catOf(p.category), t = when(p);
    return `<div class="stopRow ${draggable ? "drag" : ""}" data-key="${esc(p.key)}" ${draggable ? 'draggable="true"' : ""}>
      ${draggable ? `<span class="grip" title="Drag to change the order">⋮⋮</span>` : ""}
      ${badgeHtml(p, n)}
      <div class="srBody">
        <div class="srWo">${esc(p.wo)}</div>
        <div class="srMeta"><span style="color:${c.color}">${esc(catLabel(p))}</span>${p.status ? ` · ${esc(p.status)}` : ""}${p.ticketId ? ` · <span class="mono">${esc(p.ticketId)}</span>` : ""}</div>
        ${t ? `<div class="srTime">${esc(t)}</div>` : ""}
      </div>
      <a class="srNav" href="${navUrl(p)}" target="_blank" rel="noopener" title="Navigate in Google Maps">${icon("navigate", "sm")}</a>
    </div>`;
  }
  function renderList() {
    renderPending = false;
    const list = $("#stopList", root);
    if (!list || !seq) return;
    const { done, doing, planned, missed, start, mode, route } = seq;
    let html = "";
    if (isToday() && route.length) {
      html += `<div class="slHead"><span>To drive</span>
        <small>${mode === "custom" ? `<span class="slTag">Your order · saved</span>` : mode === "shortest" ? "shortest order" : "planning…"}</small>
        ${mode === "custom" ? `<button class="btn btnGhost sm slReset" data-reset>${icon("route", "sm")}Shortest</button>` : ""}</div>`;
      if (start?.me) html += `<div class="stopRow start"><span class="mk me">▶</span><div class="srBody"><div class="srWo">Your location</div><div class="srMeta">start of the plan</div></div></div>`;
      html += doing.map((p, i) => rowHtml(p, i + 1, false)).join("");
      html += planned.map((p, i) => rowHtml(p, doing.length + i + 1, true)).join("");
      if (planned.length > 1) html += `<div class="slHint">Drag ⋮⋮ to change the order - it's saved for ${esc(dayName(day))}.</div>`;
    }
    if (done.length) {
      html += `<div class="slHead done"><span>${isToday() ? "Completed" : "Driven"}</span><small>in the order you drove them · not on the route</small></div>`;
      html += done.map((p, i) => rowHtml(p, route.length + i + 1, false)).join("");
    }
    if (missed.length) {
      html += `<div class="slHead"><span>Not driven</span><small>on that day's list, never started</small></div>`;
      html += missed.map((p) => rowHtml(p, "", false)).join("");
    }
    if (data.noLocation?.length) html += `<div class="srNote">No coordinates: ${data.noLocation.map(esc).join(", ")}</div>`;
    if (!html) html = `<div class="empty">${icon("map")}<p>${points.length ? "Everything is hidden by the filter." : `No WOs on ${esc(dayName(day))}.`}</p></div>`;
    list.innerHTML = html;
    list.querySelector("[data-reset]")?.addEventListener("click", () => saveOrder(null));
  }

  // click a row: show it on the map
  $("#stopList", root).addEventListener("click", (e) => {
    if (e.target.closest(".srNav, [data-reset]")) return;
    const row = e.target.closest(".stopRow[data-key]");
    const m = row && markers[row.dataset.key];
    if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 13)); m.openPopup(); }
  });

  // ----- drag to reorder the plan -----
  const list = $("#stopList", root);
  const clearDrop = () => list.querySelectorAll(".dropBefore, .dropAfter").forEach((r) => r.classList.remove("dropBefore", "dropAfter"));
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".stopRow.drag");
    if (!row) return;
    dragging = row.dataset.key;
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging);
  });
  list.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const row = e.target.closest(".stopRow.drag");
    if (!row) return;
    e.preventDefault();
    clearDrop();
    if (row.dataset.key === dragging) return;
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? "dropBefore" : "dropAfter");
  });
  list.addEventListener("drop", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const row = list.querySelector(".dropBefore, .dropAfter");
    const from = dragging;
    if (row && seq) {
      const keys = seq.planned.map((p) => p.key).filter((k) => k !== from);
      let at = keys.indexOf(row.dataset.key);
      if (row.classList.contains("dropAfter")) at += 1;
      keys.splice(at, 0, from);
      // keep the stops the filter hides, after the ones you see
      const hidden = (data.savedOrder || tsp.keys).filter((k) => !keys.includes(k));
      saveOrder([...keys, ...hidden]);
    }
  });
  list.addEventListener("dragend", () => {
    list.querySelectorAll(".dragging").forEach((r) => r.classList.remove("dragging"));
    clearDrop();
    dragging = null;
    if (renderPending) renderList();
  });

  async function saveOrder(keys) {
    const before = data.savedOrder;
    data.savedOrder = keys;
    paint();
    try {
      await api("/api/map/order", { body: { date: day, keys: keys || [] } });
      toast(keys ? "Order saved." : "Back to the shortest order.", "ok", 2200);
    } catch (error) {
      data.savedOrder = before;
      paint();
      toast(error.message, "bad");
    }
  }

  // ----- days -----
  const dateSelect = $("#mapDate", root);
  function fillDates() {
    const dates = data.dates.includes(data.date) ? data.dates : [data.date, ...data.dates];
    dateSelect.innerHTML = dates.map((d) => `<option value="${d}" ${d === data.date ? "selected" : ""}>${
      isTodayDate(d) ? `Today · ${dayName(d)}` : dayName(d, true)}</option>`).join("");
  }
  const isTodayDate = (d) => { const n = new Date(); return d === `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; };
  dateSelect.addEventListener("change", () => switchDay(dateSelect.value));
  $("#mapRefresh", root).addEventListener("click", () => load());

  function switchDay(d) {
    day = d;
    Object.values(markers).forEach((m) => map.removeLayer(m)); markers = {};
    Object.values(legs).forEach((leg) => { leg.layers.forEach((l) => map.removeLayer(l)); leg.layers = []; leg.key = null; leg.info = null; });
    tsp = { signature: null, keys: [], exact: true, road: true, busy: false };
    firstFit = true; userMoved = false;
    load();
  }

  async function load() {
    try {
      const fresh = await api(`/api/map${day ? `?date=${day}` : ""}`);
      if (!alive || (day && fresh.date !== day)) return;
      data = fresh; day = fresh.date; points = fresh.points;
      fillDates();
      paint();
    } catch (error) {
      $("#routeSum", root).innerHTML = `<div class="rsEmpty bad">${esc(error.message)}</div>`;
    }
  }
  load();
  const unsubscribe = onDataChange(() => load());  // Records changed (start / end / close): recolour

  // Keep everything in view while the panel settles, until you move the map yourself.
  let userMoved = false;
  map.on("dragstart", () => { userMoved = true; });
  mapEl.addEventListener("wheel", () => { userMoved = true; }, { passive: true });
  const resize = new ResizeObserver(() => { map.invalidateSize(); if (!userMoved && data) fitVisible(); });
  resize.observe(mapEl);

  return () => {
    alive = false;
    unsubscribe();
    resize.disconnect();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    map.remove();
  };
}
