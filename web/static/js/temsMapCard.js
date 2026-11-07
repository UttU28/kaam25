// The TEMS Paragon map, live: drawn the way TEMS draws its Map page (same layers, colours, sizes,
// car icon, waypoint rings and flags, grid key and index), from TEMS's own data via
// /api/live/temsMap, so it also works on a tablet. Polls every 2 s while the page is open;
// read-only - nothing in TEMS is clicked or changed.
import { api, icon } from "./core.js";
import { loadLeaflet } from "./pages/maps.js";

// TEMS's Default layer settings (Map > Layers), ARGB from its config.
const gridStyle = {
  colors: ["#0078d7", "#10893e", "#000000"],   // not tested / tested / skipped
  cellOpacity: 0.15, stationaryOpacity: 0.75,
  stroke: "rgba(0,0,0,0.5)", strokeWidth: 1,
  target: "#ff8c00", targetWidth: 5,
  neighbors: "#e53935", neighborsWidth: 3,
  index: "#ababab",
};
const routeStyle = { color: "#1c2bff", width: 4, target: "#1ca8ff", states: ["#bc0000", "#27c416", "#b6b6b6"] };
const trackStyle = { color: "#1ca8ff", width: 2, previous: "#004f80", previousWidth: 2 };
const carScale = 0.5;   // TEMS draws its 96 px car image at half size
const osrmUrl = "https://router.project-osrm.org";
const autoPanKey = "kaamTemsAutoPan";
// TEMS's flag shape (start: green, goal: checkered).
const flagPath = "M26.5,4.8c-0.3-0.2-0.7-0.2-1,0c-3.5,2.2-6.1,0.8-9-0.8c-3-1.6-6.5-3.4-11-0.7C5.2,3.6,5,3.9,5,4.3V18v0.3V29" +
  "c0,0.6,0.4,1,1,1s1-0.4,1-1V18.9c3.3-1.8,5.7-0.5,8.5,1c1.9,1,4,2.1,6.4,2.1c1.4,0,3-0.4,4.6-1.4c0.3-0.2,0.5-0.5,0.5-0.9v-14" +
  "C27,5.3,26.8,5,26.5,4.8z";

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const withAlpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

const carImage = new Image();
carImage.src = "/static/img/temsCar.png";

// Options (the test pop-up's map box): compact - no title row, fitTo "grid" - Zoom to fit frames
// the grid cells alone (route and car only when there's no grid), pan - auto pan's start value and
// its own saved key.
export function temsMapCard({ compact = false, fitTo = "all", pan = null } = {}) {
  const panKey = pan?.key || autoPanKey;
  const el = document.createElement("div");
  el.className = `card temsMap${compact ? " compact" : ""}`;
  el.innerHTML = `
    <div class="tmHead">
      <span class="liveDot"></span><b>TEMS map</b>
      <span class="tmWo mono"></span>
      <span class="spacer"></span>
      <span class="tmCount hint"></span>
    </div>
    <div class="tmTools">
      <button class="btn btnGhost sm tmPan" title="Keep the car in view">${icon("check", "sm")}<span>Auto pan</span></button>
      <button class="btn btnGhost sm tmFit" title="${fitTo === "grid" ? "Zoom to the grid" : "Zoom to the grid, route and car"}">${icon("refresh", "sm")}<span>${fitTo === "grid" ? "Zoom to grid" : "Zoom to fit"}</span></button>
      <button class="btn btnGhost sm tmCenter" title="Center on the car">${icon("navigate", "sm")}<span>Center</span></button>
      <span class="tmKey mono"></span>
    </div>
    <div class="tmBody"><div class="tmMap"></div><div class="tmMsg hidden"></div></div>`;
  const q = (s) => el.querySelector(s);
  const dot = q(".liveDot"), woLabel = q(".tmWo"), msg = q(".tmMsg"), panBtn = q(".tmPan");

  let map = null, L = null, overlay = null, timer = null, dead = false, fitted = false;
  // Speed test pins (Live Testing): [{lat, lon, html, popup, best}] - drawn over TEMS's layers.
  let pins = [], pinLayer = null;
  function drawPins() {
    if (!map || !L) return;
    pinLayer?.remove();
    pinLayer = L.layerGroup(pins.map((p) => L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: "spIcon", html: p.html, iconSize: [0, 0], iconAnchor: [0, 0], popupAnchor: [0, -38] }),
      zIndexOffset: p.best ? 900 : 800, riseOnHover: true,
    }).bindPopup(p.popup, { maxWidth: 320 }))).addTo(map);
  }
  let data = null, track = [], previousTrack = [], roadRoute = null, routeKey = "";
  let car = null, carPrev = null, heading = 0;
  const savedPan = lsGet(panKey);
  let autoPan = savedPan == null ? (pan?.on ?? true) : savedPan !== "0";
  const paintPan = () => panBtn.classList.toggle("on", autoPan);
  paintPan();
  panBtn.addEventListener("click", () => {
    autoPan = !autoPan; lsSet(panKey, autoPan ? "1" : "0"); paintPan();
    if (autoPan && car) map?.panTo(car);
  });
  let touched = false;  // you moved / zoomed the map by hand
  q(".tmFit").addEventListener("click", () => { touched = false; fit(); });
  for (const type of ["pointerdown", "wheel", "touchstart"]) q(".tmMap").addEventListener(type, () => { touched = true; }, { passive: true });
  q(".tmCenter").addEventListener("click", () => { if (car) map?.setView(car, Math.max(map.getZoom(), 16)); });

  function say(text) { msg.textContent = text; msg.classList.toggle("hidden", !text); }

  function fit() {
    if (!map || !data) return;
    const size = map.getSize();
    if (!size.x || !size.y) return;  // not on screen yet: fitted once it has a size
    let points = [];
    for (const c of data.cells) points.push(...c.corners);
    if (fitTo !== "grid" || !points.length) {
      for (const w of data.route) if (w.at) points.push(w.at);
      if (car) points.push(car);
    }
    if (!points.length) return;
    if (points.length === 1) map.setView(points[0], 17);
    else if (fitTo === "grid") map.fitBounds(L.latLngBounds(points), { padding: [12, 12], maxZoom: 19, animate: false });
    else map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 18 });
  }

  // ----- road route between the waypoints (TEMS asks its map provider; we ask OSRM) -----
  async function routeRoads(waypoints) {
    const key = JSON.stringify(waypoints);
    if (key === routeKey) return;
    routeKey = key; roadRoute = null;
    if (waypoints.length < 2) return;
    try {
      const coords = waypoints.map(([lat, lon]) => `${lon},${lat}`).join(";");
      const reply = await fetch(`${osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`).then((r) => r.json());
      if (key !== routeKey || reply.code !== "Ok") return;
      roadRoute = reply.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      overlay?.redraw();
    } catch { /* offline: TEMS's dashed straight line stays */ }
  }

  // ----- drawing, like TEMS's canvas layers: grid, planned route + waypoints, track, car -----
  function draw(ctx, map, size) {
    ctx.clearRect(0, 0, size.x, size.y);
    if (!data) return;
    const px = (p) => map.latLngToContainerPoint(p);
    drawGrid(ctx, px, map.getZoom());
    drawRoute(ctx, px);
    drawTrack(ctx, px, previousTrack, trackStyle.previous, trackStyle.previousWidth);
    drawTrack(ctx, px, track, trackStyle.color, trackStyle.width);
    drawCar(ctx, px);
  }

  function cellCorners(c, px) {
    // Bottom-left, bottom-right, top-right, top-left (TEMS's order), in screen pixels.
    const pts = c.corners.slice(0, 4).map(px);
    const byY = pts.slice().sort((a, b) => a.y - b.y);
    const [tl, tr] = byY.slice(0, 2).sort((a, b) => a.x - b.x);
    const [bl, br] = byY.slice(2).sort((a, b) => a.x - b.x);
    return [bl, br, tr, tl];
  }

  function drawGrid(ctx, px, zoom) {
    for (const c of data.cells) {
      if (c.corners.length < 4) continue;
      const [bl, br, tr, tl] = cellCorners(c, px);
      const width = Math.abs(bl.x - tr.x);
      const path = new Path2D();
      path.moveTo(tl.x, tl.y); path.lineTo(tr.x, tr.y); path.lineTo(br.x, br.y); path.lineTo(bl.x, bl.y); path.closePath();
      if (c.station) {
        const sColor = withAlpha(gridStyle.colors[c.stationaryState] || gridStyle.colors[0], gridStyle.cellOpacity);
        const mColor = withAlpha(gridStyle.colors[c.mobilityState] || gridStyle.colors[0], gridStyle.cellOpacity);
        if (sColor === mColor) { ctx.fillStyle = sColor; ctx.fill(path); }
        else {
          ctx.beginPath(); ctx.moveTo(bl.x, bl.y); ctx.lineTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.closePath();
          ctx.fillStyle = sColor; ctx.fill();
          ctx.beginPath(); ctx.moveTo(bl.x, bl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.closePath();
          ctx.fillStyle = mColor; ctx.fill();
        }
      }
      ctx.lineWidth = gridStyle.strokeWidth; ctx.lineJoin = "miter"; ctx.lineCap = "square";
      ctx.strokeStyle = gridStyle.stroke; ctx.stroke(path);
      // Grid key in the middle, local index in the bottom-right corner.
      const fontPx = (br.x - tl.x) / Math.max(15, c.id.length);
      if (fontPx >= 4) {
        ctx.fillStyle = "rgb(0 0 0 / 50%)"; ctx.font = `${fontPx}px Arial`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(c.id, (tl.x + br.x) / 2, (tl.y + br.y) / 2, width);
      }
      if (c.index != null && width > 64) {
        ctx.font = `bold ${Math.round(0.15 * width)}px Arial`; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
        ctx.fillStyle = gridStyle.index; ctx.fillText(String(c.index), br.x - 3, br.y);
      }
      if (c.id === data.targetCell) {
        ctx.lineWidth = gridStyle.targetWidth; ctx.strokeStyle = gridStyle.target; ctx.stroke(path);
      }
      // Stationary point: an X in the stationary state's colour.
      if (c.station) {
        const { x, y } = px(c.station);
        const r = Math.min(width / 4, zoom ** 1.2 / 2);
        ctx.strokeStyle = withAlpha(gridStyle.colors[c.stationaryState] || gridStyle.colors[0], gridStyle.stationaryOpacity);
        ctx.lineWidth = r / 2; ctx.lineCap = "butt";
        ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
      }
    }
  }

  function drawRoute(ctx, px) {
    const waypoints = data.route.filter((w) => w.at);
    if (waypoints.length > 1) {
      ctx.lineJoin = "round"; ctx.lineCap = "butt"; ctx.lineWidth = routeStyle.width;
      ctx.beginPath();
      if (roadRoute) {  // calculated road route: black, like TEMS
        roadRoute.forEach((p, n) => { const { x, y } = px(p); n ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.strokeStyle = "black"; ctx.setLineDash([]);
      } else {          // not calculated (yet): dashed straight lines in the route colour
        waypoints.forEach((w, n) => { const { x, y } = px(w.at); n ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.strokeStyle = routeStyle.color; ctx.setLineDash([15, 10]);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    waypoints.forEach((w, n) => {
      const { x, y } = px(w.at);
      const color = n === data.targetWaypoint ? routeStyle.target : routeStyle.states[w.state] || routeStyle.states[0];
      ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.lineWidth = 6; ctx.fillStyle = "white"; ctx.fill(); ctx.stroke();
      const m = 26 * 0.7;
      ctx.font = `bold ${m}px sans-serif`; ctx.fillStyle = "white"; ctx.globalAlpha = 0.25;
      ctx.fillRect(x - m / 2, y - m / 2 + 26, m, m); ctx.globalAlpha = 1;
      ctx.lineWidth = 1; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.strokeStyle = "white"; ctx.strokeText(String(n + 1), x, y + 26);
      ctx.fillStyle = "black"; ctx.fillText(String(n + 1), x, y + 26);
    });
    ctx.lineWidth = 1;
    if (waypoints.length) renderFlag(ctx, px(waypoints[0].at), waypoints.length === 1 ? "none" : "start");
    if (waypoints.length > 1) renderFlag(ctx, px(waypoints[waypoints.length - 1].at), "goal");
  }

  let checkers = null;
  function renderFlag(ctx, { x, y }, kind) {
    if (kind === "goal" && !checkers) {
      const c = document.createElement("canvas"); c.width = c.height = 200;
      const g = c.getContext("2d");
      for (let row = 0; row < 40; row++) for (let col = 0; col < 40; col++) {
        g.fillStyle = (row % 2 === 0) === (col % 2 === 0) ? "white" : "black"; g.fillRect(col * 5, row * 5, 5, 5);
      }
      checkers = ctx.createPattern(c, "repeat");
    }
    ctx.save();
    ctx.fillStyle = kind === "start" ? "green" : kind === "goal" ? checkers || "red" : "grey";
    ctx.strokeStyle = "black";
    ctx.transform(0.5, 0, 0, 0.5, x, y); ctx.translate(13, 13);
    const shape = new Path2D(flagPath);
    ctx.fill(shape); ctx.stroke(shape);
    ctx.restore();
  }

  function drawTrack(ctx, px, points, color, width) {
    if (points.length < 2) return;
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    points.forEach((p, n) => { const { x, y } = px(p); n ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }

  function drawCar(ctx, px) {
    if (!car) return;
    const now = px(car);
    if (carPrev) {
      const before = px(carPrev);
      if (before.x !== now.x || before.y !== now.y) heading = Math.atan2(now.x - before.x, before.y - now.y);
    }
    if (!carImage.complete || !carImage.naturalWidth) {  // image not loaded yet: TEMS's plain dot
      ctx.beginPath(); ctx.arc(now.x, now.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = routeStyle.target; ctx.fill(); ctx.strokeStyle = "black"; ctx.lineWidth = 0.5; ctx.stroke();
      return;
    }
    const { naturalWidth: w, naturalHeight: h } = carImage;
    ctx.save(); ctx.translate(now.x, now.y); ctx.rotate(heading); ctx.scale(carScale, carScale);
    ctx.drawImage(carImage, -w / 2, -h / 2); ctx.restore();
  }
  carImage.addEventListener("load", () => overlay?.redraw());

  // ----- polling -----
  function take(next) {
    if (next.trackFrom === 0) { track = []; if (next.previousTrack) previousTrack = next.previousTrack; }
    track = track.concat(next.track);
    if (next.position && (!car || next.position[0] !== car[0] || next.position[1] !== car[1])) {
      carPrev = car || track[track.length - 2] || null; car = next.position;
    }
    data = next;
    routeRoads(next.route.filter((w) => w.at).map((w) => w.at));
    woLabel.textContent = next.wo ? `Cloud WO - ${next.wo}` : "no WO in TEMS yet";
    const visited = next.route.filter((w) => w.state === 1).length;
    q(".tmCount").textContent = next.route.length ? `${visited}/${next.route.length} waypoints` : "";
    q(".tmKey").textContent = next.cells.map((c) => c.id).join(", ");
    say(next.cells.length || next.route.length || next.position ? "" : "TEMS has no grid or route loaded yet.");
  }

  async function poll() {
    if (dead) return;
    let wait = 2000;
    if (!document.hidden) {
      try {
        const next = await api(`/api/live/temsMap?trackFrom=${track.length}`);
        if (dead) return;
        dot.className = "liveDot on";
        const firstOrNewGrid = !data || JSON.stringify(next.cells.map((c) => c.id)) !== JSON.stringify(data.cells.map((c) => c.id));
        take(next);
        if (!fitted || firstOrNewGrid) { fit(); fitted = true; }
        else if (autoPan && car) {
          const inner = map.getBounds().pad(-0.2);
          if (!inner.contains(car)) map.panTo(car, { animate: true });
        }
        overlay.redraw();
      } catch (error) {
        dot.className = "liveDot off";
        say(error.message);
        wait = 5000;
      }
    }
    timer = setTimeout(poll, wait);
  }

  loadLeaflet().then((leaflet) => {
    if (dead) return;
    L = leaflet;
    map = L.map(q(".tmMap"), { zoomControl: true, attributionControl: true });
    // Light grey road map, close to TEMS's Bing road style.
    const esriCanvas = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
    const light = L.layerGroup([
      L.tileLayer(`${esriCanvas}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16, attribution: "Tiles &copy; Esri", className: "bingLike" }),
      L.tileLayer(`${esriCanvas}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16 }),
    ]).addTo(map);
    const streets = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri" });
    const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri" });
    L.control.layers({ Road: light, Streets: streets, Satellite: satellite }, null, { position: "topright" }).addTo(map);
    L.control.scale({ position: "bottomright" }).addTo(map);
    map.setView([31.4, -94.25], 13);

    // One canvas over the map, redrawn on every move / zoom (like TEMS's canvas layers).
    const Overlay = L.Layer.extend({
      onAdd(m) {
        this.canvas = L.DomUtil.create("canvas", "tmCanvas leaflet-zoom-hide");
        m.getPanes().overlayPane.appendChild(this.canvas);
        m.on("move zoom resize viewreset zoomend moveend", this.redraw, this);
        this.redraw();
      },
      onRemove(m) { this.canvas.remove(); m.off("move zoom resize viewreset zoomend moveend", this.redraw, this); },
      redraw() {
        const m = this._map;
        if (!m) return;
        const size = m.getSize(), ratio = window.devicePixelRatio || 1;
        const c = this.canvas;
        L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
        if (c.width !== size.x * ratio || c.height !== size.y * ratio) {
          c.width = size.x * ratio; c.height = size.y * ratio;
          c.style.width = `${size.x}px`; c.style.height = `${size.y}px`;
        }
        const ctx = c.getContext("2d");
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        draw(ctx, m, size);
      },
    });
    overlay = new Overlay().addTo(map);
    drawPins();
    // Dragging the map pauses auto pan until you press it again (TEMS does the same).
    map.on("dragstart", () => { if (autoPan) { autoPan = false; lsSet(panKey, "0"); paintPan(); } });
    // A new size (shown after being hidden, window turned...): zoomed to fit again - unless you've
    // moved or zoomed the map yourself (Zoom to fit / grid hands it back).
    let wasEmpty = true;
    new ResizeObserver(() => {
      if (!map) return;
      map.invalidateSize();
      const size = map.getSize(), empty = !size.x || !size.y;
      if (!empty && data && (wasEmpty || !touched)) fit();
      wasEmpty = empty;
    }).observe(q(".tmMap"));
    poll();
  }).catch((error) => say(error.message));

  return {
    el,
    setSpeedPins(list) { pins = list || []; drawPins(); },
    destroy() { dead = true; clearTimeout(timer); map?.remove(); map = null; },
  };
}
