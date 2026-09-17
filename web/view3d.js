// 3D 表示 (three.js): terrain + PLATEAU building instances + water surface.
// The GPU sim keeps running in its own WebGL2 context; the 3D scene receives
// a CPU copy of the state texture every few frames (see app.js) and drives
// vertex heights via texture lookups, so no per-frame geometry rebuilds.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const EXAG = 1.4; // vertical exaggeration applied consistently to all Y

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
uniform vec2 uTexel;
varying vec2 vUv;
float elevAt(vec2 uv) {
  vec4 t = texture2D(uTerr, uv);
  return (t.r * 65536.0 + t.g * 256.0 + t.b) / 100.0;
}
void main() {
  float z = elevAt(vUv);
  float tx = elevAt(vUv + vec2(uTexel.x, 0.0)) - elevAt(vUv - vec2(uTexel.x, 0.0));
  float ty = elevAt(vUv + vec2(0.0, uTexel.y)) - elevAt(vUv - vec2(0.0, uTexel.y));
  vec3 n = normalize(vec3(-tx, 4.0, -ty));
  float shade = clamp(dot(n, normalize(vec3(-0.5, 0.8, -0.35))), 0.0, 1.0) * 0.55 + 0.5;
  float hn = clamp(z / 200.0, 0.0, 1.0);
  vec3 land = mix(vec3(0.52, 0.58, 0.45), vec3(0.70, 0.66, 0.55), smoothstep(0.05, 0.6, hn));
  land = mix(land, vec3(0.60, 0.56, 0.52), smoothstep(0.6, 1.0, hn));
  gl_FragColor = vec4(land * shade, 1.0);
}`;

const WATER_VERT = /* glsl */ `
uniform sampler2D uState;
uniform sampler2D uTerr;
uniform float uExag;
varying vec2 vUv;
varying float vDepth;
void main() {
  vUv = uv;
  float h = texture2D(uState, uv).x;
  vDepth = h;
  vec4 t = texture2D(uTerr, uv);
  float bed = (t.r * 65536.0 + t.g * 256.0 + t.b) / 100.0;
  vec3 p = position;
  p.y = (bed + max(h, 0.0)) * uExag + 0.03;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const WATER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vDepth;
vec3 depthRamp(float d) {
  vec3 c = vec3(0.85, 0.93, 1.0);
  c = mix(c, vec3(0.45, 0.73, 0.93), smoothstep(0.03, 0.12, d));
  c = mix(c, vec3(0.24, 0.52, 0.86), smoothstep(0.12, 0.30, d));
  c = mix(c, vec3(0.13, 0.32, 0.72), smoothstep(0.30, 0.70, d));
  c = mix(c, vec3(0.24, 0.17, 0.55), smoothstep(0.70, 1.50, d));
  c = mix(c, vec3(0.10, 0.06, 0.28), smoothstep(1.50, 3.50, d));
  return c;
}
void main() {
  if (vDepth < 0.01) discard;
  vec3 col = depthRamp(vDepth);
  float a = clamp(vDepth * 5.0, 0.15, 0.9);
  gl_FragColor = vec4(col, a);
}`;

function decodeTerr(data, i) {
  const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
  return (r * 65536 + g * 256 + b) / 100;
}

export class ThreeView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x0e1116);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0e1116, 12000, 45000);
    this.camera = new THREE.PerspectiveCamera(55, 1, 5, 120000);
    this.controls = null;
    this.group = null;
    this.stateTex = null;
    this.terrTex = null;
    this.light = new THREE.DirectionalLight(0xfff2e0, 1.3);
    this.light.position.set(-3000, 6000, -2500);
    this.scene.add(this.light);
    this.scene.add(new THREE.AmbientLight(0xbfd4ff, 0.7));
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

  /** terrainData/bldgData: RGBA arrays with cm encodings (may be null). */
  setRegion(W, H, mPerPx, terrainData, bldgData) {
    this.disposeRegion();
    const g = new THREE.Group();
    this.W = W; this.H = H; this.dx = mPerPx;

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
    this.stateTex = new THREE.DataTexture(new Float32Array(W * H * 4), W, H,
      THREE.RGBAFormat, THREE.FloatType);
    this.stateTex.magFilter = THREE.LinearFilter;
    this.stateTex.minFilter = THREE.LinearFilter;
    this.stateTex.needsUpdate = true;

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
        uvs[vi * 2] = Math.min(ix * step, W - 1) / (W - 1);
        uvs[vi * 2 + 1] = Math.min(iy * step, H - 1) / (H - 1);
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
        uExag: { value: EXAG },
        uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
        uFog: { value: new THREE.Color(0x0e1116) },
      },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
    });
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
        wuv[wi * 2] = Math.min(ix * wStep, W - 1) / (W - 1);
        wuv[wi * 2 + 1] = Math.min(iy * wStep, H - 1) / (H - 1);
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
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.water = new THREE.Mesh(wgeo, this.waterMat);
    g.add(this.water);

    // buildings: instanced boxes from the PLATEAU raster
    this.buildings = null;
    if (bldgData) {
      const cap = 350000;
      const stride = 1;
      const hAt = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 0;
        const j = (y * W + x) * 4;
        return bldgData[j] * 256 + bldgData[j + 1];
      };
      // first count
      let count = 0;
      for (let y = 0; y < H; y += stride) {
        for (let x = 0; x < W; x += stride) {
          const i = y * W + x;
          if (bldgData[i * 4] | bldgData[i * 4 + 1]) count++;
        }
      }
      const skip = count > cap ? Math.ceil(count / cap) : 1;
      const inst = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial(),
        Math.min(count, cap),
      );
      const m4 = new THREE.Matrix4();
      let k = 0;
      let seen = 0;
      const col = new THREE.Color();
      for (let y = 0; y < H && k < cap; y += stride) {
        for (let x = 0; x < W && k < cap; x += stride) {
          const i = y * W + x;
          const bhCm = bldgData[i * 4] * 256 + bldgData[i * 4 + 1];
          if (!bhCm) continue;
          seen++;
          if ((seen % skip) !== 0) continue;
          const bh = bhCm / 100;
          // drop isolated one-cell spikes (parse slivers): a real tall
          // tower always spans several cells at comparable height
          if (bh >= 60) {
            const nb = Math.max(hAt(x - 1, y), hAt(x + 1, y), hAt(x, y - 1), hAt(x, y + 1));
            if (nb < bhCm * 0.5) continue;
          }
          const bed = terrainData ? decodeTerr(terrainData, i) : 0;
          m4.makeScale(mPerPx * 0.94, bh * EXAG, mPerPx * 0.94);
          m4.setPosition(x * mPerPx - cx, (bed + bh / 2) * EXAG, y * mPerPx - cz);
          inst.setMatrixAt(k, m4);
          col.setRGB(0.32, 0.33, 0.37).lerp(new THREE.Color(0.62, 0.60, 0.64), Math.min(bh / 40, 1));
          inst.setColorAt(k, col);
          k++;
        }
      }
      inst.count = k;
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      this.buildings = inst;
      g.add(inst);
    }

    this.scene.add(g);
    this.group = g;

    // camera: look from the south-west, above
    const R = Math.max(W, H) * mPerPx;
    this.camera.position.set(-R * 0.38, R * 1.05, R * 0.62);
    this.camera.far = R * 8;
    this.camera.updateProjectionMatrix();
    if (!this.controls) {
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.maxPolarAngle = Math.PI * 0.49;
      this.controls.enableDamping = true;
    }
    this.controls.target.set(0, 30, 0);
    this.controls.update();
    this.scene.fog.near = R * 1.2;
    this.scene.fog.far = R * 4;

    if (!this.running) {
      this.running = true;
      const loop = () => {
        if (!this.running) return;
        requestAnimationFrame(loop);
        if (this.canvas.clientWidth !== this._lw || this.canvas.clientHeight !== this._lh) {
          this.resize();
        }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
      };
      requestAnimationFrame(loop);
    }
  }

  /** rgba: Float32Array(W*H*4) from gl.readPixels of the sim state. */
  updateWater(rgba) {
    if (!this.stateTex) return;
    this.stateTex.image.data.set(rgba);
    this.stateTex.needsUpdate = true;
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
    if (this.stateTex) { this.stateTex.dispose(); this.stateTex = null; }
  }
}
