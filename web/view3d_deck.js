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

import { decodeTerrCm, drawWaterCanvas, loadScript, mergeBuildingRects, pickBldgTilesets, regionBBox } from "./geo.js?v=28";

// ローカルにベンダリングした deck.gl (MIT License, https://deck.gl)
const DECK_URL = "lib/deck.gl.min.js";

// 地形タイル: AWS Terrain Tiles (terrarium) — CORS有り・欠測なしの全球DEM。
// GSI dem5a_png は都市部に欠測 (0x80,0,0 → 327.68mと解釈されスパイク化) が
// 多いため、deck.glのストリーミング地形には使わない (精度は three.js/Cesium
// ビュワーのローカル5mDEM側で担保する)。
// 注意: terrariumは標高基準がPLATEAU建物 (楕円体高) と合っていない。
// 名古屋中心z15タイルでの dem5a_png (正標高) との差は中央値で約+12m
// (参考: GSIGEO2011のジオイド高は名古屋で約+37mではない。terrariumの
// 日本域の標高が何基準かは未確認のため、PLATEAU実寸建物との組み合わせでは
// 基準の一致は保証されない)。
const TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
// terrarium: 標高(m) = (R*256 + G + B/8) - 32768
const ELEVATION_DECODER = { rScaler: 256, gScaler: 1, bScaler: 0.125, offset: -32768 };
const GSI_ORT_URL = "https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg";
// RainViewer 降水レーダー — 無料・APIキー不要、10分毎更新
const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
const RAINVIEWER_TILE = "https://tilecache.rainviewer.com";
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

// 流線パーティクル (LineLayer の軌跡)
const FLOW_TRAIL = 4;           // 1粒子あたりの軌跡点数
const FLOW_PARTICLE_CAP = 30;   // 粒子数上限 (多すぎると画面が埋まる)

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
    // 地盤高は四隅+中央を取り、最低値を底面にする (斜面で浮かない)
    const b0 = bedAt(sx, sy), b1 = bedAt(ex, sy), b2 = bedAt(sx, ey);
    const b3 = bedAt(ex, ey), bc = bedAt(mx, my);
    const bedAvg = (b0 + b1 + b2 + b3 + bc) / 5;
    const minBed = Math.min(b0, b1, b2, b3, bc);
    const margin = 0.6;
    const yBottom = minBed - margin;
    const yTop = bedAvg + bh;
    const boxH = yTop - yBottom;
    pos[k * 3] = mx * mPerPx - halfW;           // 東 (+x)
    pos[k * 3 + 1] = halfH - my * mPerPx;       // 北 (+y) — ラスタ行0は北端
    pos[k * 3 + 2] = yBottom + boxH / 2;
    scale[k * 3] = w * mPerPx / 2;              // CubeGeometryは±1 → 半径指定
    scale[k * 3 + 1] = hh * mPerPx / 2;
    scale[k * 3 + 2] = boxH / 2;
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
    this._bldgUrls = null;
    this._bldgGen = 0;         // _loadBuildings の世代カウンタ (競合防止)
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
    // 雨
    this._rainOn = false;
    this._rainIntensity = 0;    // mm/h
    this._rainGeom = null;
    // 気象レイヤー (降水レーダー)
    this._weatherOn = params.get("weather") === "1";
    this._weatherOpacity = 0.55;
    this._weatherTileUrl = null;
    if (this._weatherOn) this._fetchWeatherTile();
    // 流線パーティクル
    this._flowOn = false;
    this._flowField = null;   // {qx, qy, h, gw, gh, qmax}
    this._flowParticles = null; // {n, pU, pV, pAge, pLife, trail}
    this._flowRaf = 0;
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
      window.__meta);
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
    if (this._bldgMode === "plateau") this._loadBuildings();
    this._simpleBldg = undefined;
    // 水深キャンバス (ダブルバッファ) — updateWater で交互に使う
    if (!this._waterCanvases) {
      this._waterCanvases = [document.createElement("canvas"), document.createElement("canvas")];
      this._waterFlip = 0;
      this._waterVersion = 0;
    }
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

  /** bbox と重なる全区の PLATEAU 建物タイルセットを読む (区境またぎ対応)。 */
  async _loadBuildings() {
    const gen = ++this._bldgGen;   // リージョン変更ごとに増え、古いロードを無効化
    const picks = await pickBldgTilesets(this.bbox, this._lod);
    if (gen !== this._bldgGen) return;              // 別リージョンに切り替わった
    const key = picks.map((p) => p.url).join("|");
    if (this._bldgKey === key) return;
    this._bldgKey = key;
    this._bldgUrls = picks.map((p) => p.url);
    this._wardName = picks.map((p) => p.ward).join("・");
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
      } else if (this._bldgUrls?.length) {
        // idにMSSEを含めて、値が変わったときは別レイヤー=タイルセット再構築にする
        const msse = this._bldgMsse ?? BLDG_MSSE[this._terrainQuality] ?? 8;
        for (const url of this._bldgUrls) {
          layers.push(new deck.Tile3DLayer({
            id: `plateau-bldg-msse${msse}-${url.slice(-24)}`,
            data: url,
            loadOptions: { tileset: { maximumScreenSpaceError: msse } },
            onTilesetLoad: () => { this.stats.tilesetLoads++; },
            onTileLoad: (tile) => {
              this.stats.tilesLoaded++;
              this.stats.bytesLoaded += tile.content?.byteLength || 0;
            },
          }));
        }
      }
    }
    layers.push(...this._rainLayers());
    // 流線パーティクル (LineLayer の軌跡)
    if (this._flowOn && this._flowParticles) {
      const segs = this._flowSegments();
      if (segs.length) {
        layers.push(new deck.LineLayer({
          id: "flow-particles",
          data: segs,
          getSourcePosition: (d) => d.sourcePosition,
          getTargetPosition: (d) => d.targetPosition,
          getColor: (d) => d.color,
          getWidth: 1.5,
          widthUnits: "pixels",
          opacity: 0.5,
          blending: "additive",
        }));
      }
    }
    // 分水域・流路オーバーレイ (シミュレーション領域にドレープ)
    if (this._streamsOn && this._streamsImg && this.bbox) {
      layers.push(new deck.BitmapLayer({
        id: "streams",
        image: this._streamsImg,
        bounds: this.bbox,
        opacity: 0.7,
        extensions: [new deck._TerrainExtension()],
      }));
    }
    // 気象レイヤー: RainViewer 降水レーダーを地形の上に重ねる
    if (this._weatherOn && this._weatherTileUrl) {
      layers.push(new deck.TileLayer({
        id: "weather-radar",
        data: this._weatherTileUrl,
        minZoom: 4, maxZoom: 14,
        tileSize: 256,
        opacity: this._weatherOpacity,
        renderSubLayers: (props) => {
          // tile.index = {x, y, z} — Web Mercator タイル番号から lon/lat を計算
          const { x, y, z } = props.tile.index;
          const n = Math.pow(2, z);
          const lonMin = x / n * 360 - 180;
          const lonMax = (x + 1) / n * 360 - 180;
          const latMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
          const latMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
          return new deck.BitmapLayer(props, {
            data: null,
            image: props.data,
            bounds: [lonMin, latMin, lonMax, latMax],
          });
        },
      }));
    }
    this.deck.setProps({ layers });
  }

  /** 気象レイヤー (降水レーダー) の表示切替。 */
  setWeatherVisible(v) {
    this._weatherOn = !!v;
    if (this._weatherOn && !this._weatherTileUrl) this._fetchWeatherTile();
    this._renderLayers();
  }

  /** Bilinear terrain height at normalized (u, v). */
  _terrHeight(u, v) {
    const d = this._region?.[3]; // terrainData
    if (!d) return 0;
    const W = this._region[0], H = this._region[1];
    const gx = Math.min(Math.max(u * W, 0), W - 1.001);
    const gy = Math.min(Math.max(v * H, 0), H - 1.001);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = gx - x0, ay = gy - y0;
    const top = decodeTerrCm(d, y0 * W + x0) * (1 - ax) + decodeTerrCm(d, y0 * W + x1) * ax;
    const bot = decodeTerrCm(d, y1 * W + x0) * (1 - ax) + decodeTerrCm(d, y1 * W + x1) * ax;
    return (top * (1 - ay) + bot * ay) / 100; // cm → m
  }

  /** Bilinear water depth at normalized (u, v). */
  _stateDepth(u, v) {
    const d = this._stateData;
    if (!d) return 0;
    const W = this.stateW, H = this.stateH;
    const fx = Math.min(Math.max(u * W - 0.5, 0), W - 1.001);
    const fy = Math.min(Math.max(v * H - 0.5, 0), H - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const top = d[(y0 * W + x0) * 4] * (1 - ax) + d[(y0 * W + x1) * 4] * ax;
    const bot = d[(y1 * W + x0) * 4] * (1 - ax) + d[(y1 * W + x1) * 4] * ax;
    return top * (1 - ay) + bot * ay;
  }

  /** RainViewer API から最新レーダータイルURLを取得する。 */
  async _fetchWeatherTile() {
    try {
      const res = await fetch(RAINVIEWER_API);
      const data = await res.json();
      const latest = data.radar?.past?.slice(-1)[0];
      if (latest?.path) {
        this._weatherTileUrl = `${RAINVIEWER_TILE}${latest.path}/256/{z}/{x}/{y}/4/1_1.png`;
        this._renderLayers();
      }
    } catch (e) {
      console.warn("RainViewer API取得失敗:", e);
    }
  }
  setFlowEnabled(v) {
    this._flowOn = !!v;
    if (this._flowOn && !this._flowParticles) this._initFlowParticles();
    if (this._flowOn) this._startFlowTick();
    else this._stopFlowTick();
    this._renderLayers();
  }

  /** 流線パーティクルの初期化 (リージョンサイズに応じて粒子数を決める)。 */
  _initFlowParticles() {
    const W = this.stateW || 256, H = this.stateH || 256;
    const n = Math.min(FLOW_PARTICLE_CAP, Math.round(Math.max(W, H) * 1.5));
    const trail = new Float32Array(n * FLOW_TRAIL * 3);
    const p = {
      n, trail,
      pU: new Float32Array(n), pV: new Float32Array(n),
      pAge: new Float32Array(n), pLife: new Float32Array(n),
      pTn: new Float32Array(n),
    };
    for (let i = 0; i < n; i++) {
      p.pU[i] = Math.random(); p.pV[i] = Math.random();
      p.pAge[i] = Math.random() * 1200;
      p.pLife[i] = 1500 + Math.random() * 1600;
    }
    this._flowParticles = p;
  }

  /** シミュレーション状態から粗い流速場を構築 (throttled)。 */
  _buildFlowField(rgba) {
    const W = this.stateW, H = this.stateH;
    const s = Math.max(1, Math.round(Math.max(W, H) / 128));
    const gw = Math.max(2, Math.floor(W / s));
    const gh = Math.max(2, Math.floor(H / s));
    const qx = new Float32Array(gw * gh);
    const qy = new Float32Array(gw * gh);
    const h = new Float32Array(gw * gh);
    let qmax = 0.02;
    for (let j = 0; j < gh; j++) {
      const row = H - 1 - Math.min(H - 1, j * s);   // field j = 北から
      for (let i = 0; i < gw; i++) {
        const col = Math.min(W - 1, i * s);
        const k = (row * W + col) * 4;
        const o = j * gw + i;
        qx[o] = rgba[k + 1]; qy[o] = rgba[k + 2]; h[o] = rgba[k];
        const sp = Math.hypot(qx[o], qy[o]);
        if (sp > qmax) qmax = sp;
      }
    }
    this._flowField = { qx, qy, h, gw, gh, qmax };
  }

  /** Bilinear field sample; u,v normalized (v = 0 north). */
  _sampleField(u, v, out) {
    const f = this._flowField;
    const fx = Math.min(Math.max(u * f.gw - 0.5, 0), f.gw - 1);
    const fy = Math.min(Math.max(v * f.gh - 0.5, 0), f.gh - 1);
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(f.gw - 1, i0 + 1), j1 = Math.min(f.gh - 1, j0 + 1);
    const ax = fx - i0, ay = fy - j0;
    const o00 = j0 * f.gw + i0, o10 = j0 * f.gw + i1;
    const o01 = j1 * f.gw + i0, o11 = j1 * f.gw + i1;
    const mix2 = (a, b, c, d) => (a + (b - a) * ax) * (1 - ay) + (c + (d - c) * ax) * ay;
    out.qx = mix2(f.qx[o00], f.qx[o10], f.qx[o01], f.qx[o11]);
    out.qy = mix2(f.qy[o00], f.qy[o10], f.qy[o01], f.qy[o11]);
    out.h = mix2(f.h[o00], f.h[o10], f.h[o01], f.h[o11]);
  }

  /** 粒子を湿ったセルにリスポーン。見つからなければ false。 */
  _respawn(i, p) {
    const f = this._flowField;
    let bu = 0, bv = 0, bh = 0, found = false;
    for (let a = 0; a < 14; a++) {
      const u = Math.random(), v = Math.random();
      const hh = f.h[(Math.min(f.gh - 1, v * f.gh | 0)) * f.gw + Math.min(f.gw - 1, u * f.gw | 0)];
      if (hh > 0.06) { p.pU[i] = u; p.pV[i] = v; found = true; break; }
      if (hh > bh) { bh = hh; bu = u; bv = v; }
    }
    if (!found) {
      if (bh > 0.03) { p.pU[i] = bu; p.pV[i] = bv; }
      else return false;
    }
    // リスポーン時は軌跡を全て新位置にリセット
    const lon = this.bbox[0] + p.pU[i] * (this.bbox[2] - this.bbox[0]);
    const lat = this.bbox[1] + p.pV[i] * (this.bbox[3] - this.bbox[1]);
    const bed = this._terrHeight(p.pU[i], p.pV[i]);
    const hd = this._stateDepth(p.pU[i], p.pV[i]);
    const z = bed + Math.max(hd, 0) + 0.5 + 0.25 * Math.min(hd, 2);
    const base = i * FLOW_TRAIL * 3;
    for (let k = 0; k < FLOW_TRAIL; k++) {
      p.trail[base + k * 3] = lon;
      p.trail[base + k * 3 + 1] = lat;
      p.trail[base + k * 3 + 2] = z;
    }
    return true;
  }

  /** 粒子を移流し、LineLayer 用のセグメント配列を構築。 */
  _updateFlow(dtMs) {
    const p = this._flowParticles;
    if (!p || !this._flowField || !this.bbox) return;
    const dt = Math.min(dtMs, 50) / 1000;
    const f = this._flowField;
    const refU = Math.max(0.3, f.qmax / 0.45);
    const smp = { qx: 0, qy: 0, h: 0 };
    const tr = p.trail;
    const lonSpan = this.bbox[2] - this.bbox[0];
    const latSpan = this.bbox[3] - this.bbox[1];

    for (let i = 0; i < p.n; i++) {
      p.pAge[i] += dtMs;
      this._sampleField(p.pU[i], p.pV[i], smp);
      let sp = Math.hypot(smp.qx, smp.qy) / Math.max(smp.h, 0.03);
      if ((smp.h < 0.035 || sp < 0.015 || p.pAge[i] > p.pLife[i]) && this._respawn(i, p)) {
        p.pAge[i] = 0;
        this._sampleField(p.pU[i], p.pV[i], smp);
        sp = Math.hypot(smp.qx, smp.qy) / Math.max(smp.h, 0.03);
      }
      const dead = smp.h < 0.03;
      const tn = Math.min(Math.max(Math.pow(Math.min(Math.max(sp / refU, 0), 1), 0.65), 0), 1);
      p.pTn[i] = tn;
      if (!dead) {
        const inv = 1 / Math.max(sp, 1e-6);
        // 流速が小さいため、three.js版より速めに移流させて見えるようにする
        const cellsPerSec = 48 * (0.3 + 0.7 * tn);
        p.pU[i] += smp.qx * inv * cellsPerSec * dt / this.stateW;
        p.pV[i] += smp.qy * inv * cellsPerSec * dt / this.stateH;
        if (p.pU[i] < -0.01 || p.pU[i] > 1.01 || p.pV[i] < -0.01 || p.pV[i] > 1.01) {
          if (!this._respawn(i, p)) p.pAge[i] = 1e9;
        }
      }
      // trail: 1点ずらして先頭に新しい位置 (lon/lat) を積む
      const base = i * FLOW_TRAIL * 3;
      tr.copyWithin(base + 3, base, base + (FLOW_TRAIL - 1) * 3);
      const e = base + (FLOW_TRAIL - 1) * 3;
      if (dead) {
        tr[e] = 0; tr[e + 1] = 0; tr[e + 2] = -1e5;
      } else {
        const bed = this._terrHeight(p.pU[i], p.pV[i]);
        const hd = this._stateDepth(p.pU[i], p.pV[i]);
        tr[e] = this.bbox[0] + p.pU[i] * lonSpan;
        tr[e + 1] = this.bbox[1] + p.pV[i] * latSpan;
        tr[e + 2] = bed + Math.max(hd, 0) + 0.5 + 0.25 * Math.min(hd, 2);
      }
    }
  }

  _startFlowTick() {
    if (this._flowRaf) return;
    let last = performance.now();
    const tick = () => {
      this._flowRaf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(now - last, 100);
      last = now;
      this._updateFlow(dt);
      this._renderLayers();
    };
    this._flowRaf = requestAnimationFrame(tick);
  }

  _stopFlowTick() {
    if (this._flowRaf) {
      cancelAnimationFrame(this._flowRaf);
      this._flowRaf = 0;
    }
  }

  /** 流線パーティクルの LineLayer セグメントを構築。 */
  _flowSegments() {
    const p = this._flowParticles;
    if (!p || !this._flowOn) return [];
    const segs = [];
    const tr = p.trail;
    for (let i = 0; i < p.n; i++) {
      const tn = p.pTn[i];
      const fade = 0.5 + 0.5 * tn;
      const r = 0.5 + 0.5 * tn, g = 0.8 + 0.2 * tn, b = 1.0;
      const base = i * FLOW_TRAIL * 3;
      for (let k = 0; k < FLOW_TRAIL - 1; k++) {
        const a0 = base + k * 3, a1 = a0 + 3;
        const alpha = fade * k / (FLOW_TRAIL - 1);
        segs.push({
          sourcePosition: [tr[a0], tr[a0 + 1], tr[a0 + 2]],
          targetPosition: [tr[a1], tr[a1 + 1], tr[a1 + 2]],
          color: [r * 255, g * 255, b * 255, alpha * 255],
        });
      }
    }
    return segs;
  }
  /** 気象レイヤーの不透明度 (0..1)。 */
  setWeatherOpacity(v) {
    this._weatherOpacity = Math.max(0, Math.min(1, v));
    if (this._weatherOn) this._renderLayers();
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
    // 流線パーティクル用に粗い流速場を更新 (throttled)
    if (this._flowOn) this._buildFlowField(rgba);
    this._renderLayers();
  }

  setStreamsVisible(v) {
    this._streamsOn = !!v;
    this._renderLayers();
  }
  setStreamsCanvas(img) {
    this._streamsImg = img;
    this._renderLayers();
  }
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
    if (lod === this._lod) return;
    this._lod = lod;
    this._bldgKey = null;
    if (this.bbox && this._bldgMode === "plateau") {
      this._loadBuildings();
    }
  }

  /** 建物の描画ソース: "plateau" (3D Tiles 実寸) / "simple" (ローカルラスタの箱)。
   * simple は通信ゼロ・オフライン可で、軽量プリセットの建物表示に使う。 */
  setBuildingSource(mode) {
    if (mode !== "plateau" && mode !== "simple") return;
    if (this._bldgMode === mode) return;
    this._bldgMode = mode;
    if (mode === "plateau" && this.bbox && !this._bldgUrls) {
      this._loadBuildings();
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

  /** カメラをリージョン全体が見渡せる既定視点に戻す。 */
  resetView() {
    const [lonC, latC] = this.centerLonLat();
    this.deck?.setProps({
      initialViewState: { longitude: lonC, latitude: latC, zoom: 13.2, pitch: 52, bearing: -15 },
    });
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
