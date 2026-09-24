// 名古屋市 雨水流出エミュレーター — map view, region selection, UI wiring.
import { bindBenchHandle, PerfHud, runBench } from "./perf.js?v=26";
import { FloodSim, MODE_DEPTH, MODE_MAXDEPTH, MODE_SPEED, MODE_TERRAIN } from "./sim.js?v=26";
import { ThreeView } from "./view3d.js?v=23";
import { CesiumView } from "./view3d_cesium.js?v=30";
import { DeckView } from "./view3d_deck.js?v=29";
import { extractChannels } from "./river.js?v=2";

const Z15 = 15;
const EARTH = 40075016.686;
const OVERVIEW_FACTOR = 4;      // overview px = 4 × z15 px
const TILE_PX = 256;
const MAX_DIM = 4600;           // per-axis sim grid cap (cells)
const MAX_CELLS = 20e6;         // total sim grid cap

const LOCATIONS = [
  { name: "名古屋駅", lon: 136.8817, lat: 35.1709 },
  { name: "栄", lon: 136.9066, lat: 35.1700 },
  { name: "千種駅", lon: 136.9306, lat: 35.1702 },
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

// 3D region presets: ~7 x 5.5 km boxes (z15 px). The 9/8 entry is the wettest
// city-core area of the MSM-calibrated observed-rain scenario for 2026-09-08
// (lon 136.7800 / lat 35.1990, along the Shonai river, Nishi-ku side).
const REGIONS = [
  { name: "名古屋駅周辺", lon: 136.8817, lat: 35.1709, halfW: 900, halfH: 700 },
  { name: "名古屋駅・栄周辺", lon: 136.8942, lat: 35.1705, halfW: 1100, halfH: 800 },
  { name: "栄", lon: 136.9066, lat: 35.1700, halfW: 900, halfH: 700 },
  { name: "名古屋大学周辺", lon: 136.9667, lat: 35.1546, halfW: 900, halfH: 700 },
  { name: "千種駅周辺", lon: 136.9306, lat: 35.1702, halfW: 900, halfH: 700 },
  { name: "9/8 降雨ピーク域 (西区周辺)", lon: 136.7800, lat: 35.1990, halfW: 900, halfH: 700, scenario: "rain_20260908_msm.json" },
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
let mapReady = false;
let mapDemTex = null, mapStreamsTex = null, mapBldgTex = null;
let mapLayers = { bldg: true, streams: true };
let streamsImg = null;         // 分水域・流路オーバーレイ画像 (3Dビュワー共通)
let riverOn = true;            // 河川氾濫モデル (1D河道→2D溢水)
let observedList = [];   // [{kind, button, entry, sc}] in index.json order
let observedReady = null; // loadObservedScenarios() の完了プロミス
// 3Dビュワー (three.js / deck.gl / CesiumJS) の種別とインスタンス。
// すべて setRegion/updateWater 等の共通インターフェースを持つ。
const qs = new URLSearchParams(location.search);

/** ソフトウェアレンダリング環境 (SwiftShader/llvmpipe等) の簡易検出。
 * GPUが無い環境では重い既定構成が実用にならないため、軽量既定に倒す判定に使う。 */
function detectSoftwareGL() {
  try {
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl2") || cv.getContext("webgl");
    if (!gl) return true;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "");
    return /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
  } catch {
    return false;
  }
}

// ?lite=1: deck.gl軽量プリセット (lod=1, photo=0, bldg=0, terrain=low) の一括指定。
// ソフトウェアレンダリング環境では既定で有効 (?lite=0 で解除)。
// 個別パラメータ (?photo= 等) が明示されていればそちらを優先する。
const liteDefault = qs.get("lite") === "1" || (qs.get("lite") !== "0" && detectSoftwareGL());
if (liteDefault && qs.get("lite") !== "1") {
  console.info("ソフトウェアレンダリング環境を検出: 軽量3D既定を適用します (?lite=0 で解除)");
}
let view3dKind = ["three", "deck", "cesium"].includes(qs.get("3d"))
  ? qs.get("3d") : (liteDefault ? "deck" : "cesium");
const photoDefault = qs.has("photo") ? qs.get("photo") !== "0" : !liteDefault;
const bldgParam = qs.get("bldg");
const bldgDefault = bldgParam != null ? bldgParam !== "0" : !liteDefault;
let bldgSrc = bldgParam === "simple" || bldgParam === "plateau"
  ? bldgParam
  : (liteDefault ? "simple" : "plateau");   // deck.gl 建物ソース (liteではローカル箱)
let terrainQuality = ["low", "medium", "high"].includes(qs.get("terrain") || "")
  ? qs.get("terrain") : (liteDefault ? "low" : "high");        // deck.gl 地形クオリティ
let deckLod = qs.get("lod") === "1" || qs.get("lod") === "2"
  ? qs.get("lod") : (liteDefault ? "1" : "2");                 // PLATEAU建物LOD (deck.gl)
const view3ds = { three: null, deck: null, cesium: null };
let view3d = null, view3dOn = false, frameNo = 0;
let regionInfo = null;   // {terrain, bldg, W, H, dx} of the current sim grid
const perfHud = new PerfHud();
perfHud.setView({ getFrameCount: () => 0, name: "2D", getPerf: () => ({}) });
bindBenchHandle(() => view3d);

// ---------- timeline (seek + history graphs) ----------
const tl = {
  cps: [],          // [{t, buf}] checkpoints (compact Uint16), newest last
  nextCp: 0, interval: 0, maxCp: 1,
  hist: { t: [], rain: [], area: [], vol: [] },
  sampleDt: 5, lastSample: -10, lastDraw: 0,
  drag: false, target: 0, seeking: false,

  /** (Re)initialise for the current scenario / grid. */
  reset() {
    this.cps = [];
    this.hist = { t: [], rain: [], area: [], vol: [] };
    this.lastSample = -10;
    this.target = sim.time;
    const end = Math.max(sim.endTime(), 1);
    const bytesPer = sim.W * sim.H * 16;
    this.maxCp = clamp(Math.floor(192e6 / bytesPer), 1, 24);
    this.interval = end / this.maxCp;
    this.nextCp = this.interval;
    this.sampleDt = Math.max(1, end / 400);
  },

  /** Sample and store current stats. */
  pushSample(time) {
    if (!sim || !sim.stats) return;
    const h = this.hist;
    const t = isFinite(time) ? time : sim.time;
    // truncate after a backward seek
    while (h.t.length && h.t[h.t.length - 1] > t) { h.t.pop(); h.rain.pop(); h.area.pop(); h.vol.pop(); }
    const st = sim.stats;
    const rate = sim.rainSeries ? sim.rainRateAt(Math.min(t, sim.rainEnd)) : (sim.params?.rain || 0);
    h.t.push(t); h.rain.push(rate); h.area.push(st.a5 / 1e6); h.vol.push(st.volume);
    this.lastSample = t;
    const maxPts = 600;
    if (h.t.length > maxPts) { h.t.splice(0, h.t.length - maxPts); h.rain.splice(0, h.rain.length - maxPts); h.area.splice(0, h.area.length - maxPts); h.vol.splice(0, h.vol.length - maxPts); }
  },
};

const lonToX = (lon, z) => (lon + 180) / 360 * 2 ** z;
const latToY = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * 2 ** z;
};
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/** 河道マスクから分水域・流路オーバーレイ用のキャンバスを作る (row0=北)。 */
function streamsCanvasFromField(field, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  const px = img.data;
  for (let i = 0; i < w * h; i++) {
    if (!field.mask[i]) continue;
    const o = i * 4;
    // 集水域の大きさで濃さを変える (太い川ほど濃い青)
    const km2 = field.area[i] / 1e6;
    const a = Math.min(0.85, 0.35 + km2 / 60);
    px[o] = 40; px[o + 1] = 120; px[o + 2] = 200;
    px[o + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Compute the river-channel field for the current grid and upload it. */
function applyRiverField(terrainData, w, h, dx) {
  if (!sim) return;
  if (!riverOn) { sim.setRiverField(null); streamsImg = null; return; }
  try {
    // terrainData may be ImageData (from getImageData) or Uint8Array
    const px = terrainData instanceof ImageData ? terrainData.data : terrainData;
    const field = extractChannels(px, w, h, dx);
    sim.setRiverField(field);
    // このリージョンの河道から流路オーバーレイを生成 (リプレイ画像の流用をやめる)
    streamsImg = streamsCanvasFromField(field, w, h);
    if (view3ds.three) view3ds.three.setStreamsCanvas(streamsImg);
    if (view3ds.deck) view3ds.deck.setStreamsCanvas(streamsImg);
    if (view3ds.cesium) view3ds.cesium.setStreamsCanvas(streamsImg);
  } catch (e) {
    console.warn("river field failed", e);
    sim.setRiverField(null);
  }
}

function init() {
  const canvas = $("gl");
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    toast("GPUコンテキストが失われました。再読み込みしてください");
  });
  try {
    sim = new FloodSim(canvas);
    window.__sim = sim;
    window.__tl = tl;
    window.__playback = playback;
  } catch (err) {
    toast(err.message, 15000);
    return;
  }

  fetch("meta.json").then((r) => r.json()).then((m) => {
    meta = m;
    window.__meta = m;
    window.__overviewFactor = OVERVIEW_FACTOR;
    setupMap();
    requestAnimationFrame(loop);
  }).catch(() => toast("meta.json を読み込めません。`python -m flood_nagoya build` を実行してください"));

  // 初回起動ダイアログ: 起動オプションを選ばせる (localStorageで記憶)
  // ダイアログ表示中は既定シーン (栄リプレイ/フォールバック) を自動開始しない。
  // ユーザーの選択がシーンを決める。範囲を自分で選ぶ場合のみ既定シーンを
  // 背景として立ち上げる。
  const welcomeDlg = $("welcomeDlg");
  const welcomeSeen = localStorage.getItem("flood-nagoya-welcome-seen");
  if (!welcomeSeen && welcomeDlg) {
    welcomeDlg.showModal();
    let chosen = false;
    for (const btn of welcomeDlg.querySelectorAll(".welcome-opt")) {
      btn.addEventListener("click", () => {
        chosen = true;
        const action = btn.dataset.action;
        const regionIdx = btn.dataset.region;
        if ($("welcomeSkip").checked) localStorage.setItem("flood-nagoya-welcome-seen", "1");
        welcomeDlg.close();
        if (regionIdx != null) {
          const reg = REGIONS[Number(regionIdx)];
          if (reg) startRegionSim(reg);
        } else if (action === "city") {
          $("cityBtn")?.click();
        } else if (action === "replay") {
          const first = document.querySelector("#replayList button");
          if (first) first.click();
          else toast("リプレイデータがありません。`python -m flood_nagoya precompute` を実行してください");
        } else {
          // "map" など: 範囲選択の背景として既定シーンを立ち上げる
          startDefaultScene();
        }
      });
    }
    // Esc や backdrop で選ばずに閉じた場合も、地図の背景として既定シーンを出す。
    welcomeDlg.addEventListener("close", () => {
      if (!chosen) startDefaultScene();
    });
  }
  // 事前計算リプレイのカタログ (あれば地図パネルにボタン一覧を出す)
  playback.available().then((ok) => {
    if (!ok) return;
    $("replaySection").hidden = false;
    const list = $("replayList");
    list.innerHTML = "";
    for (const d of playback.dirs) {
      const m = playback.metas[d];
      const b = document.createElement("button");
      b.className = "wide";
      b.style.marginBottom = "6px";
      b.innerHTML = `<b>${m.label || "栄"}</b><span style="font-weight:400;color:var(--text-dim)"> — ${m.name}</span>`;
      b.onclick = () => {
        if (playback.on && playback.dir === d) { toast("リプレイ再生中です"); return; }
        startPlayback(d);
      };
      list.appendChild(b);
    }
    $("replayHint").textContent = "事前計算済みのリプレイです。ワンクリックで再生。降雨シナリオのカードでも降雨を切替できます。";
  });
  wireUI();
  for (const id of ["rain", "duration", "drain", "infil", "manning", "speed"]) updateSliderFill($(id));
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  observedReady = loadObservedScenarios();
}

function resizeCanvas() {
  const canvas = $("gl");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
}

/** Compose GSI aerial-photo tiles (ort) over the region into one canvas.
 *  The zoom is lowered until the tile count fits MAX_PHOTO_TILES, so wide
 *  regions still get a (coarser) drape instead of none. */
const MAX_PHOTO_TILES = 200;

async function fetchPhotoCanvas(left, top, w, h, zoom) {
  let k = 1, ax = 0, ay = 0, wpx = 0, hpx = 0, tx0 = 0, tx1 = 0, ty0 = 0, ty1 = 0;
  for (let z = zoom; z >= 10; z--) {
    k = 2 ** (z - Z15);
    ax = (meta.tile_range.x0 * TILE_PX + left) * k;
    ay = (meta.tile_range.y0 * TILE_PX + top) * k;
    wpx = Math.max(1, Math.round(w * k));
    hpx = Math.max(1, Math.round(h * k));
    tx0 = Math.floor(ax / TILE_PX); tx1 = Math.floor((ax + wpx - 1) / TILE_PX);
    ty0 = Math.floor(ay / TILE_PX); ty1 = Math.floor((ay + hpx - 1) / TILE_PX);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_PHOTO_TILES) { zoom = z; break; }
  }
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > MAX_PHOTO_TILES) return null;
  // resolution cap: never build a canvas larger than ~4M px
  const scale = Math.min(1, Math.sqrt(4e6 / Math.max(wpx * hpx, 1)));
  wpx = Math.max(1, Math.round(wpx * scale));
  hpx = Math.max(1, Math.round(hpx * scale));
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
      const s = wpx / (w * k);   // canvas scale factor
      ctx.drawImage(img, (tx * TILE_PX - ax) * s, (ty * TILE_PX - ay) * s,
        TILE_PX * s, TILE_PX * s);
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

/** True when an RGBA byte array carries any non-zero channel. */
function hasAny(data, cells) {
  for (let i = 0; i < cells; i++) {
    const o = i * 4;
    if (data[o] | data[o + 1] | data[o + 2]) return true;
  }
  return false;
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
    if (meta.overview_bldg) {
      try { mapBldgTex = sim.makeTexFromImage(await loadImage("overview/bldg.png")); } catch { mapBldgTex = null; }
    }
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

  // ダイアログが開いている間は既定シーンを始めない (ユーザーの選択を待つ)。
  // ダイアログを出さない場合 (2回目以降) は従来どおり自動開始する。
  if (!$("welcomeDlg")?.open) startDefaultScene();
}

/** 起動時の既定シーン: 栄エリアの事前計算リプレイ (無ければライブ計算でフォールバック)。 */
function startDefaultScene() {
  if (startDefaultScene.done || !meta) return;
  // deep link: ?region=<index|name substring> opens a preset region in 3D
  const rq = new URLSearchParams(location.search).get("region");
  if (rq) {
    startDefaultScene.done = true;
    const idx = Number.parseInt(rq, 10);
    const reg = Number.isNaN(idx)
      ? REGIONS.find((x) => x.name.includes(rq))
      : REGIONS[idx];
    if (reg) { startRegionSim(reg); return; }
  }
  if (location.search.includes("demo")) return;
  startDefaultScene.done = true;
  playback.available().then((ok) => {
    if (ok) { startPlayback(); return; }
    // フォールバック: 事前計算データが無い環境では栄中心をライブ計算する
    const SAKAI = LOCATIONS.find((l) => l.name === "栄");
    const cx = (lonToX(SAKAI.lon, Z15) - meta.tile_range.x0) * TILE_PX;
    const cy = (latToY(SAKAI.lat, Z15) - meta.tile_range.y0) * TILE_PX;
    const halfW = 900, halfH = 700;  // ≒ 7.0 × 5.5 km
    const r = mapRectToZ15({
      x0: (cx - halfW) / OVERVIEW_FACTOR, y0: (cy - halfH) / OVERVIEW_FACTOR,
      x1: (cx + halfW) / OVERVIEW_FACTOR, y1: (cy + halfH) / OVERVIEW_FACTOR,
    });
    startSimFromRect(r).then(() => {
      if (!view3dOn) set3d(true);
      if (location.search.includes("noff")) { sim.paused = true; return; }  // 検証用
      const refresh = () => {
        if (view3d) {
          view3d.updateWater(sim.readState());
          view3d.ensureFrame?.();
        }
      };
      // 最初の10分はフレーム分割でウォームアップし、UIをブロックしない
      let done = 0;
      const total = 12000;
      const warm = () => {
        const n = Math.min(600, total - done);
        for (let i = 0; i < n; i++) sim.step(0.05);
        done += n;
        refresh();
        if (done < total) {
          if (done % 2400 === 0) toast(`ウォームアップ中… ${Math.round(done / total * 100)}%`);
          requestAnimationFrame(warm);
        } else {
          toast("準備完了 — シミュレーション実行中");
        }
      };
      requestAnimationFrame(warm);
    });
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
  ctx.strokeStyle = "#4ac3f0";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.forEach(([t, r], i) => {
    const x = 1 + t / tEnd * (w - 2);
    const y = h - 2 - r / maxRate * (h - 5);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/** 既定の観測降雨 (AMeDAS実測) をライブ適用する。
 * リプレイには切替えない — ユーザーが選んだリージョンを保持するため。
 * Returns true when an observed scenario was applied. */
function applyDefaultRain() {
  const obs = observedList.find((o) => o.kind === "observed-rain");
  if (obs && obs.sc) { applyScenarioLive(obs.sc, obs.entry); setActiveScenario(obs.button); return true; }
  return false;
}

async function loadObservedScenarios() {
  let entries;
  try {
    entries = await (await fetch("scenarios/index.json")).json();
  } catch {
    return;   // no observed scenarios generated
  }
  $("observedSection").hidden = false;
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
    b.onclick = async () => {
      setActiveScenario(b);
      // クリックした降雨に対応するリプレイがあればそこへ切替/再生
      const hasCatalog = await playback.available();
      const dir = hasCatalog ? playback.dirForScenario(entry.file) : null;
      if (playback.on) {
        if (dir && dir !== playback.dir) {
          await startPlayback(dir);
          return;
        }
        // 同じ降雨: 最初から再生し直す
        sim.paused = false;
        playback.applyTime(0, true);
        syncPlay();
        drawBar();
        toast("リプレイを最初から再生します");
        return;
      }
      if (dir) {
        await startPlayback(dir);
        return;
      }
      applyScenarioLive(sc, entry);
      setActiveScenario(b);
    };
    observedList.push({ kind: sc.kind, button: b, entry, sc });
    holder.appendChild(b);
  }
}

/** 観測シナリオを現在のライブシミュレーションに適用する (リプレイには切替えない)。
 * observed-rain はハイエトグラフ、それ以外 (msm/xrain) は空間分布フレームで駆動。 */
function applyScenarioLive(sc, entry) {
  if (sc.kind === "observed-rain") {
    rainFrames.stop();
    sim.startHyetograph(sc.series);
    tl.reset();
    toast(`観測降雨を再現中: ${entry.name} — 実測ハイエトグラフで駆動 (降雨スライダーは無効)`);
  } else {
    if (!regionInfo) { toast("先にシミュレーション範囲を選んでください"); return; }
    rainFrames.load(sc);
    tl.reset();
    toast(`観測降雨 (空間分布) を再現中: ${entry.name} — ${sc.source || entry.desc}`);
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

  /** Bind the frame matching the current model time, prefetching ahead. */
  update() {
    if (!this.sc || !sim.spatialRain) return;
    const idx = clamp(Math.floor(sim.time / this.sc.frame_seconds), 0, this.sc.frames.length - 1);
    // Prefetch the next few frames so the texture is ready before its minute.
    for (let k = 1; k <= 3; k++) this.fetch(idx + k);
    if (idx === this.current) return;
    const cached = this.cache.get(idx);
    if (cached) { this.current = idx; sim.setRainTexture(cached); return; }
    this.fetch(idx, true);
  },

  /** Load one frame into the texture cache (optionally binding it). */
  fetch(idx, bind = false) {
    if (!this.sc || idx < 0 || idx >= this.sc.frames.length) return;
    if (this.cache.has(idx) || this.loading.has(idx)) return;
    this.loading.add(idx);
    const meta = this.sc.frames[idx];
    const dir = this.sc.file.replace(/\.json$/, "");
    if (bind) toast(`降雨フレーム読み込み中… (${idx + 1}/${this.sc.frames.length})`);
    loadImage(`scenarios/${dir}/${meta.file}`).then((img) => {
      this.loading.delete(idx);
      if (!this.sc || !sim.spatialRain) return;
      this.cache.set(idx, sim.makeTexFromImage(img));
      while (this.cache.size > 32) {
        const oldest = this.cache.keys().next().value;
        if (oldest === this.current) break;   // never evict the bound frame
        sim.gl.deleteTexture(this.cache.get(oldest));
        this.cache.delete(oldest);
      }
      if (bind || idx === Math.floor(sim.time / this.sc.frame_seconds)) {
        this.current = idx;
        sim.setRainTexture(this.cache.get(idx));
      }
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
  sim.bldgTex = (mapLayers.bldg && mapBldgTex) ? mapBldgTex : sim.emptyTex(meta.overviewPx.w, meta.overviewPx.h);
  sim.streamsTex = mapLayers.streams ? mapStreamsTex : null;
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
  // 選択済みシミュレーション範囲を赤枠で囲む (region px -> overview px -> screen)
  const ro = $("regionOutline");
  if (regionInfo && mode === "map") {
    const k = regionInfo.dx / meta.overviewMPerPx;   // region px per overview px
    const x0 = (regionInfo.left * k - mapView.x) * mapView.z + canvas.width / 2;
    const y0 = canvas.height - ((regionInfo.top * k - mapView.y) * mapView.z + canvas.height / 2);
    const x1 = ((regionInfo.left + regionInfo.W) * k - mapView.x) * mapView.z + canvas.width / 2;
    const y1 = canvas.height - (((regionInfo.top + regionInfo.H) * k - mapView.y) * mapView.z + canvas.height / 2);
    ro.hidden = false;
    ro.style.left = (Math.min(x0, x1) / dpr) + "px";
    ro.style.top = (Math.min(y0, y1) / dpr) + "px";
    ro.style.width = (Math.abs(x1 - x0) / dpr) + "px";
    ro.style.height = (Math.abs(y1 - y0) / dpr) + "px";
  } else {
    ro.hidden = true;
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

/** Select a wide region around a place and open it in 3D.
 * reg.scenario があれば、その観測降雨シナリオをライブ適用する
 * (例: 洪水被害地域 → 9/8 MSM空間降雨で河川氾濫を再現)。 */
async function startRegionSim(reg) {
  if (!meta) return;
  const { x0, y0 } = meta.tile_range;
  const cx = (lonToX(reg.lon, Z15) - x0) * TILE_PX;
  const cy = (latToY(reg.lat, Z15) - y0) * TILE_PX;
  const r = mapRectToZ15({
    x0: (cx - reg.halfW) / OVERVIEW_FACTOR, y0: (cy - reg.halfH) / OVERVIEW_FACTOR,
    x1: (cx + reg.halfW) / OVERVIEW_FACTOR, y1: (cy + reg.halfH) / OVERVIEW_FACTOR,
  });
  await startSimFromRect(r);
  if (!view3dOn) set3d(true);
  // 地域に紐づく観測シナリオをライブ適用 (リプレイには切替えない)。
  // シナリオ一覧の読み込みが終わっていなければ待つ。
  if (reg.scenario) {
    if (observedReady) await observedReady;
    const o = observedList.find((x) => x.entry.file === reg.scenario);
    if (o?.sc) applyScenarioLive(o.sc, o.entry);
  }
}

// ---------- precomputed flood replay (栄エリアの事前計算結果の再生) ----------

/** Decode a precomputed frame pair into a state array (row 0 = south).
 * frame: R=depth cm, G/B=(qE/qS×100)+128, A=255; maximg: gray = cumulative
 * max depth cm. Data must never ride in RGB under low alpha because canvas
 * decoding premultiplies. */
function decodeFrame(img, maxImg, W, H) {
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  let mx = null;
  if (maxImg) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(maxImg, 0, 0, W, H);
    mx = ctx.getImageData(0, 0, W, H).data;
  }
  const arr = new Float32Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const src = (H - 1 - j) * W * 4;   // PNG row 0 = north; state row 0 = south
    const dst = j * W * 4;
    for (let i = 0; i < W * 4; i += 4) {
      arr[dst + i] = d[src + i] / 100;
      arr[dst + i + 1] = (d[src + i + 1] - 128) / 100;
      arr[dst + i + 2] = (d[src + i + 2] - 128) / 100;
      arr[dst + i + 3] = mx ? mx[src + i] / 100 : 0;
    }
  }
  return arr;
}

/** imageData (W×H) from an <img>, matching the sim texture encoding. */
function imageDataFromImage(img, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

const playback = {
  on: false,
  dir: null,
  metas: {},             // dir -> meta.json の中身
  dirs: [],              // 利用可能なリプレイ (index.json 順)
  cur: -1,
  cache: new Map(),      // idx -> Float32Array
  loading: new Set(),    // idx -> in-flight

  /** Fetch (once) the replay catalogue and each meta.json. */
  available() {
    // 同時呼び出しは進行中のロードを共有する。dirs が途中まで埋まった状態で
    // true を返すと this.dir が未設定 (= playback.meta が null) になり、
    // startPlayback が静かに return する (起動時リプレイが開始しない)。
    if (!this._ready) this._ready = this._loadCatalog();
    return this._ready;
  },

  async _loadCatalog() {
    let entries = null;
    try {
      entries = await (await fetch("precomputed/index.json")).json();
    } catch { }
    if (!entries) {
      // 旧構成のフォールバック: sakai 固定
      try {
        this.metas.sakai = await (await fetch("precomputed/sakai/meta.json")).json();
        this.dirs.push("sakai");
      } catch {
        return false;
      }
      this.dir = "sakai";
      return true;
    }
    for (const e of entries) {
      try {
        const m = await (await fetch(`precomputed/${e.dir}/meta.json`)).json();
        if (!m.scenario) m.scenario = e.scenario;
        this.metas[e.dir] = m;
        this.dirs.push(e.dir);
      } catch { }
    }
    if (!this.dirs.length) return false;
    this.dir = this.dirs[0];
    return true;
  },

  /** Replay dir whose precomputed scenario matches the given file. */
  dirForScenario(scenarioFile) {
    return this.dirs.find((d) => this.metas[d].scenario === scenarioFile) || null;
  },

  get meta() {
    return this.dir ? this.metas[this.dir] : null;
  },

  /** Nearest frame index for model time t. */
  frameAt(t) {
    const times = this.meta.times;
    let lo = 0, hi = times.length - 1;
    if (t <= times[0]) return 0;
    if (t >= times[hi]) return hi;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (times[m] <= t) lo = m; else hi = m;
    }
    return (t - times[lo] < times[hi] - t) ? lo : hi;
  },

  /** Decode one frame (state + cumulative max) into the cache. */
  fetch(idx, bind = false) {
    if (!this.dir || idx < 0 || idx >= this.meta.times.length) return;
    if (this.cache.has(idx) || this.loading.has(idx)) return;
    this.loading.add(idx);
    const { w, h } = this.meta.grid;
    const pad = String(idx).padStart(4, "0");
    Promise.all([
      loadImage(`precomputed/${this.dir}/frame_${pad}.png`),
      loadImage(`precomputed/${this.dir}/max_${pad}.png`).catch(() => null),
    ]).then(([img, maxImg]) => {
      this.loading.delete(idx);
      this.cache.set(idx, decodeFrame(img, maxImg, w, h));
      while (this.cache.size > 48) {
        const oldest = this.cache.keys().next().value;
        if (oldest === this.cur) break;
        this.cache.delete(oldest);
      }
      if (bind || idx === this.frameAt(sim.time)) this.bind(idx);
    }).catch(() => this.loading.delete(idx));
  },

  /** Upload a cached frame to the sim texture + 3D water. */
  bind(idx) {
    const arr = this.cache.get(idx);
    if (!arr) return;
    this.cur = idx;
    sim.setStateFrame(arr);
    if (view3d && view3dOn) view3d.updateWater(arr);
  },

  /** Move the replay to model time t (frame-snapped, textures lazy-loaded). */
  applyTime(t, force = false) {
    if (!this.meta) return;
    sim.time = t;
    const idx = this.frameAt(t);
    if (force || idx !== this.cur) {
      const cached = this.cache.get(idx);
      if (cached) this.bind(idx);
      else this.fetch(idx, true);
    }
    for (let k = 1; k <= 3; k++) { this.fetch(idx + k); this.fetch(idx - k); }
  },

  reset() {
    this.cur = -1;
    this.cache.clear();
    this.loading.clear();
  },
};

async function startPlayback(dir) {
  const ok = await playback.available();
  if (ok && dir) playback.dir = dir;
  const m = playback.meta;
  if (!ok || !m || !meta) return;
  const r = { left: m.bounds_px.left, top: m.bounds_px.top, w: m.bounds_px.w, h: m.bounds_px.h };
  const kmW = r.w * meta.z15MPerPx / 1000, kmH = r.h * meta.z15MPerPx / 1000;
  toast(`リプレイデータを読み込み中… ${kmW.toFixed(1)}×${kmH.toFixed(1)} km`);
  try {
    const full = await loadRegionTiles(r);
    regionInfo = full;
    regionInfo.stateW = m.grid.w;
    regionInfo.stateH = m.grid.h;
    const [terrImg, bldgImg] = await Promise.all([
      loadImage(`precomputed/${playback.dir}/terrain.png`),
      loadImage(`precomputed/${playback.dir}/bldg.png`).catch(() => null),
    ]);
    const terr2 = imageDataFromImage(terrImg, m.grid.w, m.grid.h);
    const bldg2 = bldgImg ? imageDataFromImage(bldgImg, m.grid.w, m.grid.h).data : null;
    // 分水域・流路オーバーレイ (2D + 3D共通の画像)
    loadImage(`precomputed/${playback.dir}/streams.png`).then((img) => {
      sim.streamsTex = sim.makeTexFromImage(img);
      sim.streamsOverlay = $("streamsSimToggle").checked;
      streamsImg = img;
      if (view3ds.three) view3ds.three.setStreamsCanvas(img);
      if (view3ds.deck) view3ds.deck.setStreamsCanvas(img);
      if (view3ds.cesium) view3ds.cesium.setStreamsCanvas(img);
    }).catch(() => { });
    // 衛星検証オーバーレイ (precomputed/<dir>/validation/ があれば)
    const satImg = (name) => loadImage(`precomputed/${playback.dir}/validation/sat_${name}.png`);
    satImg("swot").catch(() => satImg("nisar")).then((img) => {
      sim.satTex = sim.makeTexFromImage(img);
      sim.satOverlay = $("satSimToggle") ? $("satSimToggle").checked : false;
    }).catch(() => { sim.satTex = null; sim.satOverlay = false; });
    fetch(`precomputed/${playback.dir}/validation/validation.json`).then((r) => r.ok ? r.json() : null).then((v) => {
      if (v && $("satInfo")) {
        const parts = Object.entries(v).map(([k, s]) =>
          `${k.toUpperCase()}: F1=${s.f1.toFixed(3)} (TP=${s.tp} FP=${s.fp} FN=${s.fn})`);
        $("satInfo").textContent = "衛星検証 " + parts.join(" / ");
        $("satInfo").hidden = false;
      }
    }).catch(() => { });

    playback.on = true;
    playback.reset();
    sim.mapMode = false;
    sim.streamsTex = null;
    // map textures are shared references — do not let dispose() delete them
    sim.terrainTex = null;
    sim.bldgTex = null;
    sim.dispose();
    sim.setGrid(m.grid.w, m.grid.h, m.grid.dx, terr2, bldg2);
    applyRiverField(terr2, m.grid.w, m.grid.h, m.grid.dx);
    sim.rainSeries = m.series;
    sim.rainEnd = m.series[m.series.length - 1][0];
    sim.rainLeft = sim.rainEnd;
    sim.time = 0;
    sim.paused = false;
    sim.setParams({ drain: m.params.drain, infil: m.params.infil, manning: m.params.manning, bldgOn: 1 });
    flow.field = null;
    flow.hgrid = null;
    flow.reset();
    sim.view = {
      x: m.grid.w / 2, y: m.grid.h / 2,
      z: Math.min($("gl").width / m.grid.w, $("gl").height / m.grid.h) * 0.98,
    };
    mode = "sim";
    $("mapPanel").hidden = true;
    $("simPanel").hidden = false;
    $("north").hidden = true;
    $("liveOnly").hidden = true;
    activateTab("tab2d");
    tlShowBar(true);
    tl.reset();
    if (!view3dOn) set3d(true);
    else {
      // 3D表示中のリプレイ切替: 新しい地域で地形・建物を組み直す
      activateTab("tab3d");
      applyRegionTo3d();
    }
    // 乾いた導入は飛ばして、浸水が始まった時点 (a5 > 0.3km2) から再生する
    const wetIdx = m.stats.findIndex((s) => s.a5 > 3e5);
    sim.time = wetIdx > 0 ? m.times[wetIdx] : 0;
    playback.applyTime(sim.time, true);   // setRegion後のテクスチャに最初のフレームを流し込む
    // aerial photo drape for the 3D view — 非同期なので、到着時に
    // regionInfo が別リージョンに差し替わっていたら適用しない
    const regionAtFetch = regionInfo;
    fetchPhotoCanvas(r.left, r.top, r.w, r.h, 16).then((photo) => {
      if (photo && regionInfo === regionAtFetch) {
        regionInfo.photo = photo;
        if (view3d && view3dOn) view3d.setPhotoCanvas(photo);
      }
    });
    syncSliderLabels();
    syncPlay();
    toast(`浸水リプレイ: ${m.name} — ${m.desc}`);
  } catch (e) {
    playback.on = false;
    toast("リプレイデータの読み込みに失敗: " + e.message);
  }
}

/** Load and compose full-res terrain/building tiles for a z15 rect. */
async function loadRegionTiles(r) {
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
  let bldg = ctxB.getImageData(0, 0, r.w, r.h);
  // Per-tile building rasters are authoritative, but if every tile failed
  // (or they carry no buildings) fall back to the overview height raster so
  // the region is never left without buildings in 2D/3D.
  if (!hasAny(bldg.data, r.w * r.h)) {
    const fb = await loadImage("overview/bldg.png").catch(() => null);
    if (fb) {
      const c = document.createElement("canvas");
      c.width = r.w; c.height = r.h;
      const cx2 = c.getContext("2d", { willReadFrequently: true });
      // overview px -> z15 px: 1 overview px spans OVERVIEW_FACTOR cells,
      // and the overview origin is the tile-range origin (0,0).
      cx2.imageSmoothingEnabled = false;
      cx2.drawImage(fb, -r.left / OVERVIEW_FACTOR, -r.top / OVERVIEW_FACTOR,
        fb.width * OVERVIEW_FACTOR, fb.height * OVERVIEW_FACTOR);
      bldg = cx2.getImageData(0, 0, r.w, r.h);
    }
  }
  return { terrain: terrain.data, bldg: bldg.data, W: r.w, H: r.h, dx: meta.z15MPerPx, photo: null, left: r.left, top: r.top };
}

async function startSimFromRect(r) {
  const kmW = r.w * meta.z15MPerPx / 1000, kmH = r.h * meta.z15MPerPx / 1000;
  toast(`タイル読み込み中… ${r.w}×${r.h} セル (${kmW.toFixed(1)}×${kmH.toFixed(1)} km)`);
  try {
    const region = await loadRegionTiles(r);
    regionInfo = region;
    if (view3d && view3dOn) applyRegionTo3d();
    fetchPhotoCanvas(r.left, r.top, r.w, r.h, 16).then((photo) => {
      // 到着時に regionInfo が別リージョンに差し替わっていたら適用しない
      if (photo && regionInfo === region) {
        regionInfo.photo = photo;
        if (view3d && view3dOn) view3d.setPhotoCanvas(photo);
      }
    });
    playback.on = false;
    $("liveOnly").hidden = false;
    sim.streamsOverlay = false;
    sim.mapMode = false;
    sim.streamsTex = null;
    // map textures are shared references — do not let dispose() delete them
    sim.terrainTex = null;
    sim.bldgTex = null;
    sim.dispose();
    sim.setGrid(r.w, r.h, meta.z15MPerPx, regionInfo.terrain, regionInfo.bldg);
    applyRiverField(regionInfo.terrain, r.w, r.h, meta.z15MPerPx);
    flow.field = null;
    flow.reset();
    sim.view = {
      x: r.w / 2, y: r.h / 2,
      z: Math.min($("gl").width / r.w, $("gl").height / r.h) * 0.98,
    };
    mode = "sim";
    $("mapPanel").hidden = true;
    $("simPanel").hidden = false;
    $("north").hidden = true;
    activateTab("tab2d");
    tlShowBar(true);
    sim.startScenario(parseFloat($("rain").value), parseInt($("duration").value, 10));
    tl.reset();
    if (!applyDefaultRain())
      toast(`シミュレーション開始 — ${kmW.toFixed(1)}×${kmH.toFixed(1)}km, 解像度${meta.z15MPerPx.toFixed(1)}m (ドラッグでパン・ホイールでズーム)`);
  } catch (e) {
    toast("タイル読み込みに失敗: " + e.message);
  }
}

function startCitySim() {
  if (!meta || !meta.overviewPx) return;
  const ow = meta.overviewPx.w, oh = meta.overviewPx.h;
  Promise.all([
    loadImage("overview/dem.png"),
    loadImage("overview/bldg.png").catch(() => null),
  ]).then(([dem, bldg]) => {
    const comp = document.createElement("canvas");
    comp.width = ow; comp.height = oh;
    const ctx = comp.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(dem, 0, 0);
    const terrain = ctx.getImageData(0, 0, ow, oh);
    let bldgData = null;
    if (bldg) {
      const cb = document.createElement("canvas");
      cb.width = ow; cb.height = oh;
      const ctb = cb.getContext("2d", { willReadFrequently: true });
      ctb.drawImage(bldg, 0, 0);
      bldgData = ctb.getImageData(0, 0, ow, oh).data;
    }
    const region = { terrain: terrain.data, bldg: bldgData, W: ow, H: oh, dx: meta.overviewMPerPx, photo: null, left: 0, top: 0 };
    regionInfo = region;
    if (view3d && view3dOn) applyRegionTo3d();
    fetchPhotoCanvas(0, 0, ow, oh, 13).then((photo) => {
      // 到着時に regionInfo が別リージョンに差し替わっていたら適用しない
      if (photo && regionInfo === region) {
        regionInfo.photo = photo;
        if (view3d && view3dOn) view3d.setPhotoCanvas(photo);
      }
    });
    playback.on = false;
    $("liveOnly").hidden = false;
    sim.streamsOverlay = false;
    sim.mapMode = false;
    sim.streamsTex = null;
    sim.terrainTex = null;
    sim.bldgTex = null;
    sim.dispose();
    sim.setGrid(ow, oh, meta.overviewMPerPx, terrain.data, bldgData);
    applyRiverField(terrain.data, ow, oh, meta.overviewMPerPx);
    flow.field = null;
    flow.reset();
    sim.view = fitView(ow, oh);
    mode = "sim";
    $("mapPanel").hidden = true;
    $("simPanel").hidden = false;
    $("north").hidden = true;
    activateTab("tab2d");
    tlShowBar(true);
    sim.startScenario(parseFloat($("rain").value), parseInt($("duration").value, 10));
    tl.reset();
    if (!applyDefaultRain())
      toast(`名古屋市全域モード (${ow}×${oh} セル, ${meta.overviewMPerPx.toFixed(1)}m解像度)`);
    // fast-forward ~3 min of model time in rAF chunks so water is visible
    let done = 0;
    const total = 3600;
    const warm = () => {
      const n = Math.min(300, total - done);
      for (let i = 0; i < n; i++) sim.step(0.05);
      done += n;
      if (done < total) requestAnimationFrame(warm);
    };
    requestAnimationFrame(warm);
  });
}

function backToMap() {
  mode = "map";
  playback.on = false;
  $("liveOnly").hidden = false;
  if (view3dOn) set3d(false);
  rainFrames.stop();
  $("north").hidden = false;
  $("simPanel").hidden = true;
  $("mapPanel").hidden = false;
  tlShowBar(false);
  sim.dispose();
  // map textures are shared references — do not let dispose() delete them
  sim.terrainTex = null;
  sim.bldgTex = null;
  sim.streamsTex = null;
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
  $("riverToggle").addEventListener("change", (e) => {
    riverOn = e.target.checked;
    // 現在のグリッドで河道フィールドを再計算/解除する
    if (sim && sim.terrainData) applyRiverField(sim.terrainData, sim.W, sim.H, sim.dx);
  });
  $("bldgLayerChk").addEventListener("change", (e) => {
    mapLayers.bldg = e.target.checked;
    if (mode === "map") enterMapView();
  });
  $("streamLayerChk").addEventListener("change", (e) => {
    mapLayers.streams = e.target.checked;
    if (mode === "map") enterMapView();
  });
  $("waveToggle").addEventListener("change", (e) => {
    sim.setParams({ waves: e.target.checked ? 1 : 0 });
    if (view3ds.three) view3ds.three.setWaves(e.target.checked);
  });
  $("flowToggle").addEventListener("change", (e) => {
    flow.setEnabled(e.target.checked);
    if (view3ds.three) view3ds.three.setFlowEnabled(e.target.checked);
    if (view3ds.deck) view3ds.deck.setFlowEnabled(e.target.checked);
    if (view3ds.cesium) view3ds.cesium.setFlowEnabled(e.target.checked);
  });
  $("streamsSimToggle").addEventListener("change", (e) => {
    if (sim) sim.streamsOverlay = e.target.checked;
    if (view3ds.three) view3ds.three.setStreamsVisible(e.target.checked);
    if (view3ds.deck) view3ds.deck.setStreamsVisible(e.target.checked);
    if (view3ds.cesium) view3ds.cesium.setStreamsVisible(e.target.checked);
  });
  if ($("satSimToggle")) $("satSimToggle").addEventListener("change", (e) => {
    if (sim) sim.satOverlay = e.target.checked;
  });
  $("tabMap").addEventListener("click", () => {
    if (mode === "sim") backToMap();
    activateTab("tabMap");
  });
  $("tab2d").addEventListener("click", () => {
    if (mode === "map") { toast("先に範囲を選択、または全域モードを実行してください"); return; }
    set3d(false);
    activateTab("tab2d");
  });
  $("tab3d").addEventListener("click", () => {
    if (mode === "map") { toast("先に範囲を選択、または全域モードを実行してください"); return; }
    set3d(true);
    activateTab("tab3d");
  });
  wireBar();
  $("helpBtn").addEventListener("click", () => {
    toast("地図: ドラッグで範囲選択 / ホイールでズーム / Space+ドラッグでパン。シミュレーション中: ドラッグでパン / Escで地図へ戻る", 9000);
  });
  $("photo3dToggle").checked = photoDefault;
  $("photo3dToggle").addEventListener("change", (e) => {
    if (view3d) view3d.setPhotoVisible(e.target.checked);
  });
  $("bldg3dToggle").checked = bldgDefault;
  $("bldg3dToggle").addEventListener("change", (e) => {
    if (view3d) view3d.setBuildingsVisible(e.target.checked);
  });
  // deck.gl 建物ソース (PLATEAU実寸タイル / 簡易ローカルラスタ箱)
  for (const input of document.querySelectorAll('input[name="bldgsrc"]')) {
    input.addEventListener("change", (e) => {
      bldgSrc = e.target.value;
      view3ds.deck?.setBuildingSource(bldgSrc);
    });
    input.checked = input.value === bldgSrc;
  }
  // 軽量3Dプリセット: deck.glを lod=1 / 写真OFF / 建物OFF / 地形low で起動する
  $("lite3dBtn").addEventListener("click", () => {
    view3dKind = "deck";
    for (const input of document.querySelectorAll('input[name="viewer3d"]')) {
      input.checked = input.value === "deck";
    }
    terrainQuality = "low";
    deckLod = "1";
    bldgSrc = "simple";   // 建物をONにしてもローカル箱で軽い
    for (const input of document.querySelectorAll('input[name="bldgsrc"]')) {
      input.checked = input.value === "simple";
    }
    $("photo3dToggle").checked = false;
    $("bldg3dToggle").checked = false;
    set3d(true);
    toast("軽量3Dプリセットを適用しました (deck.gl / 写真OFF / 建物OFF・簡易 / 地形low / LOD1)");
  });
  // 雨のGPUパーティクル (deck.glビュワーのみ)。?rain=1 で既定ON
  $("rainToggle").checked = qs.get("rain") === "1";
  $("rainToggle").addEventListener("change", (e) => {
    view3ds.deck?.setRainEnabled(e.target.checked);
  });
  $("weatherToggle").addEventListener("change", (e) => {
    view3ds.deck?.setWeatherVisible(e.target.checked);
  });
  $("weatherToggle").checked = qs.get("weather") === "1";
  // 3Dビュワー切替 (three.js / deck.gl / CesiumJS)
  for (const input of document.querySelectorAll('input[name="viewer3d"]')) {
    input.addEventListener("change", (e) => {
      const kind = e.target.value;
      if (kind === view3dKind) return;
      view3dKind = kind;
      if (view3dOn) set3d(true);   // 新しいビュワーで組み直す
      else $("btn3d").classList.remove("active");
    });
    input.checked = input.value === view3dKind;
  }
  // perf HUD切替 (既定: 3D表示中は常時表示 / ?perf=1 で2Dでも)
  $("perfToggle").addEventListener("change", (e) => {
    if (e.target.checked) perfHud.enable();
    else perfHud.disable();
  });
  if ($("perfToggle").checked) perfHud.enable();
  const exagSlider = $("exag");
  if (exagSlider) {
    const fromUrl = Number.parseFloat(new URLSearchParams(location.search).get("exag") || "");
    if (Number.isFinite(fromUrl) && fromUrl > 0) {
      exagSlider.value = String(Math.min(Math.max(fromUrl, 1), 5));
      $("exagVal").textContent = Number(exagSlider.value).toFixed(1) + "×";
    } else {
      exagSlider.value = "2";
      $("exagVal").textContent = "2.0×";
    }
  }
  $("exag").addEventListener("input", () => {
    const v = parseFloat($("exag").value);
    $("exagVal").textContent = v.toFixed(1) + "×";
    if (view3ds.three && regionInfo) {
      view3ds.three.setExag(v);
      view3ds.three.setRegion(regionInfo.W, regionInfo.H, regionInfo.dx,
        regionInfo.terrain, regionInfo.bldg, regionInfo.photo,
        regionInfo.stateW, regionInfo.stateH);
      if (playback.on && playback.cur >= 0 && playback.cache.has(playback.cur)) {
        view3ds.three.updateWater(playback.cache.get(playback.cur));
      }
    }
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
    syncPlay();
  };
  $("resetBtn").onclick = () => {
    if (playback.on) {
      sim.paused = false;
      playback.applyTime(0, true);
      syncPlay();
      drawBar();
      return;
    }
    sim.reset();
    if (sim.rainSeries) sim.startHyetograph(sim.rainSeries);
    else sim.startScenario(parseFloat($("rain").value), parseInt($("duration").value, 10));
    tl.reset();
    sim.paused = true;
    syncPlay();
  };
  $("backBtn").onclick = backToMap;
  $("cityBtn").onclick = startCitySim;
  $("btn3d").onclick = () => set3d(!view3dOn);
  $("zoomIn").onclick = () => zoomView(1.35);
  $("zoomOut").onclick = () => zoomView(1 / 1.35);
  $("shotBtn").onclick = () => {
    // 描画バッファは表示後にクリアされるため、取得直前に再描画する
    let cv;
    if (view3dOn && view3d) {
      view3d.ensureFrame();
      cv = view3d.canvas;
    } else {
      sim.render(mode === "sim" ? renderMode : MODE_TERRAIN);
      cv = $("gl");
    }
    const a = document.createElement("a");
    a.download = `flood-nagoya-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    a.href = cv.toDataURL("image/png");
    a.click();
    toast("スクリーンショットを保存しました");
  };
}

function activateTab(id) {
  for (const t of ["tabMap", "tab2d", "tab3d"]) {
    const on = t === id;
    $(t).classList.toggle("on", on);
    $(t).setAttribute("aria-selected", on ? "true" : "false");
  }
}

/** ズームボタン: 2Dはビュー中心、3Dはカメラターゲット基準で拡縮。 */
function zoomView(f) {
  if (view3dOn && view3d) { view3d.zoomBy(f); return; }
  const v = mode === "map" ? mapView : sim.view;
  v.z = clamp(v.z * f, 0.3, 14);
  if (mode === "map") sim.view = mapView;
}

/** 現在の選択ビュワーを生成する (遅延初期化)。 */
function createView3d(kind) {
  if (kind === "deck") return new DeckView($("gldeck"));
  if (kind === "cesium") return new CesiumView($("cesium3d"));
  const v = new ThreeView($("gl3d"));
  v.name = "three";
  return v;
}

function set3d(on) {
  view3dOn = on;
  activateTab(on ? "tab3d" : "tab2d");
  $("btn3d").classList.toggle("active", on);
  $("btn3dLabel").textContent = on ? "2D表示に戻す" : "3D表示に切り替え";
  if (on) {
    if (!regionInfo) { toast("先にシミュレーション範囲を選んでください"); view3dOn = false; return; }
    if (!view3ds[view3dKind]) view3ds[view3dKind] = createView3d(view3dKind);
    const prev = view3d;
    view3d = view3ds[view3dKind];
    window.__view3d = view3d;
    // 非アクティブなビュワーは描画を止め、canvasを隠す
    for (const k of Object.keys(view3ds)) {
      const v = view3ds[k];
      if (!v) continue;
      v.hide();
      $("gl3d").hidden = k !== "three";
      $("gldeck").hidden = k !== "deck";
      $("cesium3d").hidden = k !== "cesium";
    }
    view3d.show();
    if (prev && prev !== view3d) prev.hide();
    applyRegionTo3d();
    $("gl").style.visibility = "hidden";
    $("view3dOpts").hidden = false;
    $("north").hidden = true;
    for (const loc of LOCATIONS) loc.el.style.display = "none";
    view3d.resize();
    perfHud.setView(view3d);
    // three.js / deck.gl 専用オプションの表示切替
    $("exagCtl").hidden = view3dKind !== "three";
    $("waveCtl").hidden = view3dKind !== "three";
    $("flowCtl").hidden = false;
    $("rainCtl").hidden = view3dKind !== "deck";
    $("weatherCtl").hidden = view3dKind !== "deck";
    $("bldgSrcCtl").hidden = view3dKind !== "deck";
    if (view3dKind === "deck") {
      view3ds.deck.setRainEnabled($("rainToggle").checked);
      view3ds.deck.setPhotoVisible($("photo3dToggle").checked);
      view3ds.deck.setBuildingsVisible($("bldg3dToggle").checked);
      view3ds.deck.setStreamsVisible($("streamsSimToggle").checked);
      if (streamsImg) view3ds.deck.setStreamsCanvas(streamsImg);
      view3ds.deck.setBuildingSource(bldgSrc);
      view3ds.deck.setTerrainQuality(terrainQuality);
      view3ds.deck.setBuildingLoad(deckLod);
      view3ds.deck.setFlowEnabled(flow.on);
    }
    if (view3dKind === "cesium") {
      view3ds.cesium.setPhotoVisible($("photo3dToggle").checked);
      view3ds.cesium.setBuildingsVisible($("bldg3dToggle").checked);
      view3ds.cesium.setStreamsVisible($("streamsSimToggle").checked);
      if (streamsImg) view3ds.cesium.setStreamsCanvas(streamsImg);
      view3ds.cesium.setFlowEnabled(flow.on);
      view3ds.cesium.setLocations(LOCATIONS);
    }
    toast(`3D表示中 (${view3dKind}) — ドラッグで回転・ホイールでズーム・右ドラッグで移動`);
    // ?bench=秒 があれば自動でベンチを走らせる (軽さ比較用)
    const benchSec = Number.parseFloat(qs.get("bench") || "");
    if (Number.isFinite(benchSec) && benchSec > 0 && !window.__benchDone) {
      window.__benchDone = true;
      view3d.ready?.then?.(() => {
        // タイルの初期ロードを少し待ってから計測する
        setTimeout(() => runBench(view3d, benchSec, view3dKind), 3000);
      });
    }
  } else {
    for (const v of Object.values(view3ds)) v?.hide();
    $("gl3d").hidden = true;
    $("gldeck").hidden = true;
    $("cesium3d").hidden = true;
    $("gl").style.visibility = "";
    $("view3dOpts").hidden = true;
    $("north").hidden = false;
  }
}

/** regionInfo を現在の3Dビュワーへ流し込み、リプレイ中の水位を再バインドする。 */
function applyRegionTo3d() {
  if (!view3d || !regionInfo) return;
  const r = regionInfo;
  view3d.setOrigin?.(r.left || 0, r.top || 0);
  view3d.setRegion(r.W, r.H, r.dx, r.terrain, r.bldg, r.photo, r.stateW, r.stateH);
  if (view3ds.three) {
    view3ds.three.setFlowEnabled(flow.on);
    view3ds.three.setStreamsVisible($("streamsSimToggle").checked);
  }
  if (view3ds.deck) {
    view3ds.deck.setStreamsVisible($("streamsSimToggle").checked);
  }
  if (view3ds.cesium) {
    view3ds.cesium.setStreamsVisible($("streamsSimToggle").checked);
  }
  // リプレイ中は region再構築で水位が消えるので、現フレームを再バインドする
  if (playback.on && playback.cur >= 0 && playback.cache.has(playback.cur)) {
    view3d.updateWater(playback.cache.get(playback.cur));
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

/** Paint the filled portion of a range input via the --val custom property. */
function updateSliderFill(el) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const v = (parseFloat(el.value) - min) / Math.max(max - min, 1e-9) * 100;
  el.style.setProperty("--val", v);
}

function syncSliderLabels() {
  $("rainVal").textContent = $("rain").value + " mm/h";
  $("durationVal").textContent = $("duration").value + " 分";
  $("drainVal").textContent = $("drain").value + " mm/h";
  $("infilVal").textContent = $("infil").value + " mm/h";
  $("manningVal").textContent = parseFloat($("manning").value).toFixed(3);
  $("speedVal").textContent = "×" + $("speed").value;
  for (const id of ["rain", "duration", "drain", "infil", "manning", "speed"]) updateSliderFill($(id));
  if (sim && !playback.on) {
    // リプレイ中は事前計算時の条件を変えられないので無視する
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

/** Keep the panel and bottom-bar play buttons in sync with the sim state. */
function syncPlay() {
  if (!sim) return;
  $("pauseLabel").textContent = sim.paused ? "再開" : "一時停止";
  $("pauseBtn").classList.toggle("paused", sim.paused);
  $("tlPlay").classList.toggle("paused", sim.paused);
}

function fmtVol(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " 百万m³";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + " 千m³";
  return v.toFixed(0) + " m³";
}

/** 積算雨量 [mm]: ハイエトグラフ (または一定強度) の時刻 t までの台形積分。 */
function rainAccumAt(t) {
  const s = sim.rainSeries;
  if (!s) return (parseFloat($("rain").value) || 0) * Math.max(t, 0) / 3600;
  let acc = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i][0] <= t) {
      acc += (s[i - 1][1] + s[i][1]) / 2 * (s[i][0] - s[i - 1][0]) / 3600;
    } else {
      acc += (s[i - 1][1] + rainRateAtT(t)) / 2 * Math.max(t - s[i - 1][0], 0) / 3600;
      break;
    }
  }
  return Math.max(acc, 0);
}

function rainRateAtT(t) {
  return sim.rainSeries ? sim.rainRateAt(t) : (parseFloat($("rain").value) || 0);
}

// ---------- timeline (bottom bar 図3風 + flow particles + seek) ----------

/** Bottom timeline bar state (DOM ids: tlPlay/tlBack/tlFwd/tlClock/tlSlider/tlKnob/tlRain/tlRainBar/tlRainHover). */
const bar = {
  drag: false,
  /** pointer x fraction (0..1) on the slider track */
  frac(clientX) {
    const el = $("tlSlider");
    const r = el.getBoundingClientRect();
    return clamp((clientX - r.left - 1) / Math.max(r.width - 2, 1), 0, 1);
  },
};

function tlShowBar(show) {
  $("tlbar").hidden = !show;
  $("legendWrap").hidden = !show;
  // .panelの下端をドックの上に退ける (CSS: body.sim)
  document.body.classList.toggle("sim", show);
}

/** Hyetograph rate (mm/h) used by the rain bar/hover, in model time. */
function tlRainAt(t) {
  if (sim.rainSeries) return sim.rainRateAt(Math.min(t, sim.rainEnd));
  return parseFloat($("rain").value) || 0;
}

function drawBar() {
  const slider = $("tlSlider"), rain = $("tlRain");
  if (!slider || !rain || !sim || !sim.W) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const end = Math.max(sim.endTime(), 1);

  // slider: damage-coloured fill behind the knob
  const sw = slider.clientWidth, sh = slider.clientHeight;
  if (sw && sh) {
    if (slider.width !== Math.round(sw * dpr) || slider.height !== Math.round(sh * dpr)) {
      slider.width = Math.round(sw * dpr); slider.height = Math.round(sh * dpr);
    }
    const ctx = slider.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, sw, sh);
    const hist = tl.hist;
    const areaMax = Math.max(0.05, ...hist.area);
    // base track: cyan groove so the grab area reads as a slider
    ctx.fillStyle = "rgba(61,220,255,0.16)";
    ctx.beginPath();
    ctx.roundRect(0, sh / 2 - 4, sw, 8, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(61,220,255,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // スクラブ中はつまみ・塗りをドラッグ位置に追従させる
    const shownT = tl.drag ? tl.target : sim.time;
    const prog = clamp(shownT / end, 0, 1);
    const pw = prog * (sw - 2) + 1;
    for (let x = 1; x < pw; x++) {
      const t = (x - 1) / (sw - 2) * end;
      let a = 0;
      for (let i = hist.t.length - 1; i >= 0; i--) {
        if (hist.t[i] <= t) { a = hist.area[i] / areaMax; break; }
      }
      const f = clamp(a, 0, 1);
      const r = Math.round(61 + (255 - 61) * f);
      const g = Math.round(220 + (93 - 220) * f);
      const b = Math.round(255 + (93 - 255) * f);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, sh / 2 - 4, 1, 8);
    }
    // knob
    $("tlKnob").style.left = `${prog * 100}%`;
  }

  // rain bar: rainfall heights; hover expands a tooltip graph
  const rw = rain.clientWidth, rh = rain.clientHeight;
  if (rw && rh) {
    if (rain.width !== Math.round(rw * dpr) || rain.height !== Math.round(rh * dpr)) {
      rain.width = Math.round(rw * dpr); rain.height = Math.round(rh * dpr);
    }
    const ctx = rain.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rw, rh);
    // rain bars: 予定ハイエトグラフ全体を最初から描画し、
    // 経過した部分 (ドラッグ中はターゲットまで) を濃く塗る
    const pitch = 4;
    const n = Math.max(10, Math.floor((rw - 2) / pitch));
    const plan = new Array(n + 1);
    let planMax = 5;
    for (let i = 0; i <= n; i++) {
      const v = tlRainAt(i / n * end);
      plan[i] = v;
      if (v > planMax) planMax = v;
    }
    const tShown = tl.drag ? tl.target : sim.time;
    for (let i = 0; i <= n; i++) {
      const x = i / n * (rw - 2) + 1;
      const bh = clamp(plan[i] / planMax, 0, 1) * (rh - 3);
      ctx.fillStyle = (i / n * end <= tShown) ? "rgba(74,195,240,0.9)" : "rgba(74,195,240,0.35)";
      ctx.fillRect(x, rh - 1 - bh, 3, bh);
    }
  }

  // labels
  $("tlClock").textContent = fmtTime(tl.drag ? tl.target : sim.time) + (tl.seeking ? " …" : "");
  $("tlStart").textContent = "0:00";
  $("tlMid").textContent = fmtTime(end / 2);
  $("tlEndBar").textContent = fmtTime(end);
}

/** Tooltip popup over the rain bar (±30 min of rain around hover). */
function tlRainPopup(clientX) {
  const barEl = $("tlRainBar"), tip = $("tlRainHover");
  const r = barEl.getBoundingClientRect();
  const f = clamp((clientX - r.left) / Math.max(r.width, 1), 0, 1);
  const end = Math.max(sim.endTime(), 1);
  const t = f * end;
  const span = 1800;   // +/-30 min window
  const t0 = Math.max(0, t - span), t1 = Math.min(end, t + span);
  const cv = document.createElement("canvas");
  const W = 280, H = 120;
  cv.width = W * 2; cv.height = H * 2;
  cv.style.width = W + "px"; cv.style.height = H + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.fillStyle = "#0d1a22";
  ctx.fillRect(0, 0, W, H);
  const N = 60;
  const vals = [];
  let vmax = 1;
  for (let i = 0; i <= N; i++) {
    const v = tlRainAt(t0 + (t1 - t0) * i / N);
    vals.push(v);
    vmax = Math.max(vmax, v);
  }
  ctx.fillStyle = "rgba(74,195,240,0.85)";
  for (let i = 0; i <= N; i++) {
    const x = 8 + i / N * (W - 16);
    const bh = vals[i] / vmax * (H - 34);
    ctx.fillRect(x, H - 22 - bh, (W - 16) / N - 1, bh);
  }
  ctx.strokeStyle = "#ff5d5d";
  ctx.lineWidth = 1;
  const areaHist = tl.hist;
  if (areaHist.t.length) {
    const amax = Math.max(0.01, ...areaHist.area);
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const tt = t0 + (t1 - t0) * i / N;
      let a = 0;
      for (let j = areaHist.t.length - 1; j >= 0; j--) {
        if (areaHist.t[j] <= tt) { a = areaHist.area[j]; break; }
      }
      const x = 8 + i / N * (W - 16);
      const y = H - 22 - a / amax * (H - 40);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(`${fmtTime(t)}   ${tlRainAt(t).toFixed(1)} mm/h`, 10, 14);
  tip.innerHTML = "";
  tip.appendChild(cv);
  tip.style.left = `${clamp(clientX - r.left, W / 2 + 4, r.width - W / 2 - 4)}px`;
  tip.style.top = "-6px";
  tip.hidden = false;
}

function wireBar() {
  const track = $("tlTrack");
  const posToTime = (clientX) => bar.frac(clientX) * Math.max(sim.endTime(), 1);
  track.addEventListener("pointerdown", (e) => {
    if (tl.seeking) { seekToken++; tl.seeking = false; }   // 進行中のシークを中断して引き取る
    tl.drag = true;
    tl.target = posToTime(e.clientX);
    track.setPointerCapture(e.pointerId);
    drawBar();
  });
  track.addEventListener("pointermove", (e) => {
    if (!tl.drag) return;
    tl.target = posToTime(e.clientX);
    drawBar();
  });
  const finish = () => {
    if (!tl.drag) return;
    tl.drag = false;
    seekTo(tl.target);
  };
  track.addEventListener("pointerup", finish);
  track.addEventListener("pointercancel", () => { tl.drag = false; drawBar(); });
  $("tlPlay").onclick = () => {
    sim.paused = !sim.paused;
    syncPlay();
  };
  $("tlBack").onclick = () => seekTo(sim.time - 30);
  $("tlFwd").onclick = () => seekTo(sim.time + 30);
  const rainBar = $("tlRainBar");
  rainBar.addEventListener("pointermove", (e) => {
    tlRainPopup(e.clientX);
  });
  rainBar.addEventListener("pointerleave", () => { $("tlRainHover").hidden = true; });
}

let seekToken = 0;   // 新しいシークが来たら古いシークループを中断する

function seekTo(t) {
  if (!sim || !sim.W) return;
  if (playback.on) {
    // リプレイは即時シーク
    const end = playback.meta.times[playback.meta.times.length - 1];
    sim.time = clamp(t, 0, end);
    playback.applyTime(sim.time, true);
    sim.computeStats();
    drawBar();
    return;
  }
  const end = Math.max(sim.endTime(), 1);
  t = clamp(t, 0, end);
  if (Math.abs(t - sim.time) < 0.02) return;
  const wasPaused = sim.paused;
  tl.seeking = true;
  const token = ++seekToken;
  sim.paused = true;
  syncPlay();
  if (t < sim.time) {
    let best = null;
    for (const cp of tl.cps) if (cp.t <= t + 1e-6 && (!best || cp.t > best.t)) best = cp;
    if (best) sim.restoreCheckpoint(best.buf, best.t);
    else sim.reset();
    tl.lastSample = -10;
  }
  const cells = sim.W * sim.H;
  const chunk = Math.max(120, Math.round(1200 * Math.min(1, 2.5e6 / cells)));
  const stepSeek = () => {
    if (token !== seekToken) return;   // 新しいドラッグ/シークに中断された
    for (let i = 0; i < chunk && sim.time + 0.02 < t; i++) sim.step(0.05);
    rainFrames.update();
    sim.computeStats();
    if (sim.time >= tl.lastSample + tl.sampleDt) tl.pushSample();
    drawBar();
    if (sim.time + 0.02 < t) {
      requestAnimationFrame(stepSeek);
    } else {
      tl.seeking = false;
      sim.paused = wasPaused;
      syncPlay();
      flowReadState();   // seek後の流速場で粒子を張り直す
      drawBar();
      toast(`時刻 ${fmtTime(sim.time)} に移動しました`);
    }
  };
  requestAnimationFrame(stepSeek);
}

/** Take a checkpoint when the interval elapsed (skipped while seeking). */
function tlCaptureIfDue() {
  if (tl.seeking || playback.on || !sim || !sim.W) return;
  if (sim.time < tl.nextCp) return;
  // skip checkpoints for grids >3M cells (readPixels hitch too long)
  if (sim.W * sim.H * 16 > 48e6) { tl.nextCp = 1e20; return; }
  tl.cps.push({ t: sim.time, buf: sim.captureCheckpoint() });
  while (tl.cps.length > tl.maxCp) tl.cps.shift();
  tl.nextCp = sim.time + tl.interval;
}

// ---------- flow particles (earth 風の流れ線) ----------
// CPU particles advected by the sim's q field (read back at 1/16 res).

const flow = {
  on: true,
  parts: [],
  field: null,      // {qx, qy} at fieldRes
  hgrid: null,      // depth at fieldRes (湿ったセルへの再配置用)
  fieldW: 0, fieldH: 0, gw: 0, gh: 0,
  lastRead: 0,
  seed: 0,

  setEnabled(v) {
    this.on = v;
    $("flow").hidden = !v || mode !== "sim" || view3dOn;
  },

  reset(n) {
    this.parts = [];
    const count = n || flowCountFor();
    for (let i = 0; i < count; i++) {
      this.parts.push({ x: Math.random(), y: Math.random(), age: Math.random() * 60 });
    }
  },
};

function flowCountFor() {
  const a = innerWidth * innerHeight;
  return clamp(Math.round(a / 7000), 300, 2000);
}

/** Thin the full state to a 1/16 velocity grid (throttled to 4 Hz). */
function flowReadState() {
  if (!sim || !sim.W || mode !== "sim" || sim.mapMode) return;
  const gl = sim.gl;
  const fw = Math.max(1, Math.floor(sim.W / 16));
  const fh = Math.max(1, Math.floor(sim.H / 16));
  // reuse the reduce fbo pipeline: bind our own target by rendering state at 1/16
  gl.bindFramebuffer(gl.FRAMEBUFFER, sim.fbo[sim.flip]);
  const full = new Float32Array(sim.W * sim.H * 4);
  gl.readPixels(0, 0, sim.W, sim.H, gl.RGBA, gl.FLOAT, full);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const qx = new Float32Array(fw * fh), qy = new Float32Array(fw * fh);
  const hg = new Float32Array(fw * fh);
  for (let j = 0; j < fh; j++) {
    for (let i = 0; i < fw; i++) {
      let sx = 0, sy = 0, sh = 0, c = 0;
      for (let dy = 0; dy < 16; dy += 4) {
        for (let dx = 0; dx < 16; dx += 4) {
          const sxp = Math.min(sim.W - 1, i * 16 + dx);
          const syp = Math.min(sim.H - 1, j * 16 + dy);
          const k = (syp * sim.W + sxp) * 4;
          sx += full[k + 1]; sy += full[k + 2]; sh += full[k]; c++;
        }
      }
      const o = j * fw + i;
      qx[o] = sx / c; qy[o] = sy / c; hg[o] = sh / c;
    }
  }
  flow.field = { qx, qy };
  flow.hgrid = hg;
  flow.fieldW = fw; flow.fieldH = fh;
  flow.gw = sim.W; flow.gh = sim.H;
}

/** Canvas-normalized point -> field grid index. */
function flowCellAt(u, v) {
  // canvas uv -> grid px (frag uses gp = (frag - c/2)/s + center)
  const cv = $("gl");
  const view = sim.view;
  const gx = ((u * cv.width - cv.width / 2) / view.z + view.x) / flow.gw;
  const gy = ((v * cv.height - cv.height / 2) / view.z + view.y) / flow.gh;
  const i = clamp(Math.floor(gx * flow.fieldW), 0, flow.fieldW - 1);
  const j = clamp(Math.floor(gy * flow.fieldH), 0, flow.fieldH - 1);
  return j * flow.fieldW + i;
}

/** Screen-space velocity vector at a normalized canvas point. */
function flowVecAt(u, v) {
  if (!flow.field) return null;
  const o = flowCellAt(u, v);
  return [flow.field.qx[o], flow.field.qy[o]];
}

function flowDepthAt(u, v) {
  if (!flow.hgrid) return 0;
  return flow.hgrid[flowCellAt(u, v)];
}

/** Reseed onto a wet cell when possible so lines appear on the water. */
function flowReseed(p) {
  for (let a = 0; a < 8; a++) {
    const x = Math.random(), y = Math.random();
    if (flowDepthAt(x, y) > 0.05) { p.x = x; p.y = y; p.age = 0; return; }
  }
  p.x = Math.random(); p.y = Math.random(); p.age = 0;
}

function flowStep(ctx, w, h, dtMs) {
  if (!flow.on || mode !== "sim" || view3dOn || sim.mapMode || !flow.field) return;
  const speed = 0.00042 * Math.min(3, Math.max(0.6, 60 / Math.max(fpsInfo.dtAvg, 1)));
  ctx.lineCap = "round";
  ctx.lineWidth = 1.35;
  for (const p of flow.parts) {
    const v = flowVecAt(p.x, p.y);
    const sp = v ? Math.hypot(v[0], v[1]) : 0;
    const prevX = p.x * w, prevY = p.y * h;
    if (v && sp > 0.0015) {
      // advect along the flux direction, normalized + scaled by log speed
      const t = clamp(Math.log(sp + 0.02) / Math.log(30), 0.15, 1);
      const inv = speed * (0.35 + 0.65 * t);
      const nrm = 1 / (sp + 1e-9);
      p.x += v[0] * nrm * inv;
      p.y += v[1] * nrm * inv;
      ctx.strokeStyle = flowColor(t);
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(p.x * w, p.y * h);
      ctx.stroke();
    }
    p.age += dtMs;
    // fade & reseed: long comet trails, like the reference wind maps
    if (p.age > 2200 || p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02 || (v && sp <= 0.0015 && p.age > 250)) {
      flowReseed(p);
    }
  }
}

/** 風マップ風: 遅いストリーム→白の速い流れ。 */
function flowColor(t) {
  const a = 0.26 + 0.55 * t;
  const r = Math.round(110 + 145 * t);
  const g = Math.round(225 + 30 * t);
  const b = 255;
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

function flowResize() {
  const c = $("flow");
  const gl = $("gl");
  const w = gl.clientWidth || innerWidth, h = gl.clientHeight || innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  c.style.width = w + "px"; c.style.height = h + "px";
  return { w: c.width, h: c.height };
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
  if (view3dOn && view3d && frameNo % 8 === 0) {
    view3d.updateWater(sim.readState());
    // deck.glの雨パーティクルに現在の雨強度を伝える
    if (view3dKind === "deck") {
      const rate = sim.rainSeries
        ? sim.rainRateAt(Math.min(sim.time, sim.rainEnd))
        : (sim.params?.rain || 0);
      view3d.setRainIntensity(rate);
    }
  }
  if (!sim.paused) {
    const speed = parseInt($("speed").value, 10);
    if (playback.on) {
      // リプレイ: フレームを時間軸に沿って再生する
      const end = playback.meta.times[playback.meta.times.length - 1];
      sim.time = Math.min(end, sim.time + 0.016 * speed);
      sim.rainLeft = Math.max(0, sim.rainEnd - sim.time);
      playback.applyTime(sim.time);
    } else {
      // keep interactive: fewer substeps when the frame is slow
      const budget = clamp(1200 / Math.max(fpsInfo.dtAvg, 6), 1, 120);
      const substeps = clamp(Math.round(speed * budget / 60), 1, 480);
      sim.advance(0.016 * speed, substeps);
    }
  }
  if (!view3dOn) sim.render(renderMode);   // 2D canvas is hidden in 3D mode
  // flow particle overlay (2D sim only)
  flowResize();
  $("flow").hidden = !flow.on || view3dOn;
  const now2 = performance.now();
  if (flow.on && !view3dOn && !sim.paused && !tl.seeking && now2 - flow.lastRead > 250) {
    flow.lastRead = now2;
    flowReadState();
  }
  if (!view3dOn && flow.field) {
    const f2 = $("flow");
    const fctx = f2.getContext("2d");
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.globalCompositeOperation = "destination-in";
    fctx.fillStyle = "rgba(0,0,0,0.87)";
    fctx.fillRect(0, 0, f2.width, f2.height);
    fctx.globalCompositeOperation = "lighter";
    flowStep(fctx, f2.width, f2.height, dtMs);
    fctx.globalCompositeOperation = "source-over";
  }
  if (now - lastStatsT > 1000) {
    lastStatsT = now;
    const st = sim.computeStats();
    $("statTime").textContent = fmtTime(sim.time);
    const rateNow = sim.rainSeries ? sim.rainRateAt(Math.min(sim.time, sim.rainEnd)) : parseFloat($("rain").value);
    const raining = sim.rainLeft > 0 || (sim.rainSeries && sim.time < sim.rainEnd);
    const badge = $("rainBadge");
    $("rainBadgeLabel").textContent = raining ? "降雨中" : "降雨なし";
    badge.className = "badge " + (raining ? "rain" : "stop");
    $("statRain").textContent = raining
      ? `${rateNow.toFixed(1)} mm/h (残 ${fmtTime(sim.rainLeft > 0 ? sim.rainLeft : Math.max(0, sim.rainEnd - sim.time))})`
      : "降っていません";
    // 積算雨量: ハイエトグラフを台形積分 (シーク後も正しい値になる)
    $("statAcc").textContent = rainAccumAt(sim.time).toFixed(1) + " mm";
    $("statVol").textContent = fmtVol(st.volume);
    // 氾濫面積(>5cm)の域内比バー
    const regionKm2 = sim.W * sim.H * sim.dx * sim.dx / 1e12;
    const floodRatioPct = regionKm2 > 0 ? (st.a5 / 1e6) / regionKm2 * 100 : 0;
    $("statBar").style.width = Math.min(100, floodRatioPct).toFixed(3) + "%";
    $("statA5").textContent = (st.a5 / 1e6).toFixed(2) + " km²";
    $("statA30").textContent = (st.a30 / 1e6).toFixed(2) + " km²";
    $("statA100").textContent = (st.a100 / 1e6).toFixed(2) + " km²";
    $("statFps").textContent = (1000 / Math.max(fpsInfo.dtAvg, 1)).toFixed(0);
    // history sample + checkpoint
    tl.pushSample();
    tlCaptureIfDue();
  }
  // timeline drawing at ~10 Hz
  if (now - tl.lastDraw > 100) { drawBar(); tl.lastDraw = now; }
}

window.addEventListener("error", (e) => toast("エラー: " + e.message, 8000));
window.addEventListener("unhandledrejection", (e) => toast("エラー: " + (e.reason?.message || e.reason), 8000));

init();
