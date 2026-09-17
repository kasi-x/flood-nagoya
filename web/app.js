// 名古屋市 雨水流出エミュレーター — map view, region selection, UI wiring.
import { FloodSim, MODE_TERRAIN, MODE_DEPTH, MODE_SPEED, MODE_MAXDEPTH } from "./sim.js?v=19p";
import { ThreeView } from "./view3d.js?v=18h";

const Z15 = 15;
const EARTH = 40075016.686;
const OVERVIEW_FACTOR = 4;      // overview px = 4 × z15 px
const TILE_PX = 256;
const MAX_DIM = 3400;           // per-axis sim grid cap (cells)
const MAX_CELLS = 11.5e6;       // total sim grid cap

const LOCATIONS = [
  { name: "名古屋駅", lon: 136.8817, lat: 35.1709 },
  { name: "栄", lon: 136.9066, lat: 35.1700 },
  { name: "バンテリンドーム", lon: 136.9349, lat: 35.1868 },
  { name: "熱田神宮", lon: 136.9077, lat: 35.1276 },
  { name: "金山", lon: 136.9008, lat: 35.1433 },
  { name: "名古屋港", lon: 136.8602, lat: 35.0535 },
  { name: "藤が丘", lon: 137.0236, lat: 35.1832 },
  { name: "勝川", lon: 136.9502, lat: 35.2233 },
  { name: "植田", lon: 136.9889, lat: 35.1192 },
  { name: "中村公園", lon: 136.8506, lat: 35.1667 },
  { name: "鶴舞公園", lon: 136.9144, lat: 35.1522 },
];

const SCENARIOS = [
  { name: "ゲリラ豪雨", rain: 100, min: 60, desc: "100mm/h × 60分" },
  { name: "線状降水帯", rain: 80, min: 180, desc: "80mm/h × 3時間" },
  { name: "台風", rain: 50, min: 360, desc: "50mm/h × 6時間" },
  { name: "小雨", rain: 10, min: 120, desc: "10mm/h × 2時間" },
];

const $ = (id) => document.getElementById(id);

let meta = null;
let sim = null;
let mode = "map";              // "map" | "sim"
let mapView = { x: 0, y: 0, z: 1.6 };  // overview px: center + scale
let drag = null;               // region selection state
let renderMode = MODE_DEPTH;
let lastStatsT = 0;
let fpsInfo = { last: performance.now(), dtAvg: 16 };
let accMm = 0, accPrevT = 0, accPrevRate = 0;
let mapReady = false;
let mapDemTex = null, mapStreamsTex = null;
let threeView = null, view3dOn = false, frameNo = 0;
let regionInfo = null;   // {terrain, bldg, W, H, dx} of the current sim grid

const lonToX = (lon, z) => (lon + 180) / 360 * 2 ** z;
const latToY = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * 2 ** z;
};
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

function init() {
  const canvas = $("gl");
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    toast("GPUコンテキストが失われました。再読み込みしてください");
  });
  try {
    sim = new FloodSim(canvas);
    window.__sim = sim;
    window.__sim = sim;
  } catch (err) {
    toast(err.message, 15000);
    return;
  }
  fetch("meta.json").then((r) => r.json()).then((m) => {
    meta = m;
    setupMap();
    requestAnimationFrame(loop);
  }).catch(() => toast("meta.json を読み込めません。`python -m flood_nagoya build` を実行してください"));
  wireUI();
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  loadObservedScenarios();
}

function resizeCanvas() {
  const canvas = $("gl");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
}

/** Compose GSI aerial-photo tiles (ort) over the region into one canvas. */
async function fetchPhotoCanvas(left, top, w, h, zoom) {
  const k = 2 ** (zoom - Z15);
  const ax = (meta.tile_range.x0 * TILE_PX + left) * k;
  const ay = (meta.tile_range.y0 * TILE_PX + top) * k;
  const wpx = Math.round(w * k), hpx = Math.round(h * k);
  const tx0 = Math.floor(ax / TILE_PX), tx1 = Math.floor((ax + wpx - 1) / TILE_PX);
  const ty0 = Math.floor(ay / TILE_PX), ty1 = Math.floor((ay + hpx - 1) / TILE_PX);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 110) return null;
  const comp = document.createElement("canvas");
  comp.width = wpx; comp.height = hpx;
  const ctx = comp.getContext("2d");
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) jobs.push({ tx, ty });
  }
  let okCount = 0;
  await Promise.all(jobs.map(({ tx, ty }) => new Promise((done) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.drawImage(img, tx * TILE_PX - ax, ty * TILE_PX - ay, TILE_PX, TILE_PX);
      okCount++;
      done();
    };
    img.onerror = () => done();
    img.src = `https://cyberjapandata.gsi.go.jp/xyz/ort/${zoom}/${tx}/${ty}.jpg`;
  })));
  return okCount > 0 ? comp : null;
}

function mPerPxAt(lat) {
  return EARTH * Math.cos(lat * Math.PI / 180) / 2 ** Z15 / TILE_PX;
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("読み込み失敗: " + src));
    img.src = src;
  });
}

async function setupMap() {
  const { x0, y0 } = meta.tile_range;
  const ow = (meta.tile_range.x1 - x0 + 1) * TILE_PX / OVERVIEW_FACTOR;
  const oh = (meta.tile_range.y1 - y0 + 1) * TILE_PX / OVERVIEW_FACTOR;
  meta.overviewPx = { w: ow, h: oh };
  const midLat = (meta.bbox.lat_min + meta.bbox.lat_max) / 2;
  meta.overviewMPerPx = mPerPxAt(midLat) * OVERVIEW_FACTOR;
  meta.z15MPerPx = mPerPxAt(midLat);

  try {
    const [dem, streams] = await Promise.all([
      loadImage("overview/dem.png"), loadImage("overview/streams.png"),
    ]);
    mapDemTex = sim.makeTexFromImage(dem);
    mapStreamsTex = sim.makeTexFromImage(streams);
    enterMapView();
    mapReady = true;
  } catch (e) {
    toast("オーバービュー画像がありません: " + e.message);
    return;
  }

  // location buttons + labels
  const holder = $("locations");
  for (const loc of LOCATIONS) {
    const px = (lonToX(loc.lon, Z15) - x0) * TILE_PX;   // z15 pixel coords
    const py = (latToY(loc.lat, Z15) - y0) * TILE_PX;
    loc.opx = px / OVERVIEW_FACTOR;
    loc.opy = py / OVERVIEW_FACTOR;
    const b = document.createElement("button");
    b.textContent = loc.name;
    b.onclick = () => jumpTo(loc);
    holder.appendChild(b);
    const el = document.createElement("div");
    el.className = "label";
    el.textContent = loc.name;
    $("labels").appendChild(el);
    loc.el = el;
  }

  const scene = $("scenarios");
  for (const sc of SCENARIOS) {
    const b = document.createElement("button");
    b.className = "scenario";
    b.innerHTML = `<b>${sc.name}</b><span>${sc.desc}</span>`;
    b.onclick = () => {
      sim.startScenario(sc.rain, sc.min);
      rainFrames.stop();
      $("rain").value = sc.rain;
      $("duration").value = sc.min;
      syncSliderLabels();
      setActiveScenario(b);
      toast(`シナリオ開始: ${sc.name} (${sc.desc})`);
    };
    scene.appendChild(b);
  }

  startDefaultScene();
}

/** 起動時の既定シーン: 栄中心のPLATEAU View風3D (航空写真+建物)。 */
function startDefaultScene() {
  if (startDefaultScene.done || !meta) return;
  startDefaultScene.done = true;
  const SAKAI = LOCATIONS.find((l) => l.name === "栄");
  const cx = (lonToX(SAKAI.lon, Z15) - meta.tile_range.x0) * TILE_PX;
  const cy = (latToY(SAKAI.lat, Z15) - meta.tile_range.y0) * TILE_PX;
  const halfW = 500, halfH = 400;  // ≒ 3.9 × 3.1 km
  const r = mapRectToZ15({
    x0: (cx - halfW) / OVERVIEW_FACTOR, y0: (cy - halfH) / OVERVIEW_FACTOR,
    x1: (cx + halfW) / OVERVIEW_FACTOR, y1: (cy + halfH) / OVERVIEW_FACTOR,
  });
  startSimFromRect(r).then(() => {
    if (!view3dOn) set3d(true);
    if (location.search.includes("noff")) { sim.paused = true; return; }  // 検証用
    const refresh = () => {
      if (threeView) {
        threeView.updateWater(sim.readState());
        threeView.controls.update();
        threeView.renderer.render(threeView.scene, threeView.camera);
      }
    };
    // 最初の10分は同期で進めて開いた瞬間に水を見せる
    for (let i = 0; i < 12000; i++) sim.step(0.05);
    refresh();
    // 残り20分はフレーム分割でGPUに負担をかけない
    const ff = () => {
      if (sim.time >= 1800) return;
      for (let i = 0; i < 400; i++) sim.step(0.05);  // 20秒/フレーム
      refresh();
      requestAnimationFrame(ff);
    };
    requestAnimationFrame(ff);
  });
}

// ---------- observed rainfall (AMeDAS) scenarios ----------

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function setActiveScenario(button) {
  document.querySelectorAll(".scenario").forEach((el) => el.classList.remove("active"));
  if (button) button.classList.add("active");
}

function drawSparkline(cv, series) {
  const w = cv.width = 130, h = cv.height = 26;
  const ctx = cv.getContext("2d");
  const maxRate = Math.max(...series.map((p) => p[1]), 1);
  const tEnd = series[series.length - 1][0];
  ctx.strokeStyle = "#7db9e8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.forEach(([t, r], i) => {
    const x = 1 + t / tEnd * (w - 2);
    const y = h - 2 - r / maxRate * (h - 5);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/** List rain_*.json scenarios generated by `rain-scenario` (no-op if none). */
async function loadObservedScenarios() {
  let entries;
  try {
    entries = await (await fetch("scenarios/index.json")).json();
  } catch {
    return;   // no observed scenarios generated
  }
  $("observedHead").hidden = false;
  const holder = $("observedScenarios");
  for (const entry of entries) {
    let sc;
    try {
      sc = await (await fetch(`scenarios/${entry.file}`)).json();
    } catch {
      continue;
    }
    const b = document.createElement("button");
    b.className = "scenario observed";
    b.innerHTML = `<b>${escapeHtml(entry.name)}</b><span>${escapeHtml(entry.desc)}</span>`;
    const spark = document.createElement("canvas");
    spark.className = "spark";
    drawSparkline(spark, sc.series);
    b.appendChild(spark);
    b.onclick = () => {
      if (sc.kind === "observed-rain") {
        rainFrames.stop();
        sim.startHyetograph(sc.series);
        toast(`観測降雨を再現中: ${entry.name} — 実測ハイエトグラフで駆動 (降雨スライダーは無効)`);
      } else {
        if (!regionInfo) { toast("先にシミュレーション範囲を選んでください"); return; }
        rainFrames.load(sc);
        toast(`観測降雨 (空間分布) を再現中: ${entry.name} — ${sc.source}`);
      }
      setActiveScenario(b);
    };
    holder.appendChild(b);
  }
}

// ---------- observed spatial-rain frame streaming (XRAIN / MSM) ----------

const rainFrames = {
  sc: null, current: -1, loading: new Set(), cache: new Map(),

  /** Start a spatial scenario: timing from the series, rates from frames. */
  load(sc) {
    this.stop();
    this.sc = sc;
    const g = sc.geo, r = regionInfo;
    const kx = g.factor * g.width, ky = g.factor * g.height;
    sim.startObservedRain(sc.series, [
      1 / kx, 1 / ky,
      (r.left || 0) / kx,
      1 - ((r.top || 0) + r.H) / ky,
    ]);
    this.update();
  },

  /** Bind the frame matching the current model time (loads on demand). */
  update() {
    if (!this.sc || !sim.spatialRain) return;
    const idx = clamp(Math.floor(sim.time / this.sc.frame_seconds), 0, this.sc.frames.length - 1);
    if (idx === this.current) return;
    const cached = this.cache.get(idx);
    if (cached) { this.current = idx; sim.setRainTexture(cached); return; }
    if (this.loading.has(idx)) return;
    this.loading.add(idx);
    const meta = this.sc.frames[idx];
    const dir = this.sc.file.replace(/\.json$/, "");
    loadImage(`scenarios/${dir}/${meta.file}`).then((img) => {
      this.loading.delete(idx);
      if (!this.sc || !sim.spatialRain) return;
      this.cache.set(idx, sim.makeTexFromImage(img));
      while (this.cache.size > 24) {
        const oldest = this.cache.keys().next().value;
        if (oldest === idx) break;
        sim.gl.deleteTexture(this.cache.get(oldest));
        this.cache.delete(oldest);
      }
      this.update();
    }).catch(() => this.loading.delete(idx));
  },

  stop() {
    sim.setRainTexture(null);
    for (const t of this.cache.values()) sim.gl.deleteTexture(t);
    this.cache.clear();
    this.current = -1;
    this.loading.clear();
    this.sc = null;
  },
};

function enterMapView() {
  sim.mapMode = true;
  sim.terrainTex = mapDemTex;
  sim.bldgTex = sim.emptyTex(meta.overviewPx.w, meta.overviewPx.h);
  sim.streamsTex = mapStreamsTex;
  sim.W = meta.overviewPx.w;
  sim.H = meta.overviewPx.h;
  sim.dx = meta.overviewMPerPx;
  if (!enterMapView.done) {
    mapView = fitView(sim.W, sim.H);
    enterMapView.done = true;
  }
  sim.view = mapView;
}

function fitView(w, h) {
  const canvas = $("gl");
  const z = Math.min(canvas.width / w, canvas.height / h) * 0.95;
  return { x: w / 2, y: h / 2, z };
}

function jumpTo(loc) {
  mapView.x = loc.opx;
  mapView.y = loc.opy;
  mapView.z = Math.max(mapView.z, 3.5);
  sim.view = mapView;
}

function screenToMap(px, py) {
  const canvas = $("gl");
  const dpr = canvas.width / innerWidth;
  const sx = px * dpr, sy = canvas.height - py * dpr;
  const v = mode === "map" ? mapView : sim.view;
  return {
    x: (sx - canvas.width / 2) / v.z + v.x,
    y: (sy - canvas.height / 2) / v.z + v.y,
  };
}

function updateLabels() {
  const canvas = $("gl");
  const dpr = canvas.width / innerWidth;
  for (const loc of LOCATIONS) {
    if (!loc.el) continue;
    const sx = (loc.opx - mapView.x) * mapView.z + canvas.width / 2;
    const sy = canvas.height - ((loc.opy - mapView.y) * mapView.z + canvas.height / 2);
    const vis = sx > -60 && sx < canvas.width + 60 && sy > -20 && sy < canvas.height + 20;
    loc.el.style.display = vis ? "block" : "none";
    if (vis) {
      loc.el.style.left = (sx / dpr) + "px";
      loc.el.style.top = (sy / dpr) + "px";
    }
  }
}

// ---------- region selection → sim ----------

function mapRectToZ15(r) {
  const maxX = (meta.tile_range.x1 - meta.tile_range.x0 + 1) * TILE_PX;
  const maxY = (meta.tile_range.y1 - meta.tile_range.y0 + 1) * TILE_PX;
  const px0 = clamp(Math.round(Math.min(r.x0, r.x1) * OVERVIEW_FACTOR), 0, maxX);
  const px1 = clamp(Math.round(Math.max(r.x0, r.x1) * OVERVIEW_FACTOR), 0, maxX);
  const py0 = clamp(Math.round(Math.min(r.y0, r.y1) * OVERVIEW_FACTOR), 0, maxY);
  const py1 = clamp(Math.round(Math.max(r.y0, r.y1) * OVERVIEW_FACTOR), 0, maxY);
  let w = Math.min(px1 - px0, MAX_DIM, maxX);
  let h = Math.min(py1 - py0, MAX_DIM, maxY);
  const scale = Math.min(1, Math.sqrt(MAX_CELLS / Math.max(w * h, 1)));
  w = Math.max(32, Math.floor(w * scale));
  h = Math.max(32, Math.floor(h * scale));
  const left = clamp(Math.round((px0 + px1) / 2 - w / 2), 0, maxX - w);
  const top = clamp(Math.round((py0 + py1) / 2 - h / 2), 0, maxY - h);
  return { left, top, w, h };
}

async function startSimFromRect(r) {
  const kmW = r.w * meta.z15MPerPx / 1000, kmH = r.h * meta.z15MPerPx / 1000;
  toast(`タイル読み込み中… ${r.w}×${r.h} セル (${kmW.toFixed(1)}×${kmH.toFixed(1)} km)`);
  const { x0, y0 } = meta.tile_range;
  const tx0 = Math.floor(r.left / TILE_PX), tx1 = Math.floor((r.left + r.w - 1) / TILE_PX);
  const ty0 = Math.floor(r.top / TILE_PX), ty1 = Math.floor((r.top + r.h - 1) / TILE_PX);
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      jobs.push({
        tx, ty,
        dem: loadImage(`tiles/dem/${x0 + tx}_${y0 + ty}.png`),
        bldg: loadImage(`tiles/bldg/${x0 + tx}_${y0 + ty}.png`).catch(() => null),
      });
    }
  }
  try {
    let got = 0;
    const total = jobs.length;
    const loaded = await Promise.all(jobs.map(async (j) => {
      const d = await j.dem;
      const b = await j.bldg;
      got++;
      toast(`タイル読み込み中… ${got}/${total}`);
      return [d, b];
    }));
    const comp = document.createElement("canvas");
    comp.width = r.w; comp.height = r.h;
    const ctx = comp.getContext("2d", { willReadFrequently: true });
    const compB = document.createElement("canvas");
    compB.width = r.w; compB.height = r.h;
    const ctxB = compB.getContext("2d", { willReadFrequently: true });
    loaded.forEach(([dem, bldg], i) => {
      const { tx, ty } = jobs[i];
      const dx = tx * TILE_PX - r.left, dy = ty * TILE_PX - r.top;
      ctx.drawImage(dem, dx, dy);
      if (bldg) ctxB.drawImage(bldg, dx, dy);
    });
    const terrain = ctx.getImageData(0, 0, r.w, r.h);
    const bldg = ctxB.getImageData(0, 0, r.w, r.h);

    regionInfo = { terrain: terrain.data, bldg: bldg.data, W: r.w, H: r.h, dx: meta.z15MPerPx, photo: null, left: r.left, top: r.top };
    if (threeView && view3dOn) threeView.setRegion(r.w, r.h, meta.z15MPerPx, regionInfo.terrain, regionInfo.bldg);
    fetchPhotoCanvas(r.left, r.top, r.w, r.h, 16).then((photo) => {
      if (photo && regionInfo.W === r.w) {
        regionInfo.photo = photo;
        if (threeView && view3dOn) threeView.setPhotoCanvas(photo);
      }
    });
    sim.mapMode = false;
    sim.streamsTex = null;
    // map textures are shared references — do not let dispose() delete them
    sim.terrainTex = null;
    sim.bldgTex = null;
    sim.dispose();
    sim.setGrid(r.w, r.h, meta.z15MPerPx, terrain.data, bldg.data);
    sim.view = {
      x: r.w / 2, y: r.h / 2,
      z: Math.min($("gl").width / r.w, $("gl").height / r.h) * 0.98,
    };
    mode = "sim";
    $("mapPanel").hidden = true;
    $("simPanel").hidden = false;
    $("north").hidden = true;
    sim.startScenario(parseFloat($("rain").value), parseInt($("duration").value, 10));
    toast(`シミュレーション開始 — ${kmW.toFixed(1)}×${kmH.toFixed(1)}km, 解像度${meta.z15MPerPx.toFixed(1)}m (ドラッグでパン・ホイールでズーム)`);
  } catch (e) {
    toast("タイル読み込みに失敗: " + e.message);
  }
}

function startCitySim() {
  if (!meta || !meta.overviewPx) return;
  const ow = meta.overviewPx.w, oh = meta.overviewPx.h;
  loadImage("overview/dem.png").then((dem) => {
    const comp = document.createElement("canvas");
    comp.width = ow; comp.height = oh;
    const ctx = comp.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(dem, 0, 0);
    const terrain = ctx.getImageData(0, 0, ow, oh);
    regionInfo = { terrain: terrain.data, bldg: null, W: ow, H: oh, dx: meta.overviewMPerPx, photo: null, left: 0, top: 0 };
    if (threeView && view3dOn) threeView.setRegion(ow, oh, meta.overviewMPerPx, regionInfo.terrain, null);
    fetchPhotoCanvas(0, 0, ow, oh, 13).then((photo) => {
      if (photo && regionInfo.W === ow) {
        regionInfo.photo = photo;
        if (threeView && view3dOn) threeView.setPhotoCanvas(photo);
      }
    });
    sim.mapMode = false;
    sim.streamsTex = null;
    sim.terrainTex = null;
    sim.bldgTex = null;
    sim.dispose();
    sim.setGrid(ow, oh, meta.overviewMPerPx, terrain.data, null);
    sim.view = fitView(ow, oh);
    mode = "sim";
    $("mapPanel").hidden = true;
    $("simPanel").hidden = false;
    $("north").hidden = true;
    sim.startScenario(parseFloat($("rain").value), parseInt($("duration").value, 10));
    toast(`名古屋市全域モード (${ow}×${oh} セル, ${meta.overviewMPerPx.toFixed(1)}m解像度)`);
  });
}

function backToMap() {
  mode = "map";
  if (view3dOn) set3d(false);
  rainFrames.stop();
  $("north").hidden = false;
  $("simPanel").hidden = true;
  $("mapPanel").hidden = false;
  sim.dispose();
  enterMapView();
}

// ---------- interaction ----------

function wireUI() {
  const canvas = $("gl");
  canvas.addEventListener("pointerdown", (e) => {
    if (mode === "sim") {
      drag = { pan: true, sx: e.clientX, sy: e.clientY, panView: { ...sim.view } };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
      return;
    }
    const p = screenToMap(e.clientX, e.clientY);
    drag = {
      sx: e.clientX, sy: e.clientY, x0: p.x, y0: p.y, x1: p.x, y1: p.y,
      cx: e.clientX, cy: e.clientY, moved: false, select: false,
      pan: false, panView: { ...mapView },
    };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.pan && mode === "sim") {
      const dpr = $("gl").width / innerWidth;
      sim.view.x = drag.panView.x - (e.clientX - drag.sx) * dpr / sim.view.z;
      sim.view.y = drag.panView.y + (e.clientY - drag.sy) * dpr / sim.view.z;
      return;
    }
    if (mode !== "map") return;
    const p = screenToMap(e.clientX, e.clientY);
    drag.x1 = p.x; drag.y1 = p.y;
    drag.cx = e.clientX; drag.cy = e.clientY;
    const dist = Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy);
    if (!drag.moved && dist > 8) drag.moved = true;
    if (drag.pan) {
      const dpr = $("gl").width / innerWidth;
      mapView.x = drag.panView.x - (e.clientX - drag.sx) * dpr / mapView.z;
      mapView.y = drag.panView.y + (e.clientY - drag.sy) * dpr / mapView.z;
      sim.view = mapView;
    } else {
      drawSelBox();
    }
  });
  canvas.addEventListener("pointerup", () => {
    const d = drag; drag = null;
    $("gl").style.cursor = "";
    if (mode !== "map" || !d) return;
    $("selbox").hidden = true;
    if (!d.moved || d.pan) return;
    const r = mapRectToZ15(d);
    if (r.w < 32 || r.h < 32) { toast("範囲が小さすぎます"); return; }
    startSimFromRect(r);
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const v = mode === "map" ? mapView : sim.view;
    if (!v) return;
    const before = screenToMap(e.clientX, e.clientY);
    const f = Math.exp(-e.deltaY * 0.0012);
    v.z = clamp(v.z * f, 0.3, 14);
    const after = screenToMap(e.clientX, e.clientY);
    v.x += before.x - after.x;
    v.y += before.y - after.y;
    if (mode === "map") sim.view = mapView;
  }, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && mode === "map") {
      if (drag) drag.pan = true;
      e.preventDefault();
    }
    if (e.code === "Escape" && mode === "sim") backToMap();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" && drag) drag.pan = false;
  });

  for (const id of ["rain", "duration", "drain", "infil", "manning", "speed"]) {
    $(id).addEventListener("input", syncSliderLabels);
  }
  $("bldgToggle").addEventListener("change", (e) => {
    sim.setParams({ bldgOn: e.target.checked ? 1 : 0 });
  });
  $("photo3dToggle").addEventListener("change", (e) => {
    if (threeView) threeView.setPhotoVisible(e.target.checked);
  });
  $("bldg3dToggle").addEventListener("change", (e) => {
    if (threeView) threeView.setBuildingsVisible(e.target.checked);
  });
  document.querySelectorAll('input[name="disp"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      renderMode = { depth: MODE_DEPTH, speed: MODE_SPEED, max: MODE_MAXDEPTH }[e.target.value] ?? MODE_TERRAIN;
      for (const id of ["legend-depth", "legend-speed", "legend-max"]) {
        $(id).hidden = !id.endsWith(e.target.value);
      }
    });
  });
  $("pauseBtn").onclick = () => {
    sim.paused = !sim.paused;
    $("pauseBtn").textContent = sim.paused ? "▶ 再開" : "⏸ 一時停止";
  };
  $("resetBtn").onclick = () => {
    sim.reset();
    if (sim.rainSeries) sim.startHyetograph(sim.rainSeries);
    else sim.startScenario(parseFloat($("rain").value), parseInt($("duration").value, 10));
    sim.paused = true;
    $("pauseBtn").textContent = "▶ 再開";
  };
  $("backBtn").onclick = backToMap;
  $("cityBtn").onclick = startCitySim;
  $("btn3d").onclick = () => set3d(!view3dOn);
  $("shotBtn").onclick = () => {
    const cv = view3dOn ? $("gl3d") : $("gl");
    const a = document.createElement("a");
    a.download = `flood-nagoya-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    a.href = cv.toDataURL("image/png");
    a.click();
    toast("スクリーンショットを保存しました");
  };
}

function set3d(on) {
  view3dOn = on;
  $("btn3d").classList.toggle("active", on);
  $("btn3d").textContent = on ? "🗺 2D表示に戻す" : "🏔 3D表示に切り替え";
  if (on) {
    if (!regionInfo) { toast("先にシミュレーション範囲を選んでください"); view3dOn = false; return; }
    if (!threeView) { threeView = new ThreeView($("gl3d")); window.__view3d = threeView; }
    const r = regionInfo;
    threeView.setRegion(r.W, r.H, r.dx, r.terrain, r.bldg, r.photo);
    $("gl3d").hidden = false;
    $("gl").style.visibility = "hidden";
    $("view3dOpts").hidden = false;
    $("north").hidden = true;
    for (const loc of LOCATIONS) loc.el.style.display = "none";
    threeView.resize();
    toast("3D表示中 — ドラッグで回転・ホイールでズーム・右ドラッグで移動");
  } else {
    $("gl3d").hidden = true;
    $("gl").style.visibility = "";
    $("view3dOpts").hidden = true;
    $("north").hidden = false;
  }
}

function drawSelBox() {
  const box = $("selbox");
  if (!drag || !drag.moved || drag.pan) { box.hidden = true; return; }
  box.hidden = false;
  box.style.left = Math.min(drag.sx, drag.cx) + "px";
  box.style.top = Math.min(drag.sy, drag.cy) + "px";
  box.style.width = Math.abs(drag.cx - drag.sx) + "px";
  box.style.height = Math.abs(drag.cy - drag.sy) + "px";
  // live size estimate from map coordinates
  const kmW = Math.abs(drag.x1 - drag.x0) * (meta.z15MPerPx * OVERVIEW_FACTOR) / 1000;
  const kmH = Math.abs(drag.y1 - drag.y0) * (meta.z15MPerPx * OVERVIEW_FACTOR) / 1000;
  $("selinfo").textContent = `${kmW.toFixed(1)} × ${kmH.toFixed(1)} km`;
}

function syncSliderLabels() {
  $("rainVal").textContent = $("rain").value + " mm/h";
  $("durationVal").textContent = $("duration").value + " 分";
  $("drainVal").textContent = $("drain").value + " mm/h";
  $("infilVal").textContent = $("infil").value + " mm/h";
  $("manningVal").textContent = parseFloat($("manning").value).toFixed(3);
  $("speedVal").textContent = "×" + $("speed").value;
  if (sim) {
    sim.setParams({
      rain: parseFloat($("rain").value),
      drain: parseFloat($("drain").value),
      infil: parseFloat($("infil").value),
      manning: parseFloat($("manning").value),
    });
  }
}

function toast(msg, ms = 3500) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

function fmtVol(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " 百万m³";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + " 千m³";
  return v.toFixed(0) + " m³";
}

// ---------- main loop ----------

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dtMs = now - fpsInfo.last;
  fpsInfo.last = now;
  fpsInfo.dtAvg = fpsInfo.dtAvg * 0.9 + dtMs * 0.1;

  resizeCanvas();
  if (mode === "map") {
    sim.view = mapView;
    if (mapReady) sim.render(MODE_TERRAIN);
    updateLabels();
    return;
  }
  if (!sim.W || sim.mapMode) return;
  frameNo++;
  rainFrames.update();
  if (view3dOn && threeView && frameNo % 8 === 0) {
    threeView.updateWater(sim.readState());
  }
  if (!sim.paused) {
    const speed = parseInt($("speed").value, 10);
    // keep interactive: fewer substeps when the frame is slow
    const budget = clamp(1200 / Math.max(fpsInfo.dtAvg, 6), 1, 120);
    const substeps = clamp(Math.round(speed * budget / 60), 1, 480);
    sim.advance(0.016 * speed, substeps);
  }
  if (!view3dOn) sim.render(renderMode);   // 2D canvas is hidden in 3D mode
  if (now - lastStatsT > 1000) {
    lastStatsT = now;
    const st = sim.computeStats();
    $("statTime").textContent = fmtTime(sim.time);
    const rateNow = sim.rainSeries ? sim.rainRateAt(Math.min(sim.time, sim.rainEnd)) : parseFloat($("rain").value);
    const raining = sim.rainLeft > 0 || (sim.rainSeries && sim.time < sim.rainEnd);
    const badge = $("rainBadge");
    badge.textContent = raining ? "🌧 降雨中" : "☁ 降雨なし";
    badge.className = "badge " + (raining ? "rain" : "stop");
    $("statRain").textContent = raining
      ? `${rateNow.toFixed(1)} mm/h (残 ${fmtTime(sim.rainLeft > 0 ? sim.rainLeft : Math.max(0, sim.rainEnd - sim.time))})`
      : "降っていません";
    // 積算雨量: 台形積分 (観測ハイエトグラフにも対応)
    if (sim.time < accPrevT) { accMm = 0; accPrevT = 0; accPrevRate = 0; }
    accMm += (rateNow + accPrevRate) / 2 * (sim.time - accPrevT) / 3600;
    accPrevT = sim.time; accPrevRate = rateNow;
    $("statAcc").textContent = accMm.toFixed(1) + " mm";
    $("statVol").textContent = fmtVol(st.volume);
    // 氾濫面積(>5cm)の域内比バー
    const regionKm2 = sim.W * sim.H * sim.dx * sim.dx / 1e12;
    $("statBar").style.width = Math.min(100, (st.a5 / 1e6) / regionKm2 * 1200).toFixed(1) + "%";
    $("statA5").textContent = (st.a5 / 1e6).toFixed(2) + " km²";
    $("statA30").textContent = (st.a30 / 1e6).toFixed(2) + " km²";
    $("statA100").textContent = (st.a100 / 1e6).toFixed(2) + " km²";
    $("statFps").textContent = (1000 / Math.max(fpsInfo.dtAvg, 1)).toFixed(0);
  }
}

window.addEventListener("error", (e) => toast("エラー: " + e.message, 8000));
window.addEventListener("unhandledrejection", (e) => toast("エラー: " + (e.reason?.message || e.reason), 8000));

init();
