// 3D 表示 (three.js): terrain + PLATEAU building instances + water surface.
// The GPU sim keeps running in its own WebGL2 context; the 3D scene receives
// a CPU copy of the state texture every few frames (see app.js) and drives
// vertex heights via texture lookups, so no per-frame geometry rebuilds.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { decodeTerrCm as decodeTerr, mergeBuildingRects } from "./geo.js?v=28";

// Vertical exaggeration applied consistently to terrain, water and buildings.
// Default comes from ?exag= (PLATEAU-View style terrain exaggeration), 1.0 if unset.
const EXAG_DEFAULT = (() => {
  const v = Number.parseFloat(new URLSearchParams(location.search).get("exag") || "");
  return Number.isFinite(v) && v > 0 ? Math.min(v, 8) : 2.0;
})();
let EXAG = EXAG_DEFAULT;

function setExag(v) {
  EXAG = Math.max(0.2, Math.min(v, 8));
}

const TERRAIN_VERT = /* glsl */ `
uniform sampler2D uTerr;
uniform float uExag;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 t = texture2D(uTerr, uv);
  float z = (t.r * 65536.0 + t.g * 256.0 + t.b) / 100.0;
  vec3 p = position;
  p.y = z * uExag;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const TERRAIN_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTerr;
uniform sampler2D uPhoto;
uniform sampler2D uStreams;
uniform float uHasPhoto;
uniform float uStreamsOn;
uniform float uExag;
uniform vec2 uTexel;
varying vec2 vUv;
float elevAt(vec2 uv) {
  vec4 t = texture2D(uTerr, uv);
  return (t.r * 65536.0 + t.g * 256.0 + t.b) / 100.0;
}
void main() {
  float z = elevAt(vUv);
  // 勾配は表示上の誇張に合わせて強調する (見た目の起伏に陰影を一致させる)
  float tx = elevAt(vUv + vec2(uTexel.x, 0.0)) - elevAt(vUv - vec2(uTexel.x, 0.0));
  float ty = elevAt(vUv + vec2(0.0, uTexel.y)) - elevAt(vUv - vec2(0.0, uTexel.y));
  vec3 n = normalize(vec3(-tx * uExag, 3.0, -ty * uExag));
  float dl = clamp(dot(n, normalize(vec3(-0.5, 0.8, -0.35))), 0.0, 1.0);
  float hn = clamp(z / 200.0, 0.0, 1.0);
  vec3 land = mix(vec3(0.52, 0.58, 0.45), vec3(0.70, 0.66, 0.55), smoothstep(0.05, 0.6, hn));
  land = mix(land, vec3(0.60, 0.56, 0.52), smoothstep(0.6, 1.0, hn));
  vec3 col = land * (dl * 0.55 + 0.5);
  // PLATEAU View style: aerial photo draped on the terrain, relief-shaded
  vec3 photo = texture2D(uPhoto, vUv).rgb;
  col = mix(col, photo * (dl * 0.55 + 0.60), uHasPhoto);
  // 分水域・流路オーバーレイ (D8集水域の強度)
  float st = texture2D(uStreams, vUv).r;
  col = mix(col, vec3(0.15, 0.42, 0.66), smoothstep(0.2, 0.9, st) * uStreamsOn * 0.8);
  gl_FragColor = vec4(col, 1.0);
}`;

const WATER_VERT = /* glsl */ `
uniform sampler2D uState;
uniform sampler2D uTerr;
uniform float uExag;
uniform float uTime;
uniform float uWaves;
varying vec2 vUv;
varying float vDepth;
void main() {
  vUv = uv;
  // sim state comes from gl.readPixels (row 0 = south) while terrain/photo
  // textures are north-first, so sample the water depth flipped in v
  float h = texture2D(uState, vec2(uv.x, 1.0 - uv.y)).x;
  vDepth = h;
  vec4 t = texture2D(uTerr, uv);
  float bed = (t.r * 65536.0 + t.g * 256.0 + t.b) / 100.0;
  vec3 p = position;
  // surface ripples: two travelling waves scaled by local depth
  float amp = uWaves * clamp(h, 0.0, 2.0) * 0.09 * uExag;
  float wave = sin(uTime * 2.1 + uv.x * 260.0 + uv.y * 140.0) * 0.6
             + sin(uTime * 3.2 - uv.x * 150.0 + uv.y * 230.0) * 0.4;
  p.y = (bed + max(h, 0.0)) * uExag + 0.03 + amp * wave;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const WATER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vDepth;
vec3 depthRamp(float d) {
  // matches the 2D map: aqua -> blue -> indigo, deeper = darker
  vec3 c = vec3(0.82, 0.95, 1.00);
  c = mix(c, vec3(0.33, 0.71, 0.95), smoothstep(0.03, 0.20, d));
  c = mix(c, vec3(0.18, 0.45, 0.91), smoothstep(0.20, 0.50, d));
  c = mix(c, vec3(0.16, 0.29, 0.81), smoothstep(0.50, 1.00, d));
  c = mix(c, vec3(0.26, 0.21, 0.72), smoothstep(1.00, 2.00, d));
  c = mix(c, vec3(0.36, 0.18, 0.62), smoothstep(2.00, 3.50, d));
  return c;
}
void main() {
  if (vDepth < 0.01) discard;
  vec3 col = depthRamp(vDepth);
  float a = clamp(vDepth * 5.0, 0.18, 0.92);
  gl_FragColor = vec4(col, a);
}`;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

// ---------- flow streaks (wind-map 風の流線パーティクル) ----------
// CPU粒子をシミュレーションの粗いq場で移流させ、水面の少し上に短い
// ポリラインの軌跡をLineSegmentsで描く。 色=流速、位置=流路。
const FLOW_TRAIL = 7;   // 1粒子の軌跡点数 (6セグメント)

export class ThreeView {
  name = "three";

  constructor(canvas) {
    this.canvas = canvas;
    // preserveDrawingBuffer: スクリーンショット保存用に描画バッファを保持する
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    // PLATEAU View look: light sky, soft haze
    this.renderer.setClearColor(0x9cc0e0);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9cc0e0);
    this.scene.fog = new THREE.Fog(0xc4d8ea, 12000, 45000);
    this.camera = new THREE.PerspectiveCamera(55, 1, 5, 120000);
    this.controls = null;
    this.group = null;
    this.stateTex = null;
    this.terrTex = null;
    this.photoTex = null;
    this.streamsTex = null;
    this.streamsCanvas = null;
    this.showBuildings = true;
    this.showPhoto = true;
    this.showStreams = true;
    // flow streaks state
    this.flowOn = true;
    this.flowLines = null;
    this._flow = null;
    this._flowField = null;
    this._terrData = null;
    this._stateData = null;
    this._lastFieldAt = 0;
    this.light = new THREE.DirectionalLight(0xfff2e0, 0.95);
    this.light.position.set(-3000, 6000, -2500);
    this.scene.add(this.light);
    this.scene.add(new THREE.AmbientLight(0xbfd4ff, 0.45));
    this.running = false;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._lw = w; this._lh = h;
  }

  /** terrainData/bldgData: RGBA arrays with cm encodings (may be null).
   * stateW/stateH: water state texture resolution — defaults to W,H.
   * The playback feeds a coarser precomputed water grid than the terrain. */
  setRegion(W, H, mPerPx, terrainData, bldgData, photoCanvas, stateW, stateH) {
    this.disposeRegion();
    const g = new THREE.Group();
    this.W = W; this.H = H; this.dx = mPerPx;
    this.stateW = stateW || W;
    this.stateH = stateH || H;

    // cap mesh resolution near 512 cells per axis
    const step = Math.max(1, Math.ceil(Math.max(W, H) / 512));
    const nx = Math.floor((W - 1) / step) + 1;
    const ny = Math.floor((H - 1) / step) + 1;
    const cx = (W - 1) * mPerPx / 2, cz = (H - 1) * mPerPx / 2;
    this.center = [cx, cz];

    // textures
    const tData = terrainData ? new Uint8Array(terrainData.buffer.slice(0))
      : new Uint8Array(W * H * 4).fill(80);
    this.terrTex = new THREE.DataTexture(tData, W, H, THREE.RGBAFormat);
    this.terrTex.magFilter = THREE.LinearFilter;
    this.terrTex.minFilter = THREE.LinearFilter;
    this.terrTex.needsUpdate = true;
    this.stateTex = new THREE.DataTexture(new Float32Array(this.stateW * this.stateH * 4),
      this.stateW, this.stateH, THREE.RGBAFormat, THREE.FloatType);
    this.stateTex.magFilter = THREE.LinearFilter;
    this.stateTex.minFilter = THREE.LinearFilter;
    this.stateTex.needsUpdate = true;
    // CPU側サンプラ: 流線の移流と水面高さの計算に使う
    this._terrData = terrainData || null;
    this._stateData = this.stateTex.image.data;
    this._flowField = null;
    this._lastFieldAt = 0;
    this.setPhotoCanvas(photoCanvas);

    // shared grid geometry (positions xz; y comes from the vertex shader)
    const positions = new Float32Array(nx * ny * 3);
    const uvs = new Float32Array(nx * ny * 2);
    const indices = [];
    let vi = 0;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++, vi++) {
        const px = Math.min(ix * step, W - 1) * mPerPx - cx;
        const pz = Math.min(iy * step, H - 1) * mPerPx - cz;
        positions[vi * 3] = px;
        positions[vi * 3 + 1] = 0;
        positions[vi * 3 + 2] = pz;
        // sample texel centres so vertex heights equal the DEM pixels
        uvs[vi * 2] = (Math.min(ix * step, W - 1) + 0.5) / W;
        uvs[vi * 2 + 1] = (Math.min(iy * step, H - 1) + 0.5) / H;
        if (ix < nx - 1 && iy < ny - 1) {
          const a = vi, b = vi + 1, c = vi + nx, d = vi + nx + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const terrMat = new THREE.ShaderMaterial({
      uniforms: {
        uTerr: { value: this.terrTex },
        uPhoto: { value: this.photoTex },
        uHasPhoto: { value: this.photoTex ? 1.0 : 0.0 },
        uStreams: { value: this.streamsTex },
        uStreamsOn: { value: this.showStreams && this.streamsTex ? 1.0 : 0.0 },
        uExag: { value: EXAG },
        uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
      },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
    });
    this.terrainMat = terrMat;
    const terrain = new THREE.Mesh(geo, terrMat);
    g.add(terrain);

    // water: same grid, denser cap
    const wStep = Math.max(step, Math.ceil(Math.max(W, H) / 640));
    const wnx = Math.floor((W - 1) / wStep) + 1;
    const wny = Math.floor((H - 1) / wStep) + 1;
    const wpos = new Float32Array(wnx * wny * 3);
    const wuv = new Float32Array(wnx * wny * 2);
    const widx = [];
    let wi = 0;
    for (let iy = 0; iy < wny; iy++) {
      for (let ix = 0; ix < wnx; ix++, wi++) {
        const px = Math.min(ix * wStep, W - 1) * mPerPx - cx;
        const pz = Math.min(iy * wStep, H - 1) * mPerPx - cz;
        wpos[wi * 3] = px;
        wpos[wi * 3 + 1] = 0;
        wpos[wi * 3 + 2] = pz;
        wuv[wi * 2] = (Math.min(ix * wStep, W - 1) + 0.5) / W;
        wuv[wi * 2 + 1] = (Math.min(iy * wStep, H - 1) + 0.5) / H;
        if (ix < wnx - 1 && iy < wny - 1) {
          const a = wi, b = wi + 1, c = wi + wnx, d = wi + wnx + 1;
          widx.push(a, c, b, b, c, d);
        }
      }
    }
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute("position", new THREE.BufferAttribute(wpos, 3));
    wgeo.setAttribute("uv", new THREE.BufferAttribute(wuv, 2));
    wgeo.setIndex(widx);
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: this.stateTex },
        uTerr: { value: this.terrTex },
        uExag: { value: EXAG },
        uTime: { value: 0 },
        uWaves: { value: 1 },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.water = new THREE.Mesh(wgeo, this.waterMat);
    g.add(this.water);

    // flow streaks: 水面の少し上を流れる線パーティクル
    this._buildFlowParticles(W, H);
    g.add(this.flowLines);

    // buildings: instanced boxes from the PLATEAU raster
    this.buildings = null;
    this._roofCells = null;
    if (bldgData) {
      const step = Math.max(1, Math.ceil(Math.max(W, H) / 512));
      const nx = Math.floor((W - 1) / step) + 1;
      const ny = Math.floor((H - 1) / step) + 1;
      const cap = 350000;

      /** Bilinear elevation at pixel (px,py) as the mesh renders it. */
      const meshBed = (px, py) => {
        if (!terrainData) return 0;
        const gx = px / step, gy = py / step;
        const i0 = Math.max(0, Math.floor(gx)), j0 = Math.max(0, Math.floor(gy));
        const fx = gx - i0, fy = gy - j0;
        const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, ny - 1);
        const mx0 = Math.min(i0 * step, W - 1), mx1 = Math.min(i1 * step, W - 1);
        const my0 = Math.min(j0 * step, H - 1), my1 = Math.min(j1 * step, H - 1);
        const h = (x, y) => decodeTerr(terrainData, y * W + x);
        const h00 = h(mx0, my0), h10 = h(mx1, my0);
        const h01 = h(mx0, my1), h11 = h(mx1, my1);
        const top = h00 + (h10 - h00) * fx;
        const bot = h01 + (h11 - h01) * fx;
        return top + (bot - top) * fy;
      };

      const _h = (x, y) => terrainData ? decodeTerr(terrainData, y * W + x) : 0;

      // mean bed elevation: anchors the camera at the local land height
      let bedSum = 0, bedN = 0;
      for (let y = 0; y < H; y += 16) {
        for (let x = 0; x < W; x += 16) {
          bedSum += meshBed(x, y);
          bedN++;
        }
      }
      this._meanBed = bedN ? bedSum / bedN : 0;

      /** 高さラスタを同一高さの矩形に貪欲マージし、1棟=1箱にする
       *  (geo.js 共有版 — deck.gl の簡易建物表示と同じ矩形を使う)。 */
      const rects = mergeBuildingRects(bldgData, W, H);

      const roofCells = new Float32Array(Math.min(rects.length, cap) * 2);
      const inst = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial(),
        Math.min(rects.length, cap),
      );
      const m4 = new THREE.Matrix4();
      let k = 0;
      const col = new THREE.Color();
      for (const [sx, sy, w, hh, hCm] of rects) {
        if (k >= cap) break;
        const bh = hCm / 100;
        // 建物の底面はメッシュ補間の地盤高に合わせる (傾斜地での浮きを防ぐ)
        const ex = Math.min(sx + w, W - 1), ey = Math.min(sy + hh, H - 1);
        const mx = sx + w / 2, my = sy + hh / 2;
        // footprint 4隅+中心の標高を取り、最低値を底面にする (斜面で浮かない)
        const c0 = meshBed(sx, sy), c1 = meshBed(ex, sy);
        const c2 = meshBed(sx, ey), c3 = meshBed(ex, ey);
        const cc = meshBed(mx, my);
        const minBed = Math.min(c0, c1, c2, c3, cc);
        const bed = (c0 + c1 + c2 + c3 + cc) / 5;
        // 底面は最低標高より少し下、上面は平均標高+建物高
        const margin = 0.6;
        const yBottom = minBed - margin;
        const yTop = bed + bh;
        const boxH = yTop - yBottom;
        m4.makeScale(w * mPerPx, boxH * EXAG, hh * mPerPx);
        m4.setPosition(mx * mPerPx - cx, (yBottom + boxH / 2) * EXAG,
          my * mPerPx - cz);
        inst.setMatrixAt(k, m4);
        // PLATEAU View look: light neutral walls (写真があれば屋上色で上書き)
        const t = (((sx * 73856093) ^ (sy * 19349663)) >>> 0) % 100 / 100;
        col.setRGB(0.80 + t * 0.14, 0.81 + t * 0.14, 0.83 + t * 0.13);
        inst.setColorAt(k, col);
        roofCells[k * 2] = mx / W;
        roofCells[k * 2 + 1] = my / H;
        k++;
      }
      inst.count = k;
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      this.buildings = inst;
      this._roofCells = roofCells;
      g.add(inst);
      this.applyPhotoRoofs();   // setRegionに写真が渡された場合
    }

    // PLATEAU View style: aerial photo draped on the terrain (optional)
    this.photoUniform = this.terrainMat.uniforms.uHasPhoto;
    this.setPhotoVisible(this.showPhoto);

    this.scene.add(g);
    this.group = g;
    this.setBuildingsVisible(this.showBuildings);

    // camera: look from the south-west, tilted low enough that relief and
    // building heights read as 3D (a plane seen from straight above looks flat)
    const R = Math.max(W, H) * mPerPx;
    const bedMid = terrainData ? this._meanBed : 0;
    this.camera.position.set(-R * 0.34, bedMid + R * 0.42, R * 0.52);
    this.camera.far = R * 10;
    this.camera.updateProjectionMatrix();
    if (!this.controls) {
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.maxPolarAngle = Math.PI * 0.49;
      this.controls.enableDamping = true;
    }
    this.controls.target.set(0, bedMid + R * 0.02, 0);
    this.controls.update();
    this.scene.fog.near = R * 1.2;
    this.scene.fog.far = R * 4;

    if (!this.running) {
      this.running = true;
      let lastT = performance.now();
      const loop = () => {
        if (!this.running) return;
        requestAnimationFrame(loop);
        this._frameCount = (this._frameCount || 0) + 1;
        const now = performance.now();
        const dtMs = Math.min(now - lastT, 60);
        lastT = now;
        if (this.canvas.clientWidth !== this._lw || this.canvas.clientHeight !== this._lh) {
          this.resize();
        }
        this.controls.update();
        if (this.waterMat) this.waterMat.uniforms.uTime.value = performance.now() / 1000 % 10000;
        if (this.flowOn) this._updateFlow(dtMs);
        this.renderer.render(this.scene, this.camera);
      };
      requestAnimationFrame(loop);
    }
  }

  /** 非アクティブ化: rAFループを止めてGPU/バッテリーを休ませる (perf.js計測対象外)。 */
  hide() {
    this.running = false;
  }
  /** 再アクティブ化: セット済みのリージョンで再構築してループを再開する。 */
  show() {
    if (this.running) return;
    if (this.group) {
      // setRegion を再実行せずループだけ回す (描画は次フレームから復帰)
      this.running = true;
      let lastT = performance.now();
      const loop = () => {
        if (!this.running) return;
        requestAnimationFrame(loop);
        this._frameCount = (this._frameCount || 0) + 1;
        const dtMs = Math.min(performance.now() - lastT, 60);
        lastT = performance.now();
        if (this.canvas.clientWidth !== this._lw || this.canvas.clientHeight !== this._lh) {
          this.resize();
        }
        this.controls.update();
        if (this.waterMat) this.waterMat.uniforms.uTime.value = performance.now() / 1000 % 10000;
        if (this.flowOn) this._updateFlow(dtMs);
        this.renderer.render(this.scene, this.camera);
      };
      requestAnimationFrame(loop);
    }
  }

  getFrameCount() { return this._frameCount || 0; }
  getPerf() {
    const info = this.renderer?.info;
    if (!info) return {};
    return {
      drawCalls: info.render.calls, triangles: info.render.triangles,
      geoms: info.memory.geometries, textures: info.memory.textures
    };
  }
  /** スクリーンショット用に1フレーム描き直す。 */
  ensureFrame() {
    if (!this.running) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** ベンチモード用カメラパス: 0〜2/3は範囲を一周、以降は中心へ寄る。 */
  benchCamera(t, total) {
    if (!this.controls || !this.W) return;
    const R = Math.max(this.W, this.H) * this.dx;
    const bed = this._meanBed || 0;
    const target = new THREE.Vector3(0, bed + R * 0.02, 0);
    let pos;
    if (t < total * 2 / 3) {
      const u = t / (total * 2 / 3) * Math.PI * 2;
      pos = new THREE.Vector3(Math.sin(u) * R * 0.62, bed + R * 0.44, Math.cos(u) * R * 0.62);
    } else {
      pos = new THREE.Vector3(R * 0.18, bed + R * 0.16, R * 0.26);
    }
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.controls.update();
  }

  /** rgba: Float32Array(W*H*4) from gl.readPixels of the sim state. */
  updateWater(rgba) {
    if (!this.stateTex) return;
    this.stateTex.image.data.set(rgba);
    this.stateTex.needsUpdate = true;
    const now = performance.now();
    if (!this._lastFieldAt || now - this._lastFieldAt > 250) {
      this._lastFieldAt = now;
      this._buildFlowField(rgba);
    }
  }

  // ---------- flow streaks ----------

  /** LineSegments pool: n particles x FLOW_TRAIL-point trails. */
  _buildFlowParticles(W, H) {
    const n = Math.round(clamp(Math.max(W, H) * 1.6, 800, 2800));
    const trail = new Float32Array(n * FLOW_TRAIL * 3);
    const segs = n * (FLOW_TRAIL - 1);
    const pos = new Float32Array(segs * 2 * 3);
    const col = new Float32Array(segs * 2 * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,   // 水面や写真の上でも流線を浮き立たせる
    });
    this.flowLines = new THREE.LineSegments(geo, mat);
    this.flowLines.frustumCulled = false;
    this.flowLines.visible = this.flowOn;
    // 全点を一旦画面外へ置き、湿ったセルで順に張り直される
    for (let k = 0; k < trail.length; k += 3) trail[k + 1] = -1e5;
    const p = {
      n, trail, geo,
      pU: new Float32Array(n), pV: new Float32Array(n),
      pAge: new Float32Array(n), pLife: new Float32Array(n),
      pTn: new Float32Array(n),
    };
    for (let i = 0; i < n; i++) {
      p.pU[i] = Math.random(); p.pV[i] = Math.random();
      p.pAge[i] = Math.random() * 1200;
      p.pLife[i] = 1500 + Math.random() * 1600;
    }
    this._flow = p;
  }

  /** Coarse qx/qy/depth grids sampled from the sim state (throttled). */
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
    const fx = clamp(u * f.gw - 0.5, 0, f.gw - 1);
    const fy = clamp(v * f.gh - 0.5, 0, f.gh - 1);
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

  /** Bilinear bed elevation at grid pixel (gx, gy). */
  _terrHeight(gx, gy) {
    const d = this._terrData;
    if (!d) return 0;
    const W = this.W, H = this.H;
    const fx = clamp(gx, 0, W - 1.001), fy = clamp(gy, 0, H - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const top = decodeTerr(d, y0 * W + x0) * (1 - ax) + decodeTerr(d, y0 * W + x1) * ax;
    const bot = decodeTerr(d, y1 * W + x0) * (1 - ax) + decodeTerr(d, y1 * W + x1) * ax;
    return top * (1 - ay) + bot * ay;
  }

  /** Bilinear water depth at terrain pixel (gx, gy); state rows run
   * south-first at (stateW × stateH), which may differ from the terrain. */
  _stateDepth(gx, gy) {
    const d = this._stateData;
    if (!d) return 0;
    const W = this.stateW, H = this.stateH;
    const fx = clamp((gx + 0.5) * W / this.W - 0.5, 0, W - 1.001);
    const fy = clamp(H - (gy + 0.5) * H / this.H, 0, H - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const top = d[(y0 * W + x0) * 4] * (1 - ax) + d[(y0 * W + x1) * 4] * ax;
    const bot = d[(y1 * W + x0) * 4] * (1 - ax) + d[(y1 * W + x1) * 4] * ax;
    return top * (1 - ay) + bot * ay;
  }

  /** Move a particle onto a wet, flowing cell; false when none was found. */
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
    // リスポーン時は軌跡を全て新位置にリセット (旧位置からの垂直線を防ぐ)
    const gx = p.pU[i] * this.W, gy = p.pV[i] * this.H;
    const bed = this._terrHeight(gx, gy);
    const hd = this._stateDepth(gx, gy);
    const x = gx * this.dx - this.center[0];
    const y = (bed + Math.max(hd, 0)) * EXAG + 0.06 * EXAG + 0.25 * Math.min(hd, 2);
    const z = gy * this.dx - this.center[1];
    const base = i * FLOW_TRAIL * 3;
    for (let k = 0; k < FLOW_TRAIL; k++) {
      p.trail[base + k * 3] = x;
      p.trail[base + k * 3 + 1] = y;
      p.trail[base + k * 3 + 2] = z;
    }
    return true;
  }

  /** Advect particles and rebuild the line buffers for this frame. */
  _updateFlow(dtMs) {
    const p = this._flow;
    if (!p || !this._flowField || !this.flowLines) return;
    const dt = Math.min(dtMs, 50) / 1000;
    const f = this._flowField;
    const W = this.W, H = this.H, dx = this.dx;
    const cx = this.center[0], cz = this.center[1];
    const refU = Math.max(0.3, f.qmax / 0.45);   // 正規化用の流速スケール (m/s)
    const smp = { qx: 0, qy: 0, h: 0 };
    const tr = p.trail;

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
      const tn = clamp(Math.pow(clamp(sp / refU, 0, 1), 0.65), 0, 1);
      p.pTn[i] = tn;
      if (!dead) {
        const inv = 1 / Math.max(sp, 1e-6);
        const cellsPerSec = 32 * (0.3 + 0.7 * tn);
        p.pU[i] += smp.qx * inv * cellsPerSec * dt / W;
        p.pV[i] += smp.qy * inv * cellsPerSec * dt / H;
        if (p.pU[i] < -0.01 || p.pU[i] > 1.01 || p.pV[i] < -0.01 || p.pV[i] > 1.01) {
          if (!this._respawn(i, p)) p.pAge[i] = 1e9;
        }
      }
      // trail: 1点ずらして先頭に新しい位置 (世界座標) を積む
      const base = i * FLOW_TRAIL * 3;
      tr.copyWithin(base + 3, base, base + (FLOW_TRAIL - 1) * 3);
      const e = base + (FLOW_TRAIL - 1) * 3;
      if (dead) {
        tr[e] = 0; tr[e + 1] = -1e5; tr[e + 2] = 0;
      } else {
        const gx = p.pU[i] * W, gy = p.pV[i] * H;
        const bed = this._terrHeight(gx, gy);
        const hd = this._stateDepth(gx, gy);
        tr[e] = gx * dx - cx;
        tr[e + 1] = (bed + Math.max(hd, 0)) * EXAG + 0.06 * EXAG + 0.25 * Math.min(hd, 2);
        tr[e + 2] = gy * dx - cz;
      }
    }

    // buffers: segments old->new, alpha ramping toward the head
    const pos = p.geo.attributes.position.array;
    const col = p.geo.attributes.color.array;
    let vi = 0, ci = 0;
    for (let i = 0; i < p.n; i++) {
      const tn = p.pTn[i];
      const fade = 0.5 + 0.5 * tn;
      // 加算合成なのでやや抑えた色 (重なると白く発光する)
      const r = 0.5 + 0.5 * tn, g = 0.8 + 0.2 * tn, b = 1.0;
      const base = i * FLOW_TRAIL * 3;
      for (let k = 0; k < FLOW_TRAIL - 1; k++) {
        const a0 = base + k * 3, a1 = a0 + 3;
        pos[vi++] = tr[a0]; pos[vi++] = tr[a0 + 1]; pos[vi++] = tr[a0 + 2];
        pos[vi++] = tr[a1]; pos[vi++] = tr[a1 + 1]; pos[vi++] = tr[a1 + 2];
        col[ci++] = r; col[ci++] = g; col[ci++] = b; col[ci++] = fade * k / (FLOW_TRAIL - 1);
        col[ci++] = r; col[ci++] = g; col[ci++] = b; col[ci++] = fade * (k + 1) / (FLOW_TRAIL - 1);
      }
    }
    p.geo.attributes.position.needsUpdate = true;
    p.geo.attributes.color.needsUpdate = true;
  }

  setFlowEnabled(v) {
    this.flowOn = v;
    if (this.flowLines) this.flowLines.visible = v;
  }

  /** Zoom the orbit camera toward/away from its target by factor `f`. */
  zoomBy(f) {
    if (!this.controls) return;
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t).multiplyScalar(f);
    const lim = this.W ? Math.max(this.W, this.H) * this.dx * 3 : 1e5;
    const len = off.length();
    if (len < 40 || len > lim) return;
    this.camera.position.copy(t).add(off);
    this.controls.update();
  }

  /** Orbitカメラをリージョン全体が見渡せる既定視点に戻す。 */
  resetView() {
    if (!this.controls || !this.W) return;
    const t = this.controls.target;
    const d = Math.max(this.W, this.H) * this.dx * 1.35;
    this.camera.position.set(t.x - d * 0.3, t.y - d * 0.9, t.z + d * 0.65);
    this.controls.update();
  }

  /** Attach (or replace) an aerial-photo canvas draped on the terrain. */
  setPhotoCanvas(canvas) {
    if (this.photoTex) { this.photoTex.dispose(); this.photoTex = null; }
    this._photoCanvas = canvas || null;
    if (!canvas) return;
    const t = new THREE.CanvasTexture(canvas);
    // The terrain/state DataTextures are flipY=false (uv.y=0 = north row) and
    // the building instances are placed by grid row, so the photo must use the
    // same convention: CanvasTexture defaults to flipY=true, which would mirror
    // the drape vertically against the terrain and buildings.
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.photoTex = t;
    if (this.terrainMat) {
      this.terrainMat.uniforms.uPhoto.value = t;
      this.terrainMat.uniforms.uHasPhoto.value = this.showPhoto ? 1.0 : 0.0;
      this.terrainMat.uniforms.uPhoto.value.needsUpdate = true;
    }
    this.applyPhotoRoofs();
  }

  /** 屋上を写真の色で塗る: 地形には写真がドレープされても建物が無地の白い
   * 箱のままだと写真から浮いて見えるため、各建物の足元(=屋上)の写真色を
   * インスタンスカラーにサンプリングしてシーンに馴染ませる。 */
  applyPhotoRoofs() {
    const inst = this.buildings;
    const cells = this._roofCells;
    const cv = this._photoCanvas;
    if (!inst || !cells || !cv) return;
    let data;
    try {
      data = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    } catch {
      return;   // CORSで汚染されたキャンバスは諦める
    }
    const cw = cv.width, ch = cv.height;
    const col = new THREE.Color();
    const n = Math.min(cells.length / 2, inst.count);
    for (let k = 0; k < n; k++) {
      const px = Math.min(cw - 1, Math.max(0, Math.round(cells[k * 2] * cw - 0.5)));
      const py = Math.min(ch - 1, Math.max(0, Math.round(cells[k * 2 + 1] * ch - 0.5)));
      const o = (py * cw + px) * 4;
      if (THREE.SRGBColorSpace) col.setRGB(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255, THREE.SRGBColorSpace);
      else col.setRGB(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255);
      inst.setColorAt(k, col);
    }
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }

  setPhotoVisible(v) {
    this.showPhoto = v;
    if (this.terrainMat) {
      this.terrainMat.uniforms.uHasPhoto.value = v && this.photoTex ? 1.0 : 0.0;
    }
  }

  /** Attach (or replace) the watershed/streams overlay image. */
  setStreamsCanvas(img) {
    if (this.streamsTex) this.streamsTex.dispose();
    this.streamsCanvas = img || null;
    this.streamsTex = null;
    if (!img) return;
    const t = new THREE.CanvasTexture(img);
    t.flipY = false;   // 画像 row 0 = 北 = uv.y 0 (地形テクスチャと同じ規約)
    t.anisotropy = 4;
    this.streamsTex = t;
    if (this.terrainMat) {
      this.terrainMat.uniforms.uStreams.value = t;
      this.terrainMat.uniforms.uStreamsOn.value = this.showStreams ? 1.0 : 0.0;
    }
  }

  setStreamsVisible(v) {
    this.showStreams = v;
    if (this.terrainMat) {
      this.terrainMat.uniforms.uStreamsOn.value = v && this.streamsTex ? 1.0 : 0.0;
    }
  }

  setBuildingsVisible(v) {
    this.showBuildings = v;
    if (this.buildings) this.buildings.visible = v;
  }

  /** Change vertical exaggeration (applies to the next setRegion call). */
  setExag(v) {
    setExag(v);
    if (this.terrainMat) this.terrainMat.uniforms.uExag.value = EXAG;
    if (this.waterMat) this.waterMat.uniforms.uExag.value = EXAG;
  }

  setWaves(v) {
    this.showWaves = v;
    if (this.waterMat) this.waterMat.uniforms.uWaves.value = v ? 1 : 0;
  }

  disposeRegion() {
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.group = null;
    }
    if (this.terrTex) { this.terrTex.dispose(); this.terrTex = null; }
    if (this.photoTex) { this.photoTex.dispose(); this.photoTex = null; }
    if (this.streamsTex) { this.streamsTex.dispose(); this.streamsTex = null; }
    if (this.stateTex) { this.stateTex.dispose(); this.stateTex = null; }
    this.flowLines = null;
    this._flow = null;
    this._flowField = null;
    this._terrData = null;
    this._stateData = null;
    this._lastFieldAt = 0;
    this.stateW = 0;
    this.stateH = 0;
    this._roofCells = null;
  }
}
