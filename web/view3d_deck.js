// deck.gl ビュワー — PLATEAU 3D Tiles の建物 + GSI 地形 + 水深ドレープ。
// three.js版 (view3d.js) と同じ setRegion/updateWater インターフェースを持つが、
// 座標系は地理座標 (WGS84) で、建物はPLATEAU配信の実寸 3D Tiles を使う。
//
// 地形: deck.gl TerrainLayer が国土地理院 dem5a_png を直接ストリーミングして
//       Martini メッシュを生成する (真スケール = 垂直誇張なし)。
// 水面: シミュレーション状態を水深色キャンバスに描き、TerrainExtension で
//       地形表面にドレープする (BitmapLayer)。
// 建物: Tile3DLayer で PLATEAU の b3dm を表示。建物は地心直交座標の絶対高さを
//       持ち、地形も同じ国土地理院 DEM 基準のため「浮き」がない。

import { decodeTerrCm, drawWaterCanvas, loadScript, mergeBuildingRects, pickBldgTileset, regionBBox } from "./geo.js?v=27";

// ローカルにベンダリングした deck.gl (MIT License, https://deck.gl)
const DECK_URL = "lib/deck.gl.min.js";

// 地形タイル: AWS Terrain Tiles (terrarium) — CORS有り・欠測なしの全球DEM。
// GSI dem5a_png は都市部に欠測 (0x80,0,0 → 327.68mと解釈されスパイク化) が
// 多いため、deck.glのストリーミング地形には使わない (精度は three.js/Cesium
// ビュワーのローカル5mDEM側で担保する)。
const TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
// terrarium: 標高(m) = (R*256 + G + B/8) - 32768
const ELEVATION_DECODER = { rScaler: 256, gScaler: 1, bScaler: 0.125, offset: -32768 };
const GSI_ORT_URL = "https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg";
const TERRAIN_MAX_ZOOM = 15;
const TERRAIN_MESH_ERROR = 8;

// 地形クオリティプリセット（?terrain=low|medium|high）。軽量版ではタイル範囲を
// シミュレーション領域に絞り、メッシュを粗く・ズームを下げる。
const TERRAIN_QUALITY = {
  // meshMaxError はメートル単位の標高誤差。洪水ビューアでは数mの起伏が
  // 意味を持つため、low でも 12m までに抑える (40m だと台地が消える)。
  low: { meshMaxError: 12, maxZoom: 13 },
  medium: { meshMaxError: 6, maxZoom: 14 },
  high: { meshMaxError: TERRAIN_MESH_ERROR, maxZoom: TERRAIN_MAX_ZOOM },
};

// PLATEAU 3D Tiles の最大スクリーン空間誤差 (タイルセット traverser 既定は 8)。
// 大きいほど粗いタイルで打ち切られ、タイル数・転送量が減る。
// 地形クオリティに連動させ、?bldgmsse=<px> で上書きできる。
const BLDG_MSSE = { low: 32, medium: 16, high: 8 };

// 簡易建物 (ローカル高さラスタの箱) のインスタンス数上限
const SIMPLE_BLDG_CAP = 250000;

/**
 * 建物高さラスタから箱型建物のバイナリ属性を組み立てる。
 * 位置は範囲中心からのメートルオフセット (METER_OFFSETS 用、+y=北)。
 * three.js 版と同じ矩形マージ・地盤スナップ・スカート補正を使う。
 */
function buildBldgInstances(bldgData, terrainData, W, H, mPerPx) {
  const rects = mergeBuildingRects(bldgData, W, H);
  const n = Math.min(rects.length, SIMPLE_BLDG_CAP);
  if (!n) return null;
  const pos = new Float32Array(n * 3);
  const scale = new Float32Array(n * 3);
  const color = new Uint8Array(n * 3);
  const halfW = W * mPerPx / 2, halfH = H * mPerPx / 2;
  const bedAt = (x, y) => {
    if (!terrainData) return 0;
    const cx = Math.min(Math.max(Math.round(x), 0), W - 1);
    const cy = Math.min(Math.max(Math.round(y), 0), H - 1);
    return decodeTerrCm(terrainData, cy * W + cx);
  };
  let k = 0;
  for (const [sx, sy, w, hh, hCm] of rects) {
    if (k >= n) break;
    const bh = hCm / 100;
    const ex = Math.min(sx + w, W - 1), ey = Math.min(sy + hh, H - 1);
    const mx = sx + w / 2, my = sy + hh / 2;
    // 地盤高は四隅+中央の平均。傾斜地で浮かないようスカートを垂らす
    const b0 = bedAt(sx, sy), b1 = bedAt(ex, sy), b2 = bedAt(sx, ey);
    const b3 = bedAt(ex, ey), bc = bedAt(mx, my);
    const bedAvg = (b0 + b1 + b2 + b3 + bc) / 5;
    const relief = Math.max(b0, b1, b2, b3, bc) - Math.min(b0, b1, b2, b3, bc);
    const skirt = Math.max(0.8, relief * 0.4);
    pos[k * 3] = mx * mPerPx - halfW;           // 東 (+x)
    pos[k * 3 + 1] = halfH - my * mPerPx;       // 北 (+y) — ラスタ行0は北端
    pos[k * 3 + 2] = bedAvg + bh / 2 - skirt / 2;
    scale[k * 3] = w * mPerPx / 2;              // CubeGeometryは±1 → 半径指定
    scale[k * 3 + 1] = hh * mPerPx / 2;
    scale[k * 3 + 2] = (bh + skirt) / 2;
    // PLATEAU View風の明るいニュートラル色 (three.js版と同じばらつき)
    const t = (((sx * 73856093) ^ (sy * 19349663)) >>> 0) % 100 / 100;
    color[k * 3] = Math.round((0.80 + t * 0.14) * 255);
    color[k * 3 + 1] = Math.round((0.81 + t * 0.14) * 255);
    color[k * 3 + 2] = Math.round((0.83 + t * 0.13) * 255);
    k++;
  }
  return {
    length: k,
    attributes: {
      getPosition: { value: pos.subarray(0, k * 3), size: 3 },
      getScale: { value: scale.subarray(0, k * 3), size: 3 },
      getColor: { value: color.subarray(0, k * 3), size: 3, normalized: true },
    },
  };
}

const WATER_CANVAS_MAX = 1024;   // 水深キャンバスの幅上限

// ---------- 雨 (GPUパーティクル) ----------
// CPU側は毎フレーム uniform (modelMatrix の平行移動とopacity) を差し替える
// だけで、頂点バッファは初期化時に一度だけ作る。落下は「雨幕を下へ平行移動
// して周期ラップする」定番手法。LineLayer を周期Pだけ違う高さに2枚重ねるので
// どの時刻でも空全体を雨筋が満たし、2ドローコールで数千本を描ける。
const RAIN_PERIOD = 220;     // 雨幕の垂直ラップ周期 (m)
const RAIN_COUNT = 6000;     // 雨筋の本数 (1層あたり)
const RAIN_FALL_MPS = 60;    // 見た目上の落下速度 (m/s)
const RAIN_MARGIN = 1.35;    // 範囲外 (カメラ回転時の空白) も含めて降らせる倍率
const RAIN_LIFT = 18;        // 地形/建物に埋まらないよう雨幕の下端を持ち上げる (m)

/** シードから再現性のある乱数 (雨の配置をリージョンごとに安定させる)。 */
function rainRand(i, salt) {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class DeckView {
  name = "deck";

  constructor(canvas) {
    this.canvas = canvas;
    this.deck = null;
    this.ready = this._init();
    this.showBuildings = true;
    this.showPhoto = true;
    this.stats = { tilesLoaded: 0, bytesLoaded: 0, tilesetLoads: 0 };
    this._region = null;
    this._left = 0;
    this._top = 0;
    this._bldgUrl = null;
    const params = new URLSearchParams(location.search);
    // ?lite=1 は軽量プリセット (lod=1, photo=0, bldg=0, terrain=low) の一括指定。
    // 個別パラメータが明示されていればそちらを優先する。
    const lite = params.get("lite") === "1";
    // ?lod=1 で軽量LOD1 (屋根形のみ) / 既定はLOD2 — 軽さ比較用
    this._lod = params.get("lod") === "1" || params.get("lod") === "2"
      ? params.get("lod") : (lite ? "1" : "2");
    const tq = params.get("terrain");
    this._terrainQuality = TERRAIN_QUALITY[tq] ? tq : (lite ? "low" : "high");
    // 建物ソース: "plateau" (3D Tiles 実寸) / "simple" (ローカルラスタの箱)
    const bp = params.get("bldg");
    this._bldgMode = bp === "simple" ? "simple" : "plateau";
    this.showBuildings = bp === "0" || lite ? false : this.showBuildings;
    this.showPhoto = params.get("photo") === "0" || lite ? false : this.showPhoto;
    const msse = Number.parseFloat(params.get("bldgmsse") || "");
    this._bldgMsse = Number.isFinite(msse) && msse > 0 ? msse : null;
    this._simpleBldg = undefined;   // 簡易建物バイナリ属性 (遅延構築・リージョン単位でキャッシュ)
    this._lastWaterAt = 0;
    this._frameCount = 0;
    this._waterCanvases = [document.createElement("canvas"), document.createElement("canvas")];
    this._waterFlip = 0;
    this._waterVersion = 0;
    // 雨
    this._rainOn = false;
    this._rainIntensity = 0;    // mm/h
    this._rainGeom = null;
    this._rainRaf = 0;
  }

  async _init() {
    await loadScript(DECK_URL, "deck-gl-script");
    const deck = window.deck;
    if (!deck) throw new Error("deck.gl を初期化できませんでした");
    this.deck = new deck.Deck({
      canvas: this.canvas,
      views: [new deck.MapView({ controller: { dragRotate: true } })],
      initialViewState: { longitude: 136.906, latitude: 35.17, zoom: 14, pitch: 45, bearing: -20 },
      controller: true,
      // preserveDrawingBuffer: スクリーンショット保存用 (three.js版と同じ挙動)
      glOptions: { webgl2: true, preserveDrawingBuffer: true },
      onAfterRender: () => { this._frameCount++; },
      layers: [],
    });
    if (this._region) this.setRegion(...this._region);
    return this;
  }

  /** regionInfo のタイル原点 (z15ピクセル) — bbox計算に使う。setRegionの前に呼ぶ。 */
  setOrigin(left, top) {
    this._left = left;
    this._top = top;
  }

  setRegion(W, H, mPerPx, terrainData, bldgData, photoCanvas, stateW, stateH) {
    this._region = [W, H, mPerPx, terrainData, bldgData, photoCanvas, stateW, stateH];
    if (!this.deck) return;   // 初期化後に再呼び出しされる
    this.stateW = stateW || W;
    this.stateH = stateH || H;
    this.bbox = regionBBox({ W, H, dx: mPerPx, left: this._left, top: this._top },
      window.__meta, window.__overviewFactor || 4);
    // 初期カメラ: 範囲を収め、やや南から見下ろす。
    // deck.gl zoom: 512*2^zoom px で 360°。範囲をキャンバス幅の ~75% に収める。
    const lonC = (this.bbox[0] + this.bbox[2]) / 2, latC = (this.bbox[1] + this.bbox[3]) / 2;
    const spanLon = Math.abs(this.bbox[2] - this.bbox[0]);
    const targetPx = Math.max(320, (this.canvas.clientWidth || 1280) * 0.75);
    const zoom = Math.log2(targetPx * 360 / Math.max(spanLon * 512, 1e-9));
    this.deck.setProps({
      initialViewState: { longitude: lonC, latitude: latC - spanLon * 0.10, zoom, pitch: 55, bearing: -18 },
    });
    // PLATEAUタイルは plateau モードのときだけ取得する (simple は通信ゼロ)
    if (this._bldgMode === "plateau") this._loadBuildings(lonC, latC);
    this._simpleBldg = undefined;
    this._buildRainGeom(W, H, mPerPx);
    this._renderLayers();
  }

  /** 雨筋の頂点バッファを一度だけ作る (初期化後は更新しない)。
   * 雨筋は「上面→下面」の縦線。z を周期 P の中にランダム配置し、
   * modelMatrix で雨幕ごと下へ平行移動してラップする。 */
  _buildRainGeom(W, H, mPerPx) {
    const wM = W * mPerPx * RAIN_MARGIN, hM = H * mPerPx * RAIN_MARGIN;
    const src = new Float32Array(RAIN_COUNT * 3);
    const dst = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (rainRand(i, 1) - 0.5) * wM;
      const y = (rainRand(i, 2) - 0.5) * hM;
      const z = RAIN_LIFT + rainRand(i, 3) * RAIN_PERIOD;
      const len = 16 + rainRand(i, 4) * 24;   // 雨筋の長さ (m) — 中距離でも見えるように
      const sx = 0.16, sy = 0.09;             // 風で少し斜めに
      src[i * 3] = x; src[i * 3 + 1] = y; src[i * 3 + 2] = z + len;
      dst[i * 3] = x + len * sx; dst[i * 3 + 1] = y + len * sy; dst[i * 3 + 2] = z;
    }
    this._rainGeom = {
      length: RAIN_COUNT,
      attributes: {
        getSourcePosition: { value: src, size: 3 },
        getTargetPosition: { value: dst, size: 3 },
      },
    };
  }

  /** 雨強度 (mm/h) を受ける。弱い雨はフェードアウト。 */
  setRainIntensity(mmh) {
    this._rainIntensity = mmh || 0;
    if (!this._rainOn) return;
    // 強度→不透明度。止み雨では消える (レイヤーは残るので復帰も即時)
    const t = Math.min(1, Math.max(0, (this._rainIntensity - 0.5) / 40));
    this._rainOpacity = 0.28 + 0.62 * t;
    this._rainVisible = this._rainIntensity >= 0.5;
  }

  /** 雨の表示を切り替える (rAFティックは必要時だけ回す)。 */
  setRainEnabled(on) {
    this._rainOn = !!on;
    if (this._rainOn) {
      this.setRainIntensity(this._rainIntensity || 30);
      this._startRainTick();
    } else {
      this._stopRainTick();
      this._renderLayers();
    }
  }

  _startRainTick() {
    if (this._rainRaf) return;
    let last = performance.now();
    const tick = () => {
      this._rainRaf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(now - last, 100) / 1000;
      last = now;
      // 落下は uniform (modelMatrix) の更新のみ。バッファは触らない。
      if (this._rainZ === undefined) this._rainZ = RAIN_PERIOD;
      this._rainZ -= RAIN_FALL_MPS * dt;
      this._rainZ = ((this._rainZ % RAIN_PERIOD) + RAIN_PERIOD) % RAIN_PERIOD;
      this._renderLayers();
    };
    this._rainRaf = requestAnimationFrame(tick);
  }

  _stopRainTick() {
    if (this._rainRaf) {
      cancelAnimationFrame(this._rainRaf);
      this._rainRaf = 0;
    }
  }

  /** 雨レイヤー2枚 (同じバッファを周期Pずらして配置)。 */
  _rainLayers() {
    if (!this._rainOn || !this._rainGeom || this._rainVisible === false) return [];
    const deck = window.deck;
    const lonC = (this.bbox[0] + this.bbox[2]) / 2, latC = (this.bbox[1] + this.bbox[3]) / 2;
    const tz = this._rainZ ?? RAIN_PERIOD;
    const mk = (id, dz) => new deck.LineLayer({
      id,
      data: this._rainGeom,
      coordinateOrigin: [lonC, latC],
      coordinateSystem: deck.COORDINATE_SYSTEM.METER_OFFSETS,
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, dz, 1],
      getColor: [140, 180, 250],
      opacity: this._rainOpacity ?? 0.5,
      getWidth: 2.5,
      widthUnits: "pixels",
      pickable: false,
    });
    return [mk("rain-a", tz), mk("rain-b", tz - RAIN_PERIOD)];
  }

  async _loadBuildings(lon, lat) {
    const pick = await pickBldgTileset(lon, lat, this._lod);
    if (this._bldgUrl === pick.url) return;
    this._bldgUrl = pick.url;
    this._wardName = pick.ward;
    this.stats.tilesLoaded = 0;
    this.stats.bytesLoaded = 0;
    this._renderLayers();
  }

  /** 簡易建物のバイナリ属性を遅延構築する (リージョン単位でキャッシュ)。 */
  _simpleBldgData() {
    if (this._simpleBldg !== undefined) return this._simpleBldg;
    const region = this._region;
    if (!region || !region[4]) return (this._simpleBldg = null);
    const [W, H, mPerPx, terrainData, bldgData] = region;
    this._simpleBldg = buildBldgInstances(bldgData, terrainData, W, H, mPerPx);
    return this._simpleBldg;
  }

  /** 現在の状態からレイヤー配列を組み直して deck に渡す。 */
  _renderLayers() {
    if (!this.deck || !this.bbox) return;
    const deck = window.deck;
    const tq = TERRAIN_QUALITY[this._terrainQuality] || TERRAIN_QUALITY.high;
    const lonC = (this.bbox[0] + this.bbox[2]) / 2, latC = (this.bbox[1] + this.bbox[3]) / 2;
    const layers = [
      new deck.TerrainLayer({
        id: "terrain",
        elevationData: TERRAIN_URL,
        texture: this.showPhoto ? GSI_ORT_URL : null,
        elevationDecoder: ELEVATION_DECODER,
        meshMaxError: tq.meshMaxError,
        maxZoom: tq.maxZoom,
        bounds: this.bbox,           // シミュレーション領域外のタイルは読まない
        operation: "terrain+draw",   // TerrainExtension のドレープ先になる
      }),
    ];
    if (this._waterVersion > 0) {
      // 水深キャンバス (裏面バッファと交互差し替えでテクスチャ更新する)
      layers.push(new deck.BitmapLayer({
        id: "water",
        image: this._waterCanvases[this._waterFlip],
        bounds: [this.bbox[0], this.bbox[1], this.bbox[2], this.bbox[3]],
        transparent: true,
        opacity: 1,
        extensions: [new deck._TerrainExtension()],
      }));
    }
    if (this.showBuildings) {
      if (this._bldgMode === "simple") {
        const data = this._simpleBldgData();
        if (data) {
          layers.push(new deck.SimpleMeshLayer({
            id: "bldg-simple",
            data,
            mesh: this._cube ??= new window.luma.CubeGeometry(),
            coordinateSystem: deck.COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: [lonC, latC],
            material: { ambient: 0.45, diffuse: 0.6, shininess: 16, specularColor: [30, 30, 30] },
            pickable: false,
          }));
        }
      } else if (this._bldgUrl) {
        // idにMSSEを含めて、値が変わったときは別レイヤー=タイルセット再構築にする
        const msse = this._bldgMsse ?? BLDG_MSSE[this._terrainQuality] ?? 8;
        layers.push(new deck.Tile3DLayer({
          id: `plateau-bldg-msse${msse}`,
          data: this._bldgUrl,
          loadOptions: { tileset: { maximumScreenSpaceError: msse } },
          onTilesetLoad: () => { this.stats.tilesetLoads++; },
          onTileLoad: (tile) => {
            this.stats.tilesLoaded++;
            this.stats.bytesLoaded += tile.content?.byteLength || 0;
          },
        }));
      }
    }
    layers.push(...this._rainLayers());
    this.deck.setProps({ layers });
  }

  /** シミュレーション状態 → 水深キャンバス → 地形にドレープ (~4Hz)。 */
  updateWater(rgba) {
    if (!this.deck || !this.bbox || !rgba) return;
    const now = performance.now();
    if (now - this._lastWaterAt < 200) return;
    this._lastWaterAt = now;
    const cv = this._waterCanvases[this._waterFlip];
    drawWaterCanvas(cv, rgba, this.stateW, this.stateH, WATER_CANVAS_MAX);
    this._waterFlip = 1 - this._waterFlip;   // 参照が変わることで再アップロード
    this._waterVersion++;
    this._renderLayers();
  }

  setFlowEnabled() { }          // three.js版の流線パーティクルは非対応
  setStreamsVisible() { }
  setWaves() { }
  setExag() { }                 // 地理座標は真スケール (垂直誇張なし)
  setPhotoVisible(v) {
    this.showPhoto = v;
    this._renderLayers();
  }
  setPhotoCanvas() { }          // 航空写真は GSI ort タイルを直接使う
  setBuildingsVisible(v) {
    this.showBuildings = v;
    this._renderLayers();
  }

  /** 建物LOD切替 ("1"|"2") — 軽さ比較用 */
  setBuildingLoad(lod) {
    this._lod = lod;
    this._bldgUrl = null;
    if (this.bbox && this._bldgMode === "plateau") {
      this._loadBuildings((this.bbox[0] + this.bbox[2]) / 2, (this.bbox[1] + this.bbox[3]) / 2);
    }
  }

  /** 建物の描画ソース: "plateau" (3D Tiles 実寸) / "simple" (ローカルラスタの箱)。
   * simple は通信ゼロ・オフライン可で、軽量プリセットの建物表示に使う。 */
  setBuildingSource(mode) {
    if (mode !== "plateau" && mode !== "simple") return;
    if (this._bldgMode === mode) return;
    this._bldgMode = mode;
    if (mode === "plateau" && this.bbox && !this._bldgUrl) {
      this._loadBuildings((this.bbox[0] + this.bbox[2]) / 2, (this.bbox[1] + this.bbox[3]) / 2);
    }
    this._renderLayers();
  }

  setTerrainQuality(mode) {
    if (TERRAIN_QUALITY[mode]) {
      this._terrainQuality = mode;
      this._renderLayers();
    }
  }

  zoomBy(f) {
    const vs = this.deck?.viewState;
    if (!vs) return;
    this.deck.setProps({ initialViewState: { ...vs, zoom: vs.zoom + Math.log2(f) } });
  }

  /** ベンチモード用: カメラを直接指定 / 取得 */
  setCamera(viewState) {
    this.deck?.setProps({ initialViewState: viewState });
  }
  getCamera() {
    return this.deck?.viewState;
  }
  centerLonLat() {
    const b = this.bbox;
    return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [136.906, 35.17];
  }

  /** ベンチモード用カメラパス: 0〜2/3は範囲周回、以降は中心へ寄る。 */
  benchCamera(t, total) {
    const [lon, lat] = this.centerLonLat();
    if (t < total * 2 / 3) {
      const u = t / (total * 2 / 3) * Math.PI * 2;
      const r = 0.006;
      this.setCamera({
        longitude: lon + Math.sin(u) * r, latitude: lat + Math.cos(u) * r,
        zoom: 14.6, pitch: 48, bearing: Math.sin(u) * 40 - 18,
      });
    } else {
      this.setCamera({ longitude: lon, latitude: lat - 0.004, zoom: 15.6, pitch: 55, bearing: 10 });
    }
  }

  resize() { }
  getFrameCount() { return this._frameCount; }
  getPerf() { return { tiles: this.stats.tilesLoaded, bytes: this.stats.bytesLoaded, ward: this._wardName }; }

  /** スクリーンショット用に同期的に描き直す */
  ensureFrame() {
    this.deck?.redraw(true);
  }

  hide() {
    this._stopRainTick();   // 非表示中は雨ティックも止める
  }
  show() {
    if (this._rainOn) this._startRainTick();
  }
}
