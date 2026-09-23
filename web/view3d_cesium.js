// CesiumJS ビュワー — PLATEAU 3D Tiles の建物を実寸で表示し、地形に沈まず
// 浮かないようにする。Zenn記事
// (https://zenn.dev/investaitech/articles/730bd6f9fa90c0) の
// 「建物が浮く」問題の解決策をそのまま実装している:
//   1. 地形の適用 (記事: PLATEAU-Terrain / Ion asset 3258112。トークンが無い
//      環境向けに国土地理院 DEM から作る自前 terrain provider を既定にする)
//   2. depthTestAgainstTerrain で地形の裏側を隠す
//   3. applyHeightOffset (modelMatrix平行移動) での微調整 (?hoff=メートル)
// 水面はシミュレーション状態のキャンバスを SingleTileImageryProvider で
// 地形にドレープする (水深色は 2D/three.js版と同じランプ)。

import { drawWaterCanvas, loadScript, pickBldgTileset, regionBBox } from "./geo.js?v=27";

// CesiumJS は配布サイズが大きいためローカルには置かず、公式CDNから読む
const CESIUM_URL = "https://cesium.com/downloads/cesiumjs/releases/1.132/Build/Cesium/Cesium.js";
const CESIUM_CSS = "https://cesium.com/downloads/cesiumjs/releases/1.132/Build/Cesium/Widgets/widgets.css";
// PLATEAU-Terrain (Cesium Ion asset 3258112) — Ionトークンが ?ionToken= /
// localStorage で与えられたときだけ使う (記事の構成)
const PLATEAU_TERRAIN_ION_ASSET = 3258112;
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
/* 国土地理院 DEM (dem5a_png) から Cesium 用の地形を作る provider。   */
/* タイルは 24bit RGB で 標高(m) = (R*65536+G*256+B)/100。           */
/* 欠測 (0x80,0x00,0x00) は周辺の有効値で補間する。z15超は親から補間。*/
/* Cesium.TerrainProvider は抽象インターフェース (インスタンス化禁止) */
/* のため、インターフェースを実装した素のクラスとして作る。           */
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
/* 平行移動し、地形とのわずかなずれを吸収する。                      */
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
    this._tileset = null;
    this._waterLayer = null;
    this._waterBlobUrl = null;
    this._waterCanvas = document.createElement("canvas");
    this._lastWaterAt = 0;
    this._frameCount = 0;
  }

  async _init() {
    await loadScript(CESIUM_URL, "cesium-script");
    await loadCss(CESIUM_CSS, "cesium-widgets-css");
    const Cesium = window.Cesium;
    if (!Cesium) throw new Error("CesiumJS を初期化できませんでした");
    const token = ionToken();
    if (token) Cesium.Ion.defaultAccessToken = token;
    const viewer = new Cesium.Viewer(this.container, {
      // 既定のBing/Ionに頼らない: 航空写真は国土地理院、地形はGSI DEM
      baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: GSI_ORT_URL,
        credit: new Cesium.Credit("国土地理院 航空写真(ort)"),
        maximumLevel: 17,
      })),
      terrainProvider: makeGsiTerrainProvider(),
      baseLayerPicker: false, geocoder: false, homeButton: false,
      sceneModePicker: false, navigationHelpButton: false, animation: false,
      timeline: false, fullscreenButton: false, infoBox: false,
      selectionIndicator: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    });
    this.viewer = viewer;
    this.canvas = viewer.canvas;   // スクリーンショット用 (app.js互換)
    viewer.scene.globe.depthTestAgainstTerrain = true;   // 記事の設定
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#9cc0e0");
    viewer.scene.postRender.addEventListener(() => { this._frameCount++; });
    // IonトークンがあればPLATEAU-Terrain (記事の構成) に差し替える
    if (token) {
      try {
        viewer.terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(
          PLATEAU_TERRAIN_ION_ASSET);
      } catch (e) {
        console.warn("PLATEAU-Terrain (Ion) を使えず GSI DEM 地形のまま: ", e);
      }
    }
    if (this._pendingRegion) this.setRegion(...this._pendingRegion);
    return this;
  }

  setOrigin(left, top) {
    this._left = left;
    this._top = top;
  }

  setRegion(W, H, mPerPx, terrainData, bldgData, photoCanvas, stateW, stateH) {
    this._pendingRegion = [W, H, mPerPx, terrainData, bldgData, photoCanvas, stateW, stateH];
    if (!this.viewer) return;
    this.stateW = stateW || W;
    this.stateH = stateH || H;
    this.bbox = regionBBox({ W, H, dx: mPerPx, left: this._left || 0, top: this._top || 0 },
      window.__meta, window.__overviewFactor || 4);
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
    this._loadBuildings(lonC, latC);
  }

  async _loadBuildings(lon, lat) {
    const pick = await pickBldgTileset(lon, lat, this._lod || "2");
    if (this._bldgUrl === pick.url) return;
    this._bldgUrl = pick.url;
    this._wardName = pick.ward;
    this.stats.tilesLoaded = 0;
    this.stats.bytesLoaded = 0;
    const Cesium = window.Cesium;
    if (this._tileset) {
      this.viewer.scene.primitives.remove(this._tileset);
      this._tileset = null;
    }
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(pick.url, {
        maximumScreenSpaceError: 16,
        showCreditsOnScreen: true,
      });
      // 記事の解決策: 地形適用後のわずかなずれは modelMatrix で調整する
      applyHeightOffset(tileset, heightOffsetMeters());
      tileset.show = this.showBuildings;
      this._tileset = tileset;
      this.viewer.scene.primitives.add(tileset);
      tileset.tileLoad.addEventListener((tile) => {
        this.stats.tilesLoaded++;
        this.stats.bytesLoaded += tile.content?.byteLength ?? tile.byteLength ?? 0;
      });
    } catch (e) {
      console.warn("PLATEAU tileset の読み込みに失敗: ", e);
    }
  }

  /** シミュレーション状態 → 水深キャンバス → 地形にドレープする画像レイヤ。 */
  updateWater(rgba) {
    if (!this.viewer || !this.bbox) return;
    const now = performance.now();
    if (now - this._lastWaterAt < 250) return;
    this._lastWaterAt = now;
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

  setFlowEnabled() { }
  setStreamsVisible() { }
  setWaves() { }
  setExag() { }                  // 真スケール
  setPhotoCanvas() { }           // 航空写真はGSI ortタイルをベースレイヤで使う  /** ベンチモード用カメラパス: 0〜2/3は範囲周回、以降は中心へ寄る。 */
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
    if (this._tileset) this._tileset.show = v;
  }
  setBuildingLoad(lod) {
    this._lod = lod;
    this._bldgUrl = null;
    if (this.bbox) this._loadBuildings((this.bbox[0] + this.bbox[2]) / 2, (this.bbox[1] + this.bbox[3]) / 2);
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
    const mem = this._tileset?.statistics;
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
