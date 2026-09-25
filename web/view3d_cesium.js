// CesiumJS ビュワー — PLATEAU 3D Tiles の建物を実寸で表示し、地形に沈まず
// 浮かないようにする。Zenn記事
// (https://zenn.dev/investaitech/articles/730bd6f9fa90c0) の
// 「建物が浮く」問題の解決策をそのまま実装している:
//   1. 地形の適用 (既定: 公開PLATEAU-Terrain quantized-mesh。
//      GSI DEM + GSIGEO2011合成の楕円体高なのでPLATEAU建物と垂直基準が合う。
//      Ionトークン指定時はIon asset 3258112、取得失敗時のみ自前GSI DEMに退避)
//   2. depthTestAgainstTerrain で地形の裏側を隠す
//   3. applyHeightOffset (modelMatrix平行移動) での微調整 (?hoff=メートル、通常は不要)
import { drawWaterCanvas, loadScript, pickBldgTilesets, regionBBox } from "./geo.js?v=28";

// CesiumJS は配布サイズが大きいためローカルには置かず、公式CDNから読む
const CESIUM_URL = "https://cesium.com/downloads/cesiumjs/releases/1.132/Build/Cesium/Cesium.js";
const CESIUM_CSS = "https://cesium.com/downloads/cesiumjs/releases/1.132/Build/Cesium/Widgets/widgets.css";
// PLATEAU-Terrain (Cesium Ion asset 3258112) — Ionトークンが ?ionToken= /
// localStorage で与えられたときだけ使う (記事の構成)
const PLATEAU_TERRAIN_ION_ASSET = 3258112;
// Ion不要の公開 quantized-mesh。GSI DEM + ジオイド補正済み（楕円体高）のため、
// PLATEAU建物と垂直基準が合い、手動の ?hoff= 補正を前提にしない。
const PLATEAU_TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain";
const GSI_ORT_URL = "https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg";
const GSI_DEM_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${x}/${y}.png`;
const GSI_DEM_MAX_ZOOM = 15;   // dem5a_png は z15 まで

const qs = () => new URLSearchParams(location.search);
function ionToken() {
  return qs().get("ionToken") || localStorage.getItem("cesiumIonToken") || "";
}
function heightOffsetMeters() {
  const v = Number.parseFloat(qs().get("hoff") || "");
  return Number.isFinite(v) ? v : 0;
}
/* ---------------------------------------------------------------- */
/* 公開PLATEAU-Terrainが使えない場合の退避用。国土地理院 DEM (dem5a_png) */
/* を Cesium 用の地形にする provider。タイルは 24bit RGB で            */
/* 標高(m) = (R*65536+G*256+B)/100（正標高のため、この地形では建物が約    */
/* ジオイド高ぶん浮く/沈む。既定はPLATEAU-Terrainなので通常は使われない）。*/
/* 欠測 (0x80,0x00,0x00) は周辺の有効値で補間する。z15超は親から補間。   */
/* Cesium.TerrainProvider は抽象インターフェース (インスタンス化禁止)     */
/* のため、インターフェースを実装した素のクラスとして作る。               */
/* ---------------------------------------------------------------- */
let GsiTerrainProviderClass = null;

/** Cesiumロード後に呼ぶ。 */
function makeGsiTerrainProvider() {
  const Cesium = window.Cesium;
  GsiTerrainProviderClass ??= class GsiTerrainProvider {
    constructor() {
      this._tilingScheme = new Cesium.WebMercatorTilingScheme();
      this._errorEvent = new Cesium.Event();
      this._heightmapWidth = 33;
      this._cache = new Map();   // z15 PNG のデコード結果
      this._credit = new Cesium.Credit("国土地理院「数値標高モデル5m」");
    }

    get tilingScheme() { return this._tilingScheme; }
    get ready() { return true; }
    get readyPromise() { return Promise.resolve(true); }
    get hasWaterMask() { return false; }
    get hasVertexNormals() { return false; }
    get errorEvent() { return this._errorEvent; }
    get credit() { return this._credit; }
    set credit(c) { this._credit = c; }

    getLevelMaximumGeometricError(level) {
      // 旧 Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForEllipsoid
      // と同じ式 (楕円体周 / 64 / 16)。新しめの Cesium では静的ヘルパーが無い。
      return (2 * Math.PI * this._tilingScheme.ellipsoid.maximumRadius) / (64 * 16) / (1 << level);
    }
    getTileDataAvailable() { return undefined; }   // 不明 (読んでみて決める)

    async requestTileGeometry(x, y, level) {
      let heights;
      try {
        if (level <= GSI_DEM_MAX_ZOOM) {
          const dem = await this._demTile(level, x, y);
          heights = this._sample(dem, 0, 0, dem.size, dem.size);
        } else {
          // z15超: 親タイル (z15) の該当部分を引き伸ばす
          const shift = level - GSI_DEM_MAX_ZOOM;
          const dem = await this._demTile(GSI_DEM_MAX_ZOOM, x >> shift, y >> shift);
          const span = dem.size >> shift;
          heights = this._sample(dem, (x & ((1 << shift) - 1)) * span,
            (y & ((1 << shift) - 1)) * span, span, span);
        }
      } catch {
        // 欠タイル (海など) は平坦に潰す
        heights = new Float32Array(this._heightmapWidth * this._heightmapWidth);
      }
      return new Cesium.HeightmapTerrainData({
        buffer: heights,
        width: this._heightmapWidth,
        height: this._heightmapWidth,
        childTileMask: 15,   // 子は常に親から生成できる
      });
    }

    /** dem5a PNG を読んでデコード結果 (Float32Array + size) を返す (LRU)。 */
    async _demTile(z, x, y) {
      const key = `${z}/${x}/${y}`;
      if (this._cache.has(key)) return this._cache.get(key);
      const r = await fetch(GSI_DEM_URL(z, x, y));
      if (!r.ok) throw new Error("dem tile not found");
      const blob = await r.blob();
      const bmp = await createImageBitmap(blob);
      const size = bmp.width;
      const cv = new OffscreenCanvas(size, size);
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, size, size).data;
      const dem = { size, data: this._decode(px, size) };
      bmp.close?.();
      this._cache.set(key, dem);
      if (this._cache.size > 48) {
        this._cache.delete(this._cache.keys().next().value);
      }
      return dem;
    }

    _decode(px, size) {
      const out = new Float32Array(size * size);
      for (let i = 0; i < size * size; i++) {
        const h = (px[i * 4] * 65536 + px[i * 4 + 1] * 256 + px[i * 4 + 2]) / 100;
        out[i] = h >= 32768 ? NaN : h;   // 0x80,0x00,0x00=欠測 / 0x80,0x00,0x01=海面0
      }
      // 欠測は有効値の単純平均で埋める (山がりのスパイクを防ぐ)
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          if (!Number.isNaN(out[j * size + i])) continue;
          let s = 0, n = 0;
          for (let dj = -2; dj <= 2; dj++) {
            for (let di = -2; di <= 2; di++) {
              const v = out[Math.min(size - 1, Math.max(0, j + dj)) * size
                + Math.min(size - 1, Math.max(0, i + di))];
              if (!Number.isNaN(v)) { s += v; n++; }
            }
          }
          out[j * size + i] = n ? s / n : 0;
        }
      }
      return out;
    }

    /** デコード済みDEMの一部を heightmapWidth×heightmapWidth に双線形標本。 */
    _sample(dem, sx, sy, spanX, spanY) {
      const n = this._heightmapWidth;
      const out = new Float32Array(n * n);
      const d = dem.data, size = dem.size;
      for (let j = 0; j < n; j++) {
        const fy = sy + (j / (n - 1)) * spanY;
        const y0 = Math.min(size - 1, Math.floor(fy));
        const y1 = Math.min(size - 1, y0 + 1);
        const ty = Math.min(1, Math.max(0, fy - y0));
        for (let i = 0; i < n; i++) {
          const fx = sx + (i / (n - 1)) * spanX;
          const x0 = Math.min(size - 1, Math.floor(fx));
          const x1 = Math.min(size - 1, x0 + 1);
          const tx = Math.min(1, Math.max(0, fx - x0));
          const top = d[y0 * size + x0] * (1 - tx) + d[y0 * size + x1] * tx;
          const bot = d[y1 * size + x0] * (1 - tx) + d[y1 * size + x1] * tx;
          out[j * n + i] = top * (1 - ty) + bot * ty;
        }
      }
      return out;
    }
  };
  return new GsiTerrainProviderClass();
}
/* ---------------------------------------------------------------- */
/* Zenn記事の applyHeightOffset — tileset全体を modelMatrix で上下に  */
/* 平行移動する。自前GSI DEM退避時など、地形と建物の垂直基準がずれた    */
/* 場合の手動微調整 (?hoff=メートル)。既定のPLATEAU-Terrainでは不要。 */
/* ---------------------------------------------------------------- */
function applyHeightOffset(tileset, offset) {
  if (!offset) return;
  const boundingSphere = tileset.boundingSphere;
  const cartographic = Cesium.Cartographic.fromCartesian(boundingSphere.center);
  const surface = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0.0);
  const offsetSurface = Cesium.Cartesian3.fromRadians(
    cartographic.longitude, cartographic.latitude, offset);
  const translation = Cesium.Cartesian3.subtract(offsetSurface, surface, new Cesium.Cartesian3());
  tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
}

/* ---------------------------------------------------------------- */
/* 水面メッシュ: 地形に追従する頂点変位メッシュで水深を立体表示する。   */
/* 地形高さは表示中の terrain provider を sampleTerrain で疎に測り、    */
/* ローカルDEMとの残差を補間して頂点高に使う (垂直基準ずれを吸収)。     */
/* 水深は RGBA8 テクスチャ (cm, R*256+G) を頂点シェーダで参照し、       */
/* 新規冠水セルは uFront テクスチャの wet-since 年齢で琥珀色に光らせる。*/
/* ---------------------------------------------------------------- */
// GLSL3 (WebGL2): Cesium 1.132 は #version 300 es を前置し、
// varying/texture2D/gl_FragColor は使えない。in/out/texture/out_FragColor を使う。
// GLSL3 (WebGL2)。material の fabric.source で uDepth/uFront/uUp を参照すると
// createUniform が uDepth_0/uFront_1/uUp_2 に改名して _uniforms に登録する。
// 頂点・フラグメント両方でその改名後の名前を使う。
const WATER_VERT = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec2 st;
in float batchId;
uniform sampler2D uDepth_0; // depth m = (R*255*256 + G*255)/100
uniform vec3 uUp_2;         // 地域中心のECEF上方向 (水深で持ち上げる)
out vec2 v_st;
out float v_depth;
void main() {
  v_st = st;
  vec4 t = texture(uDepth_0, st);
  float d = (t.r * 255.0 * 256.0 + t.g * 255.0) / 100.0;
  v_depth = d;
  vec4 p = czm_computePosition();
  p.xyz += uUp_2 * max(d, 0.0);   // ECEF上方向に水深分だけ持ち上げる
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

const WATER_FRAG = `
// uFront/uFlow/uTime は material.shaderSource で宣言済み (前置される)
in vec2 v_st;
in float v_depth;
vec3 depthRamp(float d) {
  vec3 c = mix(vec3(0.82, 0.95, 1.00), vec3(0.33, 0.71, 0.95), smoothstep(0.03, 0.20, d));
  c = mix(c, vec3(0.18, 0.45, 0.91), smoothstep(0.20, 0.50, d));
  c = mix(c, vec3(0.16, 0.29, 0.81), smoothstep(0.50, 1.00, d));
  c = mix(c, vec3(0.26, 0.21, 0.72), smoothstep(1.00, 2.00, d));
  c = mix(c, vec3(0.36, 0.18, 0.62), smoothstep(2.00, 3.50, d));
  return c;
}
void main() {
  if (v_depth < 0.01) discard;
  vec3 c = depthRamp(v_depth);
  // 新規冠水フロント: wet-since 年齢が浅いほど琥珀色に発光 (短時間で減衰)
  float age = texture(uFront_1, v_st).r * 255.0 * 4.0;
  float front = (age < 60.0) ? exp(-age / 18.0) : 0.0;
  c = mix(c, vec3(1.0, 0.72, 0.22), front * 0.45);
  // 流速方向に走る小さな輝度縞: 水が「流れて」見えるアニメーション。
  vec2 fl = texture(uFlow_3, v_st).gb * 2.0 - 1.0;
  float sp = length(fl);
  vec2 dir = sp > 1e-3 ? fl / sp : vec2(1.0, 0.0);
  float k = mix(80.0, 220.0, min(sp, 1.0));
  float wave = sin(dot(v_st, dir) * k - uTime_4 * (1.0 + 3.0 * sp));
  c *= 1.0 + wave * (0.03 + 0.11 * min(sp, 1.0));
  float a = clamp(v_depth * 5.0, 0.18, 0.92);
  out_FragColor = vec4(c, a);
}`;

const WATER_MESH_NX = 160;          // 水面メッシュの頂点数 (x)
const TERRAIN_SAMPLE_N = 22;        // sampleTerrain の疎グリッド幅
const FRONT_WET_M = 0.05;           // 「冠水」とみなす水深

/** RGBA8テクスチャを作る (depth cm-pack / front age 用)。 */
function makeDataTex(Cesium, ctx, w, h, u8) {
  return new Cesium.Texture({
    context: ctx,
    width: w,
    height: h,
    pixelFormat: Cesium.PixelFormat.RGBA,
    pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
    source: { arrayBufferView: u8, width: w, height: h },
    flipY: false,   // row0 = v=0 = 南 (state配列の向きに合わせる)
    sampler: new Cesium.Sampler({
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
    }),
  });
}

/** ローカルDEM (RGBA cm, row0=北) の双線形補間。u,v ∈ [0,1]、v=0 が南。 */
function demHeightAt(data, W, H, u, v) {
  const fx = Math.min(Math.max(u * (W - 1), 0), W - 1.001);
  const fy = Math.min(Math.max((1 - v) * (H - 1), 0), H - 1.001);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  const dec = (i) => (data[i * 4] * 65536 + data[i * 4 + 1] * 256 + data[i * 4 + 2]) / 100;
  const top = dec(y0 * W + x0) * (1 - ax) + dec(y0 * W + x1) * ax;
  const bot = dec(y1 * W + x0) * (1 - ax) + dec(y1 * W + x1) * ax;
  return top * (1 - ay) + bot * ay;
}
export class CesiumView {
  name = "cesium";

  constructor(container) {
    this.container = container;    // Cesiumウィジェットを入れる親要素 (#cesium3d)
    this.viewer = null;
    this.ready = this._init();
    this.showBuildings = true;
    this.showPhoto = true;
    this.stats = { tilesLoaded: 0, bytesLoaded: 0 };
    // ?lod=1 で軽量LOD1 / 既定はLOD2 — 軽さ比較用
    this._lod = new URLSearchParams(location.search).get("lod") === "1" ? "1" : "2";
    this._tilesets = [];
    this._waterLayer = null;
    this._waterBlobUrl = null;
    this._waterCanvas = document.createElement("canvas");
    // WaterDepth マテリアルのテクスチャユニフォーム初期値 (未設定だと
    // Material生成で undefined.type を読んで例外になりメッシュが作れない)
    this._depthCanvas = Object.assign(document.createElement("canvas"), { width: 4, height: 4 });
    this._frontCanvas = Object.assign(document.createElement("canvas"), { width: 4, height: 4 });
    this._lastWaterAt = 0;
    this._frameCount = 0;
    // 水面メッシュ (地形追従の頂点変位) とフォールバック用フラットレイヤ
    this._waterPrim = null;
    this._waterAppearance = null;
    this._depthTex = null;
    this._frontTex = null;
    this._frontAge = null;    // Float32Array セル毎の wet-since 秒
    this._wet = null;         // Uint8Array 冠水フラグ
    this._terrGrid = null;    // {n, heights} sampleTerrain の疎グリッド
    this._terrOff = 0;        // ローカルDEM→表示地形のオフセット (fallback用)
    this._meshPromise = null;
    // 流れの表示: earth.nullschool 風ストリーク (画面空間キャンバス)
    this._flowOn = false;
    this._flowField = null;   // {qx, qy, h, gw, gh, qmax} (粗い再配置用)
    this._streaks = null;     // {parts, cv, ctx, dpr} ストリーク状態
    this._camMoving = false;  // カメラ移動中はストリークを描かない (パララックス残像防止)
    // 分水域・流路オーバーレイ
    this._streamsLayer = null;
    this._streamsOn = false;
    this._streamsCanvas = null;
    this._bldgGen = 0;        // _loadBuildings の世代カウンタ (競合防止)
  }

  async _init() {
    await loadScript(CESIUM_URL, "cesium-script");
    await loadCss(CESIUM_CSS, "cesium-widgets-css");
    const Cesium = window.Cesium;
    if (!Cesium) throw new Error("CesiumJS を初期化できませんでした");
    const token = ionToken();
    if (token) Cesium.Ion.defaultAccessToken = token;
    const viewer = new Cesium.Viewer(this.container, {
      // 既定のBing/Ionに頼らない: 航空写真は国土地理院、地形はPLATEAU-Terrain
      baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: GSI_ORT_URL,
        credit: new Cesium.Credit("国土地理院 航空写真(ort)"),
        maximumLevel: 17,
      })),
      terrainProvider: await this._makeTerrainProvider(),
      baseLayerPicker: false, geocoder: false, homeButton: false,
      sceneModePicker: false, navigationHelpButton: false, animation: false,
      timeline: false, fullscreenButton: false, infoBox: false,
      selectionIndicator: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
      // 3D専用: 2D/Columbus用の boundingSphereCV 計算を省き、
      // FLOAT位置のカスタムPrimitiveが projectTo2D で落ちるのを防ぐ
      scene3DOnly: true,
    });
    this.viewer = viewer;
    this.canvas = viewer.canvas;   // スクリーンショット用 (app.js互換)
    viewer.scene.globe.depthTestAgainstTerrain = true;   // 記事の設定
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#9cc0e0");
    viewer.scene.postRender.addEventListener(() => {
      this._frameCount++;
      this._stepStreaks();
      const u = this._waterAppearance?.material?.uniforms;
      if (u) u.uTime = performance.now() / 1000;
    });
    if (this._pendingRegion) this.setRegion(...this._pendingRegion);
    return this;
  }

  /** 地形provider選択: 公開PLATEAU-Terrain優先、失敗時のみ自前GSI DEM。 */
  async _makeTerrainProvider() {
    const Cesium = window.Cesium;
    const token = ionToken();
    if (token) {
      try {
        return await Cesium.CesiumTerrainProvider.fromIonAssetId(
          PLATEAU_TERRAIN_ION_ASSET);
      } catch (e) {
        console.warn("PLATEAU-Terrain (Ion) を使えず公開 quantized-mesh を試す: ", e);
      }
    }
    try {
      return await Cesium.CesiumTerrainProvider.fromUrl(
        PLATEAU_TERRAIN_URL, { requestVertexNormals: true });
    } catch (e) {
      console.warn("公開PLATEAU-Terrainを使えず GSI DEM 地形にフォールバック: ", e);
      return makeGsiTerrainProvider();
    }
  }

  setOrigin(left, top) {
    this._left = left;
    this._top = top;
  }

  setRegion(W, H, mPerPx, terrainData, bldgData, photoCanvas, stateW, stateH) {
    this._pendingRegion = [W, H, mPerPx, terrainData, bldgData, photoCanvas, stateW, stateH];
    this.stateW = stateW || W;
    this.stateH = stateH || H;
    this._regionTerrain = terrainData ? { data: terrainData, W, H } : null;
    this.bbox = regionBBox({ W, H, dx: mPerPx, left: this._left || 0, top: this._top || 0 },
      window.__meta);
    // Cesium CDN が読めていない/viewer未初期化なら bbox だけ保持して退避
    if (!window.Cesium || !this.viewer) return;
    // リージョン変更: 水面メッシュ・冠水履歴・流線を作り直す
    this._frontAge = null;
    this._wet = null;
    this._terrGrid = null;
    this._meshPromise = null;
    this._flowField = null;
    if (this._streaks) this._streaks.parts = [];   // リージョン変更で粒子を撒き直す
    if (this._waterPrim) {
      this.viewer.scene.primitives.remove(this._waterPrim);
      this._waterPrim = null;
      this._waterAppearance = null;
    }
    if (this._waterLayer) {
      this.viewer.imageryLayers.remove(this._waterLayer, true);
      this._waterLayer = null;
    }
    if (this._streamsLayer) {
      this.viewer.imageryLayers.remove(this._streamsLayer, true);
      this._streamsLayer = null;
      this._streamsOn = false;
    }
    this._initStreaks();
    this._ensureWaterMesh();
    const [west, south, east, north] = this.bbox;
    const lonC = (west + east) / 2, latC = (south + north) / 2;
    // 範囲の対角 (~km) からカメラ距離を決め、南西から見下ろす。
    // three.js版の初期視点 (斜め上から範囲全体) に合わせる。
    const spanKm = Math.hypot((east - west) * 91, (north - south) * 111);
    const target = Cesium.Cartesian3.fromDegrees(lonC, latC, 0);
    this.viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(-20), Cesium.Math.toRadians(-38),
      Math.min(Math.max(spanKm * 820, 1600), 60000)));
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);   // 操作可能に戻す
    this._loadBuildings();
  }

  /** bbox と重なる全区の PLATEAU 建物タイルセットを読む (区境またぎ対応)。 */
  async _loadBuildings() {
    const gen = ++this._bldgGen;   // リージョン変更ごとに増え、古いロードを無効化
    const picks = await pickBldgTilesets(this.bbox, this._lod || "2");
    if (gen !== this._bldgGen) return;              // 別リージョンに切り替わった
    const key = picks.map((p) => p.url).join("|");
    if (this._bldgKey === key) return;
    this._bldgKey = key;
    this._wardName = picks.map((p) => p.ward).join("・");
    this.stats.tilesLoaded = 0;
    this.stats.bytesLoaded = 0;
    const Cesium = window.Cesium;
    if (this._tilesets) {
      for (const t of this._tilesets) this.viewer.scene.primitives.remove(t);
    }
    this._tilesets = [];
    for (const pick of picks) {
      try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(pick.url, {
          maximumScreenSpaceError: 16,
          showCreditsOnScreen: true,
        });
        if (gen !== this._bldgGen) {                // ロード中にリージョン変更
          this.viewer.scene.primitives.remove(tileset);
          continue;
        }
        // 記事の解決策: 地形適用後のわずかなずれは modelMatrix で調整する
        applyHeightOffset(tileset, heightOffsetMeters());
        tileset.show = this.showBuildings;
        this._tilesets.push(tileset);
        this.viewer.scene.primitives.add(tileset);
        tileset.tileLoad.addEventListener((tile) => {
          this.stats.tilesLoaded++;
          this.stats.bytesLoaded += tile.content?.byteLength ?? tile.byteLength ?? 0;
        });
      } catch (e) {
        console.warn(`PLATEAU tileset (${pick.ward}) の読み込みに失敗: `, e);
      }
    }
  }

  /**
   * シミュレーション状態 → 水面メッシュの水深テクスチャを更新。
   * メッシュ未準備の間だけフラットな画像レイヤにフォールバックする。
   */
  updateWater(rgba) {
    if (!this.viewer || !this.bbox) return;
    const now = performance.now();
    if (now - this._lastWaterAt < 250) return;
    this._lastWaterAt = now;
    this._stateData = rgba;
    this._updateFront(rgba);
    if (this._waterAppearance) {
      this._uploadWaterTextures(rgba);
      // メッシュが立ち上がったらフラットレイヤは外す
      if (this._waterLayer) {
        this.viewer.imageryLayers.remove(this._waterLayer, true);
        this._waterLayer = null;
      }
      return;
    }
    this._ensureWaterMesh();
    this._updateWaterImagery(rgba);
  }

  /** フォールバック: 水深キャンバスを地形にドレープする画像レイヤ。 */
  _updateWaterImagery(rgba) {
    drawWaterCanvas(this._waterCanvas, rgba, this.stateW, this.stateH, 1024);
    this._waterCanvas.toBlob(async (blob) => {
      if (!blob || !this.viewer) return;
      const Cesium = window.Cesium;
      if (this._waterBlobUrl) URL.revokeObjectURL(this._waterBlobUrl);
      this._waterBlobUrl = URL.createObjectURL(blob);
      try {
        const provider = await Cesium.SingleTileImageryProvider.fromUrl(
          this._waterBlobUrl,
          { rectangle: Cesium.Rectangle.fromDegrees(...this.bbox) },
        );
        if (this._waterLayer) this.viewer.imageryLayers.remove(this._waterLayer, true);
        this._waterLayer = new Cesium.ImageryLayer(provider);
        this.viewer.imageryLayers.add(this._waterLayer);
      } catch (e) {
        console.warn("水面レイヤーの更新に失敗: ", e);
      }
    }, "image/png");
  }

  /**
   * 表示中の地形を疎にサンプリングし、ローカルDEMとの残差グリッドを作る。
   * 水面メッシュの頂点高は ローカルDEM + 残差補間 で求める
   * (楕円体高/正標高の基準差を吸収するため)。
   */
  async _sampleTerrainGrid() {
    const Cesium = window.Cesium;
    const [west, south, east, north] = this.bbox;
    const n = TERRAIN_SAMPLE_N;
    const positions = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        positions.push(Cesium.Cartographic.fromDegrees(
          west + (east - west) * i / (n - 1),
          south + (north - south) * j / (n - 1)));
      }
    }
    try {
      await Cesium.sampleTerrain(this.viewer.terrainProvider, 14, positions);
      const heights = new Float64Array(n * n);
      for (let i = 0; i < n * n; i++) heights[i] = positions[i].height || 0;
      this._terrGrid = { n, heights };
    } catch (e) {
      // 自前GSI provider 等で sampleTerrain が使えない場合は
      // ローカルDEM + 平均ジオイド差 (~37m) に退避する
      console.warn("terrain sampling failed; using local DEM + offset", e);
      this._terrGrid = null;
      this._terrOff = 37;
    }
  }

  /** 表示地形の高さ [m] (u,v ∈ [0,1]、v=0 が南)。 */
  _terrainHeightAt(u, v) {
    const g = this._terrGrid;
    if (!g) {
      const t = this._regionTerrain;
      return t ? demHeightAt(t.data, t.W, t.H, u, v) + this._terrOff : this._terrOff;
    }
    const n = g.n;
    const fx = Math.min(Math.max(u * (n - 1), 0), n - 1.001);
    const fy = Math.min(Math.max(v * (n - 1), 0), n - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const top = g.heights[y0 * n + x0] * (1 - ax) + g.heights[y0 * n + x1] * ax;
    const bot = g.heights[y1 * n + x0] * (1 - ax) + g.heights[y1 * n + x1] * ax;
    return top * (1 - ay) + bot * ay;
  }

  /**
   * 水面メッシュを構築する。頂点はローカルENU座標 (中心原点)、
   * 高さは表示地形 + 頂点シェーダでの水深変位。
   */
  async _ensureWaterMesh() {
    if (this._meshPromise || this._waterAppearance || !this.viewer || !this.bbox) return;
    this._meshPromise = (async () => {
      const Cesium = window.Cesium;
      const [west, south, east, north] = this.bbox;
      if (!this._terrGrid) await this._sampleTerrainGrid();
      const nx = WATER_MESH_NX;
      const ny = Math.max(8, Math.round(nx * this.stateH / this.stateW));
      const lonC = (west + east) / 2, latC = (south + north) / 2;
      const mPerDegLon = 111320 * Math.cos(Cesium.Math.toRadians(latC));
      const mPerDegLat = 110540;
      const wM = (east - west) * mPerDegLon, hM = (north - south) * mPerDegLat;
      const pos = new Float32Array(nx * ny * 3);
      const st = new Float32Array(nx * ny * 2);
      // 位置はECEFで直接作る (modelMatrix=恒等)。ローカルENUだと
      // boundingSphereCV の projectTo2D が (0,0,0) 中心で失敗するため。
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const u = i / (nx - 1), v = j / (ny - 1);
          const lon = west + (east - west) * u;
          const lat = south + (north - south) * v;
          const c = Cesium.Cartesian3.fromDegrees(lon, lat, this._terrainHeightAt(u, v));
          const k = (j * nx + i) * 3;
          pos[k] = c.x; pos[k + 1] = c.y; pos[k + 2] = c.z;
          const s = (j * nx + i) * 2;
          st[s] = u; st[s + 1] = v;
        }
      }
      const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
      let o = 0;
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
          idx[o++] = a; idx[o++] = c; idx[o++] = b;
          idx[o++] = b; idx[o++] = c; idx[o++] = d;
        }
      }
      const geo = new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            values: pos,
          }),
          st: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: st,
          }),
        },
        indices: idx,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromPoints(
          Array.from({ length: nx * ny }, (_, i) =>
            new Cesium.Cartesian3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]))),
      });
      const material = new Cesium.Material({
        fabric: {
          type: "WaterDepth",
          uniforms: {
            uDepth: this._depthCanvas,
            uFront: this._frontCanvas,
            uUp: Cesium.Cartesian3.normalize(
              Cesium.Cartesian3.fromDegrees(lonC, latC, 0), new Cesium.Cartesian3()),
            uFlow: this._frontCanvas,   // プレースホルダ: 後で実データに差し替え
            uTime: 0.0,
          },
          // source 内で各ユニフォームを参照すると createUniform が
          // uDepth_0/uFront_1/uUp_2/uFlow_3/uTime_4 に改名して宣言・バインドする
          // (uniforms オブジェクトの挿入順)。vertex/fragment でその名前を使う。
          source: "czm_material czm_getMaterial(czm_materialInput materialInput) {\n"
            + "  czm_material m = czm_getDefaultMaterial(materialInput);\n"
            + "  m.diffuse = texture(uDepth, materialInput.st).rgb\n"
            + "    + texture(uFront, materialInput.st).rgb\n"
            + "    + texture(uFlow, materialInput.st).rgb\n"
            + "    + uUp + vec3(uTime) * 0.0;\n"
            + "  return m;\n"
            + "}\n",
        },
      });
      this._waterAppearance = new Cesium.Appearance({
        vertexShaderSource: WATER_VERT,
        fragmentShaderSource: WATER_FRAG,
        material: material,
        renderState: {
          depthTest: { enabled: true },
          depthMask: false,
          blending: Cesium.BlendingState.ALPHA_BLEND,
        },
      });
      this._waterPrim = new Cesium.Primitive({
        geometryInstances: [new Cesium.GeometryInstance({ geometry: geo })],
        appearance: this._waterAppearance,
        asynchronous: false,
        // batchId は allowPicking=true のときだけ頂点属性として宣言される。
        // false だと appendPickToVertexShader が未定義の batchId を参照して落ちる。
        allowPicking: true,
      });
      this.viewer.scene.primitives.add(this._waterPrim);
    })().catch((e) => {
      console.warn("水面メッシュの構築に失敗 (フラットレイヤに継続): ",
        e && (e.message || e.stack || JSON.stringify(e)));
      this._waterAppearance = null;
    });
    await this._meshPromise;
  }

  /** 水深・流速・冠水年齢テクスチャを最新の状態で作り直す。 */
  _uploadWaterTextures(rgba) {
    const Cesium = window.Cesium;
    const ctx = this.viewer.scene.context;
    const n = this.stateW * this.stateH;
    const depth = new Uint8Array(n * 4);
    const front = new Uint8Array(n * 4);
    const flow = new Uint8Array(n * 4);
    // 流速は領域全体の最大値で正規化して [-1,1] → [0,255] に詰める。
    let qmax = 0.02;
    for (let i = 0; i < n; i += 4) {
      const sp = Math.hypot(rgba[i * 4 + 1], rgba[i * 4 + 2]);
      if (sp > qmax) qmax = sp;
    }
    for (let i = 0; i < n; i++) {
      const cm = Math.min(65535, Math.max(0, Math.round(rgba[i * 4] * 100)));
      depth[i * 4] = cm >> 8;
      depth[i * 4 + 1] = cm & 0xff;
      depth[i * 4 + 3] = 255;
      const age = Math.min(255, Math.round(this._frontAge[i] / 4));
      front[i * 4] = age;
      front[i * 4 + 3] = 255;
      flow[i * 4 + 1] = Math.round((rgba[i * 4 + 1] / qmax * 0.5 + 0.5) * 255);
      flow[i * 4 + 2] = Math.round((rgba[i * 4 + 2] / qmax * 0.5 + 0.5) * 255);
      flow[i * 4 + 3] = 255;
    }
    // 実行時は Texture を直接代入できる (update関数が instanceof Texture を処理)。
    // 旧テクスチャは material.update() が破棄するのでここでは触らない。
    const u = this._waterAppearance.material.uniforms;
    u.uDepth = makeDataTex(Cesium, ctx, this.stateW, this.stateH, depth);
    u.uFront = makeDataTex(Cesium, ctx, this.stateW, this.stateH, front);
    u.uFlow = makeDataTex(Cesium, ctx, this.stateW, this.stateH, flow);
  }

  /** 冠水フロント: 各セルの wet-since 年齢を更新する。状態が変わったときだけ年齢を進める。 */
  _updateFront(rgba) {
    const n = this.stateW * this.stateH;
    if (!this._frontAge || this._frontAge.length !== n) {
      this._frontAge = new Float32Array(n).fill(1e9);
      this._wet = new Uint8Array(n);
      this._frontAt = performance.now();
      this._frontSig = -1;
    }
    // 同一状態 (停止中・リプレイの同一フレーム) では年齢を進めない。
    // 軽量チェックサムで変化検出する。
    let sig = 0;
    for (let i = 0; i < n; i += 16) sig += rgba[i * 4];
    if (sig === this._frontSig) return;
    this._frontSig = sig;
    const now = performance.now();
    const dt = Math.min(5, (now - this._frontAt) / 1000);
    this._frontAt = now;
    for (let i = 0; i < n; i++) {
      const wet = rgba[i * 4] > FRONT_WET_M ? 1 : 0;
      if (wet && !this._wet[i]) this._frontAge[i] = 0;
      else this._frontAge[i] += dt;
      this._wet[i] = wet;
    }
  }

  /* ---------------- 水流ストリーク (earth.nullschool 風) ---------------- */

  /** 状態RGBA (h,qx,qy) の (u,v) サンプル。v=0 が南。out={vx,vy,h}. */
  _streakSample(u, v, out) {
    const d = this._stateData, W = this.stateW, H = this.stateH;
    if (!d || !W || !H) { out.h = 0; out.vx = 0; out.vy = 0; return; }
    const i = Math.min(W - 1, Math.max(0, (u * (W - 1)) | 0));
    const j = Math.min(H - 1, Math.max(0, (v * (H - 1)) | 0));
    const k = (j * W + i) * 4;
    const h = d[k];
    out.h = h;
    if (h > 1e-4) { out.vx = d[k + 1] / h; out.vy = d[k + 2] / h; }
    else { out.vx = 0; out.vy = 0; }
  }
  /** 湿った流れのあるセルへ粒子を撒き直す。遠くでは重要度で絞る。 */
  _streakRespawn(p, minScore) {
    const smp = this._streakSmp;
    for (let a = 0; a < 20; a++) {
      const u = Math.random(), v = Math.random();
      this._streakSample(u, v, smp);
      if (smp.h < 0.03) continue;
      const sp = Math.hypot(smp.vx, smp.vy);
      if (sp < 0.02) continue;
      if (smp.h * sp < minScore) continue;   // 遠景では流量の大きい流路だけ
      p.u = u; p.v = v; p.age = 0;
      p.life = 1800 + Math.random() * 2400;
      return true;
    }
    return false;
  }

  /** 画面空間のストリークオーバーレイを構築する。 */
  _initStreaks() {
    if (this._streaks) return;
    const cv = document.createElement("canvas");
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;"
      + "pointer-events:none;z-index:3;";
    this.container.appendChild(cv);
    this._streaks = {
      cv, ctx: cv.getContext("2d"),
      parts: [], smp: { vx: 0, vy: 0, h: 0 },
      gain: 400,                 // v (m/s) → px/s の見た目ゲイン
      minScore: 0,               // LOD: 表示に必要な最小 |q| = h·v
      lastT: 0,
    };
    this._streakSmp = { vx: 0, vy: 0, h: 0 };
    const Cesium = window.Cesium;
    // カメラ移動中は残像をクリア (パララックスで古いストリークが残るため)
    this.viewer.camera.moveStart.addEventListener(() => {
      this._camMoving = true;
      const s = this._streaks;
      if (s) s.ctx.clearRect(0, 0, s.cv.width, s.cv.height);
    });
    this.viewer.camera.moveEnd.addEventListener(() => { this._camMoving = false; });
  }

  /** ストリーク粒子を (再)生成する。 */
  _seedStreaks() {
    const s = this._streaks;
    const area = this.container.clientWidth * this.container.clientHeight;
    const n = Math.min(4000, Math.max(1200, Math.round(area / 900)));
    s.parts = [];
    for (let i = 0; i < n; i++) {
      const p = { u: Math.random(), v: Math.random(), age: Math.random() * 2000, life: 0 };
      this._streakRespawn(p, 0);
      s.parts.push(p);
    }
  }

  /** postRender: ストリークを1フレーム進めて描画する。 */
  _stepStreaks() {
    const s = this._streaks;
    if (!this._flowOn || !s || !this._stateData || !this.bbox || !this.viewer) return;
    if (!s.parts.length) this._seedStreaks();   // _stateData到着後に遅延シード
    const Cesium = window.Cesium;
    const cv = s.cv;
    const w = this.container.clientWidth, hgt = this.container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr);
    }
    const ctx = s.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 前フレームを薄める。遠景では粒子の見え方が小さいので早めに消す。
    const camH = this.viewer.camera.positionCartographic.height;
    const lod = Math.min(1, Math.max(0.10, 2500 / Math.max(camH, 800)));   // 高い→小
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0,0,0,${(0.10 + 0.20 * (1 - lod)).toFixed(2)})`;
    ctx.fillRect(0, 0, w, hgt);
    if (this._camMoving) { ctx.globalCompositeOperation = "source-over"; return; }

    const now = performance.now();
    const dt = Math.min(80, now - (s.lastT || now)) / 1000;
    s.lastT = now;
    s.minScore = 0.004 / lod;      // |q| (m²/s) の下限: 遠いほど大きい流れのみ
    s.gain = 420 / Math.max(0.5, Math.min(3, camH / 5000));   // 近い→緩やか
    const active = Math.max(1, Math.floor(s.parts.length * lod));
    // 遠景 (高い) では粒子数を絞り、代表的な流れだけ残す。
    const [west, south, east, north] = this.bbox;
    const lonSpan = east - west, latSpan = north - south;
    // 1度あたりの概算メートル (緯度35°)
    const mLon = lonSpan * 91000, mLat = latSpan * 111000;
    const smp = s.smp;
    const C3 = Cesium.Cartesian3;
    const wgs = new C3();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let pi = 0; pi < active; pi++) {
      const p = s.parts[pi];
      p.age += dt * 1000;
      this._streakSample(p.u, p.v, smp);
      let sp = Math.hypot(smp.vx, smp.vy);
      const dry = smp.h < 0.03 || sp < 0.02 || smp.h * sp < s.minScore;
      if (dry || p.age > p.life) {
        if (!this._streakRespawn(p, s.minScore)) { p.age = 0; continue; }
        this._streakSample(p.u, p.v, smp);
        sp = Math.hypot(smp.vx, smp.vy);
      }
      // 画面速度 = 実速度を見た目に変換 (遅い水はじわっと、急流は速く)
      const pxS = Math.min(28, (16 + 300 * Math.min(1, sp / 3.0)) * dt);   // px/frame
      if (pxS < 0.15) continue;
      const lon = west + p.u * lonSpan, lat = south + p.v * latSpan;
      const z = this._terrainHeightAt(p.u, p.v) + Math.max(smp.h, 0) + 0.6;
      C3.fromDegrees(lon, lat, z, Cesium.Ellipsoid.WGS84, wgs);
      const scr = Cesium.SceneTransforms.worldToWindowCoordinates(this.viewer.scene, wgs);
      if (!scr || scr.x < -40 || scr.x > w + 40 || scr.y < -40 || scr.y > hgt + 40) {
        this._streakRespawn(p, s.minScore);
        continue;
      }
      // 流れ方向に2m先をプローブ投影し、画面上の向きを得る
      const inv = 2 / Math.max(sp, 1e-6);                    // 2m先までの係数
      const lon2 = lon + smp.vx * inv / 91000;
      const lat2 = lat + smp.vy * inv / 111000;
      C3.fromDegrees(lon2, lat2, z, Cesium.Ellipsoid.WGS84, wgs);
      const scr2 = Cesium.SceneTransforms.worldToWindowCoordinates(this.viewer.scene, wgs);
      let dx, dy;
      if (scr2) {
        dx = scr2.x - scr.x; dy = scr2.y - scr.y;
        const n = Math.hypot(dx, dy);
        if (n < 0.01) { dx = pxS; dy = 0; }
        else { dx = dx / n * pxS; dy = dy / n * pxS; }
      } else { dx = pxS; dy = 0; }
      // 粒子のワールド位置を流れ方向に pxS 分だけ進める
      // (px→uv の逆算は近似: 画面上の pxS に対応する uv 変位を求める)
      const pxPerM = Math.abs(scr2 ? Math.hypot(scr2.x - scr.x, scr2.y - scr.y) / 2 : 0) || 1e-6;
      const stepM = Math.min(200, pxS / Math.max(pxPerM, 1e-6));  // 世界移動は200m/frameで上限
      p.u += (smp.vx / Math.max(sp, 1e-6)) * stepM / Math.max(mLon, 1);
      p.v += (smp.vy / Math.max(sp, 1e-6)) * stepM / Math.max(mLat, 1);
      const t = Math.min(1, Math.pow(Math.min(sp / 2.5, 1), 0.6));
      const a = (0.25 + 0.75 * t) * Math.min(1, smp.h / 0.4);
      ctx.strokeStyle = `rgba(${Math.round(120 + 135 * t)},${Math.round(200 + 55 * t)},255,${a.toFixed(2)})`;
      ctx.lineWidth = 1.1 + 1.8 * t;
      ctx.beginPath();
      ctx.moveTo(scr.x, scr.y);
      ctx.lineTo(scr.x + dx, scr.y + dy);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  setFlowEnabled(v) {
    this._flowOn = !!v;
    if (v && !this._streaks) this._initStreaks();
    if (v && this._streaks && !this._streaks.parts.length) this._seedStreaks();
    if (this._streaks) this._streaks.cv.style.display = v ? "" : "none";
  }

  /** 分水域・流路オーバーレイ (streams.png) を地形にドレープする。 */
  setStreamsVisible(v) {
    this._streamsOn = !!v;
    if (this._streamsLayer) this._streamsLayer.show = !!v;
    else if (v && this._streamsCanvas) this._addStreamsLayer();
  }

  setStreamsCanvas(img) {
    // img は HTMLImageElement か canvas。null ならオーバーレイを外す。
    if (!img) {
      this._streamsCanvas = null;
      if (this._streamsLayer) {
        this.viewer.imageryLayers.remove(this._streamsLayer, true);
        this._streamsLayer = null;
      }
      return;
    }
    // Cesium の SingleTileImageryProvider は Blob URL が要るので
    // canvas に焼いてから toBlob する。
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    this._streamsCanvas = c;
    if (this._streamsOn) this._addStreamsLayer();
  }

  async _addStreamsLayer() {
    if (!this.viewer || !this.bbox || !this._streamsCanvas) return;
    const Cesium = window.Cesium;
    // 非同期処理の間にリージョンが変わると古い bbox に張り付くので、
    // 呼び出し時点の bbox/canvas を捕まえて完了時に照合する。
    const bbox = this.bbox, canvas = this._streamsCanvas;
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob || this.bbox !== bbox || this._streamsCanvas !== canvas) return;
    const url = URL.createObjectURL(blob);
    try {
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(url, {
        rectangle: Cesium.Rectangle.fromDegrees(...bbox),
      });
      if (this.bbox !== bbox) { URL.revokeObjectURL(url); return; }
      if (this._streamsLayer) this.viewer.imageryLayers.remove(this._streamsLayer, true);
      this._streamsLayer = new Cesium.ImageryLayer(provider, { alpha: 0.45 });
      this._streamsLayer.show = this._streamsOn;
      this.viewer.imageryLayers.add(this._streamsLayer);
    } catch (e) {
      console.warn("流路オーバーレイの追加に失敗: ", e);
    }
  }

  setWaves() { }
  setExag() { }                  // 真スケール
  setPhotoCanvas() { }           // 航空写真はGSI ortタイルをベースレイヤで使う
  /** ベンチモード用カメラパス: 0〜2/3は範囲周回、以降は中心へ寄る。 */
  benchCamera(t, total) {
    const [lon, lat] = this.centerLonLat();
    if (t < total * 2 / 3) {
      const u = t / (total * 2 / 3) * Math.PI * 2;
      const r = 0.006;
      this.setCamera({
        lonC: lon + Math.sin(u) * r, latC: lat + Math.cos(u) * r,
        height: 2600, heading: Math.sin(u) * 40, pitch: -35,
      });
    } else {
      this.setCamera({ lonC: lon, latC: lat - 0.004, height: 1100, heading: 10, pitch: -50 });
    }
  }
  setPhotoVisible(v) {
    this.showPhoto = v;
    if (this.viewer) this.viewer.imageryLayers.get(0).show = v;
  }
  setBuildingsVisible(v) {
    this.showBuildings = v;
    if (this._tilesets) for (const t of this._tilesets) t.show = v;
  }

  /** 駅・ランドマークを文字ラベルで表示する。 */
  setLocations(list) {
    this._locations = list;
    if (!this.viewer) return;
    const Cesium = window.Cesium;
    if (this._labelEntities) {
      for (const e of this._labelEntities) this.viewer.entities.remove(e);
    }
    this._labelEntities = [];
    for (const loc of list) {
      const e = this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat, 0),
        label: {
          text: loc.name,
          font: "600 13px 'Segoe UI', 'Hiragino Sans', sans-serif",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString("#0b1c2c"),
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(800, 1.0, 12000, 0.45),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000),
        },
        point: {
          pixelSize: 5,
          color: Cesium.Color.fromCssColorString("#ffd166"),
          outlineColor: Cesium.Color.fromCssColorString("#0b1c2c"),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(800, 1.0, 12000, 0.4),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 30000),
        },
      });
      this._labelEntities.push(e);
    }
  }
  setBuildingLoad(lod) {
    this._lod = lod;
    this._bldgKey = null;
    if (this.bbox) this._loadBuildings();
  }

  zoomBy(f) {
    if (!this.viewer) return;
    const h = this.viewer.camera.positionCartographic.height;
    this.viewer.camera.zoomIn((1 - f) * h * 0.8);
  }

  setCamera({ lonC, latC, height, heading, pitch }) {
    if (!this.viewer) return;
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lonC, latC, height),
      orientation: {
        heading: Cesium.Math.toRadians(heading ?? 0),
        pitch: Cesium.Math.toRadians(pitch ?? -35), roll: 0
      },
    });
  }
  getCamera() {
    if (!this.viewer) return null;
    const c = this.viewer.camera.positionCartographic;
    return {
      lonC: Cesium.Math.toDegrees(c.longitude), latC: Cesium.Math.toDegrees(c.latitude),
      height: c.height, heading: Cesium.Math.toDegrees(this.viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(this.viewer.camera.pitch)
    };
  }
  centerLonLat() {
    const b = this.bbox;
    return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [136.906, 35.17];
  }

  resize() {
    this.viewer?.resize();
  }
  getFrameCount() { return this._frameCount; }
  getPerf() {
    const Cesium = window.Cesium;
    const req = Cesium?.RequestScheduler.statistics ?? {};
    const mem = this._tilesets?.[0]?.statistics;
    return {
      tiles: this.stats.tilesLoaded, bytes: this.stats.bytesLoaded,
      ward: this._wardName, requests: req.numberOfActiveRequests ?? null,
      commands: mem?.numberOfCommands ?? null, tried: mem?.visited ?? null
    };
  }
  ensureFrame() {
    this.viewer?.render();
  }
  hide() {
    if (this.viewer) this.viewer.useDefaultRenderLoop = false;   // 非表示中は描画停止
  }
  show() {
    if (this.viewer) {
      this.viewer.useDefaultRenderLoop = true;
      this.viewer.resize();
    }
  }
}

async function loadCss(href, id) {
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
  await new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
}
