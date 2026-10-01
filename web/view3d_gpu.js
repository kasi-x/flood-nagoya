// GPUネイティブ3Dビュワー (WebGL2)。
// three.js / deck.gl / CesiumJS はシム状態を CPU 経由 (readPixels) で取り回す
// ため GPU-CPU ストールと滲みの温床になっていた。こちらは FloodSim と同一の
// GLコンテキストで描画し、水深テクスチャ (state[flip], RGBA32F) を
// フラグメントシェーダから直接参照する。CPU-GPU 往復はゼロ。
//
// 建物は別ジオメトリではなく地形ハイトフィールドに畳み込む
// (z_eff = DEM + 建物高さ)。シムの壁セルと1:1一致し、ドローコールは
// 天空+地形+水の3本のみ。
//
// 座標系: x=east, y=up, z=south。 ワールド原点はリージョン中心。
// テクスチャ規約: terrain/bldg/photo は row0=北 (uv.y 0→北),
//                シム state は row0=南 (v = 1 - uv.y で揃える)。

// ---------- terrain + buildings (heightfield, vertex-displaced) ----------
const TERRAIN_VS = `#version 300 es
precision highp float;
uniform mat4 uMvp;
uniform sampler2D uTerr;        // RGBA8 cm, row0=north

uniform vec2 uTerrTexel;
uniform float uExag;
uniform vec2 uSizeM;            // region size in metres (x, z)
in vec3 aPos;                   // x,z in 0..1 fraction over the region
out vec2 vUv;
out vec3 vNormal;
out float vElev;
float dem(vec2 uv){
  vec4 t = texture(uTerr, clamp(uv, 0.0, 1.0));
  return (t.r*65536.0 + t.g*256.0 + t.b)*255.0/100.0;
}

void main(){
  vUv = aPos.xz;
  float z = dem(vUv);
  vElev = z;
  vec3 wp = vec3((aPos.x-0.5)*uSizeM.x, z*uExag, (aPos.z-0.5)*uSizeM.y);
  vec2 e = uTerrTexel;
  float dx = (dem(vUv+vec2(e.x,0)) - dem(vUv-vec2(e.x,0))) * uExag;
  float dz = (dem(vUv+vec2(0,e.y)) - dem(vUv-vec2(0,e.y))) * uExag;
  float step = uSizeM.x * e.x;   // metres per texel (square cells)
  vNormal = normalize(vec3(-dx/(2.0*step), 1.0, -dz/(2.0*step)));
  gl_Position = uMvp * vec4(wp, 1.0);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
uniform sampler2D uPhoto;
uniform int uHasPhoto;
uniform sampler2D uStreams;
uniform float uStreamsOn;
uniform float uSeaLevel;
in vec2 vUv;
in vec3 vNormal;
in float vElev;
out vec4 o;
void main(){
  vec3 L = normalize(vec3(-0.55, 0.70, -0.45));
  float dl = clamp(dot(vNormal, L), 0.0, 1.0);
  float shade = dl*0.62 + 0.38;
  vec3 col;
  if(uHasPhoto == 1){
    vec3 ph = texture(uPhoto, vUv).rgb;
    col = ph * (dl*0.55 + 0.55);
  } else {
    float hn = clamp(vElev/220.0, 0.0, 1.0);
    vec3 land = mix(vec3(0.42,0.48,0.36), vec3(0.62,0.58,0.47), smoothstep(0.05,0.5,hn));
    land = mix(land, vec3(0.55,0.50,0.45), smoothstep(0.5,1.0,hn));
    col = land * shade;
  }
  // 分水域・流路オーバーレイ
  float st = texture(uStreams, vUv).r;
  col = mix(col, vec3(0.15,0.42,0.66), smoothstep(0.2,0.9,st)*uStreamsOn*0.8);
  if(vElev < uSeaLevel) col = mix(col, vec3(0.16,0.24,0.33), 0.75);
  o = vec4(col, 1.0);
}`;

// ---------- water surface (state texture, shared context) ----------
const WATER_VS = `#version 300 es
precision highp float;
uniform mat4 uMvp;
uniform sampler2D uTerr;
uniform sampler2D uState;       // RGBA32F, row0=south -> v = 1 - uv.y
uniform float uExag;
uniform vec2 uSizeM;
uniform float uTime;
uniform float uWaves;
in vec3 aPos;                   // x,z in 0..1 over the region
out vec2 vUv;
out float vDepth;
out vec2 vFlow;
out vec3 vWorld;
float elev(vec2 uv){
  vec4 t = texture(uTerr, clamp(uv, 0.0, 1.0));
  return (t.r*65536.0 + t.g*256.0 + t.b)*255.0/100.0;
}
void main(){
  vUv = aPos.xz;
  vec4 s = texture(uState, vec2(vUv.x, 1.0 - vUv.y));
  float h = s.x;
  vDepth = h;
  vFlow = s.yz;
  float bed = elev(vUv);
  // depth-weighted ripples ride on the surface
  float amp = uWaves * clamp(h, 0.0, 2.0) * 0.09 * uExag;
  float wave = sin(uTime*2.1 + vUv.x*260.0 + vUv.y*140.0)*0.6
             + sin(uTime*3.2 - vUv.x*150.0 + vUv.y*230.0)*0.4;
  float y = (bed + max(h, 0.0)) * uExag + 0.05 + amp * wave;
  vec3 wp = vec3((aPos.x-0.5)*uSizeM.x, y, (aPos.z-0.5)*uSizeM.y);
  vWorld = wp;
  gl_Position = uMvp * vec4(wp, 1.0);
}`;

const WATER_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uStateTexel;
uniform float uTime;
uniform float uWaves;
uniform float uExag;
uniform vec2 uSizeM;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
in vec2 vUv;
in float vDepth;
in vec2 vFlow;
in vec3 vWorld;
out vec4 o;

vec3 depthRamp(float d){
  vec3 c = vec3(0.82, 0.95, 1.00);
  c = mix(c, vec3(0.33, 0.71, 0.95), smoothstep(0.03, 0.20, d));
  c = mix(c, vec3(0.18, 0.45, 0.91), smoothstep(0.20, 0.50, d));
  c = mix(c, vec3(0.16, 0.29, 0.81), smoothstep(0.50, 1.00, d));
  c = mix(c, vec3(0.26, 0.21, 0.72), smoothstep(1.00, 2.00, d));
  c = mix(c, vec3(0.36, 0.18, 0.62), smoothstep(2.00, 3.50, d));
  return c;
}

// surface normal from the depth field (finite differences, world-space)
vec3 waterNormal(vec2 uv){
  vec2 suv = vec2(uv.x, 1.0 - uv.y);
  float ex = texture(uState, suv + vec2(uStateTexel.x, 0.0)).x;
  float wx = texture(uState, suv - vec2(uStateTexel.x, 0.0)).x;
  float sz = texture(uState, suv - vec2(0.0, uStateTexel.y)).x;
  float nz = texture(uState, suv + vec2(0.0, uStateTexel.y)).x;
  float cellM = uSizeM.x * uStateTexel.x;   // metres per state texel
  float dydx = (ex - wx) * uExag / (2.0*cellM);
  float dydz = (sz - nz) * uExag / (2.0*cellM);   // z+ = south
  // ripple perturbation scaled by flow speed + depth
  float sp = length(vFlow)/max(vDepth, 0.02);
  float rip = uWaves * clamp(sp*0.5 + vDepth*0.3, 0.0, 1.5);
  dydx += sin(uTime*2.3 + uv.x*900.0 + uv.y*300.0) * 0.35 * rip;
  dydz += cos(uTime*1.9 + uv.x*350.0 - uv.y*750.0) * 0.35 * rip;
  return normalize(vec3(-dydx, 1.0, -dydz));
}

void main(){
  if(vDepth < 0.008) discard;
  vec3 N = waterNormal(vUv);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 base = depthRamp(vDepth);
  float sp = length(vFlow)/max(vDepth, 0.02);

  // Fresnel: grazing angles pick up the sky, steep angles keep body colour
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  vec3 sky = vec3(0.55, 0.70, 0.85);
  vec3 col = mix(base, sky, 0.25 + fres*0.55);

  // sun specular glint
  vec3 Hv = normalize(uSunDir + V);
  float spec = pow(clamp(dot(N, Hv), 0.0, 1.0), 90.0) * (0.6 + fres);
  col += vec3(1.0, 0.97, 0.85) * spec * 0.9;

  // whitewater foam on fast shallow flow
  float foam = uWaves * smoothstep(0.9, 3.0, sp) * smoothstep(0.05, 0.40, vDepth);
  float wv = sin(uTime*3.0 + dot(vFlow + vec2(1e-4), vWorld.xz*0.7));
  col = mix(col, vec3(0.97,0.98,1.0), foam * 0.55 * (0.6 + 0.4*wv));

  // warm tint on fast water (speed cue, matches 2D)
  col = mix(col, vec3(1.0, 0.70, 0.30), uWaves*smoothstep(0.35, 2.5, sp)*0.30);

  float a = clamp(0.28 + vDepth*1.15, 0.28, 0.94);
  a = max(a, foam*0.9);
  o = vec4(col, a);
}`;

// ---------- sky backdrop ----------
const SKY_VS = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vNdc;
void main(){ vNdc = aPos; gl_Position = vec4(aPos, 0.9999, 1.0); }`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 o;
void main(){
  vec3 top = vec3(0.45, 0.63, 0.82);
  vec3 bot = vec3(0.87, 0.90, 0.93);
  o = vec4(mix(bot, top, smoothstep(-0.4, 0.9, vNdc.y)), 1.0);
}`;

// ---------- instanced box buildings ----------
// Source is the sim's building raster: 1 px per sim cell. Column-merge +
// equal-height row-merge keeps only footprints >= 2x2 cells (multi-pixel
// structures); 1-px sticks are visual noise at city scale and cost 80% of
// the instance count.
const BLDG_VS = `#version 300 es
precision highp float;
uniform mat4 uMvp;
uniform sampler2D uTerr;
uniform vec2 uTerrTexel;
uniform float uExag;
uniform vec2 uSizeM;
in vec3 aPos;          // unit cube corner 0/1
in vec2 iOrg;          // footprint origin, fraction of region
in vec2 iSize;         // footprint size, fraction
in float iH;
out float vTop;
out float vHgt;
out vec3 vWp;
float elev(vec2 uv){
  vec4 t = texture(uTerr, clamp(uv, 0.0, 1.0));
  return (t.r*65536.0 + t.g*256.0 + t.b)*255.0/100.0;
}
void main(){
  vec2 uv = iOrg + aPos.xz * iSize;
  float base = elev(uv) * uExag;
  vHgt = iH;
  vTop = aPos.y;
  vec3 wp = vec3((uv.x - 0.5)*uSizeM.x, base + aPos.y*iH*uExag, (uv.y - 0.5)*uSizeM.y);
  vWp = wp;
  gl_Position = uMvp * vec4(wp, 1.0);
}`;

const BLDG_FS = `#version 300 es
precision highp float;
uniform vec3 uSunDir;
in float vTop;
in float vHgt;
in vec3 vWp;
out vec4 o;
void main(){
  vec3 L = normalize(uSunDir);
  vec3 N = normalize(cross(dFdx(vWp), dFdy(vWp)));   // flat normal per face
  float dl = clamp(dot(N, L), 0.0, 1.0);
  float hn = clamp(vHgt/60.0, 0.0, 1.0);
  vec3 roof = mix(vec3(0.62,0.63,0.66), vec3(0.75,0.76,0.80), hn);
  vec3 wall = mix(vec3(0.47,0.48,0.52), vec3(0.60,0.61,0.65), hn);
  vec3 col = mix(wall*(0.55+0.45*dl), roof*(0.75+0.25*dl), vTop);
  o = vec4(col, 1.0);
}`;

/** Merge building raster into rects (column merge + same-height row merge),
 *  keep footprints >= 2x2 cells, build an instanced-box VAO. */
function buildBuildingMesh(gl, prog, bldgData, W, H) {
  if (!bldgData) return null;
  // column-merge: maximal runs of identical height down each column
  const rects = [];
  for (let x = 0; x < W; x++) {
    let y0 = 0;
    while (y0 < H) {
      const i0 = (y0 * W + x) * 4;
      const h0 = bldgData[i0] * 256 + bldgData[i0 + 1];
      if (!h0) { y0++; continue; }
      let y1 = y0;
      while (y1 + 1 < H) {
        const i1 = ((y1 + 1) * W + x) * 4;
        if (bldgData[i1] * 256 + bldgData[i1 + 1] !== h0) break;
        y1++;
      }
      rects.push([x, y0, 1, y1 - y0 + 1, h0]);
      y0 = y1 + 1;
    }
  }
  // row-merge: fuse x-adjacent rects with same y, height-px, height-cm
  const groups = new Map();
  for (const r of rects) {
    const key = r[1] + ',' + r[3] + ',' + r[4];
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(r);
  }
  const merged = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => a[0] - b[0]);
    let cur = arr[0];
    for (let i = 1; i < arr.length; i++) {
      const r = arr[i];
      if (r[0] === cur[0] + cur[2]) cur = [cur[0], cur[1], cur[2] + r[2], cur[3], cur[4]];
      else { merged.push(cur); cur = r; }
    }
    merged.push(cur);
  }
  // keep footprints >= 2x2 cells; sort by footprint area (largest first) so
  // the instance count can be LOD-trimmed as a prefix when zoomed out
  const fat = merged.filter(r => r[2] >= 2 && r[3] >= 2);
  fat.sort((a, b) => b[2] * b[3] - a[2] * a[3]);
  if (!fat.length) return null;

  // unit cube, 8 verts + 36 indices (post-transform cache reuses corners)
  const verts = new Float32Array([
    0,0,0, 1,0,0, 0,1,0, 1,1,0,   // bottom quad verts (y=0, y=1 packed in v2)
    0,0,1, 1,0,1, 0,1,1, 1,1,1]);
  const idx = new Uint16Array([
    2,3,7, 2,7,6,          // top (y=1)
    0,5,1, 0,4,5,          // bottom
    1,7,3, 1,5,7,          // +x
    0,2,6, 0,6,4,          // -x
    4,6,7, 4,7,5,          // +z
    0,1,3, 0,3,2]);        // -z
  const inst = new Float32Array(fat.length * 5);
  for (let i = 0; i < fat.length; i++) {
    const [x, y, w, h, cm] = fat[i];
    inst[i * 5] = x / W; inst[i * 5 + 1] = y / H;
    inst[i * 5 + 2] = w / W; inst[i * 5 + 3] = h / H;
    inst[i * 5 + 4] = cm / 100;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const locP = gl.getAttribLocation(prog.p, 'aPos');
  gl.enableVertexAttribArray(locP);
  gl.vertexAttribPointer(locP, 3, gl.FLOAT, false, 12, 0);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ib);
  gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
  const ebo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  for (const [name, off] of [['iOrg', 0], ['iSize', 8], ['iH', 16]]) {
    const loc = gl.getAttribLocation(prog.p, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, name === 'iOrg' || name === 'iSize' ? 2 : 1, gl.FLOAT, false, 20, off);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  return { vao, n: fat.length };
}

// ---------- tiny mat4 helpers ----------
function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0];
}
function lookAt(ex, ey, ez, tx, ty, tz) {
  const up = [0, 1, 0];
  let fx = tx - ex, fy = ty - ey, fz = tz - ez;
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0];
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  return [rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
    -(rx * ex + ry * ey + rz * ez), -(ux * ex + uy * ey + uz * ez), fx * ex + fy * ey + fz * ez, 1];
}
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + "\n" + src);
  return s;
}
function makeProg(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const inf = gl.getActiveUniform(p, i);
    u[inf.name] = gl.getUniformLocation(p, inf.name);
  }
  return { p, u };
}
function mkTexFromCanvas(gl, src) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return t;
}

/** Grid VAO: positions xz in 0..1, indexed triangles. */
function makeGridVao(gl, nx, ny, prog) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const verts = new Float32Array(nx * ny * 3);
  let vi = 0;
  for (let iy = 0; iy < ny; iy++)
    for (let ix = 0; ix < nx; ix++, vi++) {
      verts[vi * 3] = ix / (nx - 1);
      verts[vi * 3 + 1] = 0;
      verts[vi * 3 + 2] = iy / (ny - 1);
    }
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog.p, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 12, 0);
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let ii = 0;
  for (let iy = 0; iy < ny - 1; iy++)
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iy * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      idx[ii++] = a; idx[ii++] = c; idx[ii++] = b;
      idx[ii++] = b; idx[ii++] = c; idx[ii++] = d;
    }
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: idx.length };
}

export class GpuView {
  name = "gpu";
  /** app.js へ: readPixels 読み戻しを完全にスキップさせるフラグ */
  directWater = true;

  /**
   * sim: FloodSim instance — the 3D view renders into the sim's own canvas
   * and samples sim.state[flip] directly (zero CPU roundtrip).
   */
  constructor(sim) {
    this.sim = sim;
    this.gl = sim.gl;
    this.canvas = sim.canvas;
    const gl = this.gl;
    this.terrPrg = makeProg(gl, TERRAIN_VS, TERRAIN_FS);
    this.waterPrg = makeProg(gl, WATER_VS, WATER_FS);
    this.bldgPrg = makeProg(gl, BLDG_VS, BLDG_FS);
    this.skyPrg = makeProg(gl, SKY_VS, SKY_FS);
    // fullscreen triangle for the sky backdrop
    this.skyVao = gl.createVertexArray();
    gl.bindVertexArray(this.skyVao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.skyPrg.p, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.running = false;
    this._frameCount = 0;
    this.terrGrid = null;
    this.waterGrid = null;
    this.photoTex = null;
    this.streamsTex = null;
    this.streamsOn = false;
    this.showPhoto = true;
    this.showBuildings = true;
    this.waves = 1;
    this.flowOn = true;
    this.seaLevel = -100;
    this.sizeM = [1, 1];
    this.exag = 2.0;

    // orbit camera state
    this.cam = { az: -0.6, el: 0.42, dist: 1.0, tx: 0, tz: 0, ty: 0 };
    this._camPos = [0, 0, 0];
    this._bindInput();
  }

  // ---------- view interface ----------
  setRegion(W, H, mPerPx, terrainData, bldgData, photoCanvas, stateW, stateH) {
    this.W = W; this.H = H; this.dx = mPerPx;
    this.sizeM = [W * mPerPx, H * mPerPx];
    const gl = this.gl;
    // mesh resolution caps: the fragment shader interpolates texture detail,
    // so geometry only needs ~one vertex per 2-3 texels
    const tstep = Math.max(1, Math.ceil(Math.max(W, H) / 448));
    const tnx = Math.floor(W / tstep) + 1, tny = Math.floor(H / tstep) + 1;
    this.terrGrid = makeGridVao(gl, tnx, tny, this.terrPrg);
    // water follows the sim resolution (capped lower — depth is smooth)
    const sW = stateW || W, sH = stateH || H;
    const wstep = Math.max(1, Math.ceil(Math.max(sW, sH) / 384));
    const wnx = Math.floor(sW / wstep) + 1, wny = Math.floor(sH / wstep) + 1;
    this.waterGrid = makeGridVao(gl, wnx, wny, this.waterPrg);
    this.setPhotoCanvas(photoCanvas);
    this.bldgMesh = buildBuildingMesh(gl, this.bldgPrg, bldgData, W, H);
    this.resetView();
  }

  setOrigin() { /* region-local origin handled in uv space */ }
  setPhotoCanvas(canvas) {
    const gl = this.gl;
    if (this.photoTex) { gl.deleteTexture(this.photoTex); this.photoTex = null; }
    if (canvas) this.photoTex = mkTexFromCanvas(gl, canvas);
  }
  setPhotoVisible(v) { this.showPhoto = v; }
  setStreamsCanvas(img) {
    const gl = this.gl;
    if (this.streamsTex) { gl.deleteTexture(this.streamsTex); this.streamsTex = null; }
    if (img) this.streamsTex = mkTexFromCanvas(gl, img);
  }
  setStreamsVisible(v) { this.streamsOn = v; }
  setBuildingsVisible(v) { this.showBuildings = v; }
  setFlowEnabled(v) { this.flowOn = v; }
  setWaves(v) { this.waves = v ? 1 : 0; }
  setExag(v) { this.exag = Math.max(0.2, Math.min(v, 8)); }
  setSeaLevel(m) { this.seaLevel = m; }

  /** Camera reset hook used by the #north button in 3D mode. */
  resetView() {
    const R = Math.max(this.sizeM[0], this.sizeM[1]);
    this.cam.az = -0.6;
    this.cam.el = 0.42;
    this.cam.dist = R * 0.85;
    this.cam.tx = 0; this.cam.tz = 0;
    this.cam.ty = 30 * this.exag;
  }

  /** No-op: water is sampled from sim.state each frame (shared context). */
  updateWater() { }

  /** Repaint once so screenshots pick up a fresh frame. */
  ensureFrame() { this.render(16); }

  hide() {
    this.running = false;
    // restore the GL state the 2D sim renderer expects
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  show() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this._frameCount++;
      const now = performance.now();
      const dt = Math.min(now - last, 60);
      last = now;
      this.render(dt);
    };
    requestAnimationFrame(loop);
  }
  resize() { /* canvas pixels are managed by app.js resizeCanvas */ }
  getFrameCount() { return this._frameCount; }
  getPerf() {
    return { drawCalls: this._drawCalls || 0, triangles: this._tris || 0 };
  }
  benchCamera(t, total) {
    const R = Math.max(this.sizeM[0], this.sizeM[1]);
    if (t < total * 2 / 3) {
      this.cam.az = -0.6 + (t / (total * 2 / 3)) * Math.PI * 2;
      this.cam.dist = R * 0.85;
    } else {
      this.cam.az = -0.6; this.cam.el = 0.42; this.cam.dist = R * 0.4;
    }
  }

  // ---------- input: orbit camera on the shared sim canvas ----------
  _bindInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener("pointerdown", (e) => {
      if (!this.running) return;
      drag = { x: e.clientX, y: e.clientY, b: e.button, cam: { ...this.cam } };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!drag || !this.running) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (drag.b === 2 || e.shiftKey) {
        // pan: move the target in the camera's ground plane
        const sc = this.cam.dist * 0.0016;
        this.cam.tx = drag.cam.tx - (dx * Math.cos(this.cam.az) + dy * Math.sin(this.cam.az)) * sc;
        this.cam.tz = drag.cam.tz - (-dx * Math.sin(this.cam.az) + dy * Math.cos(this.cam.az)) * sc;
      } else {
        this.cam.az = drag.cam.az - dx * 0.008;
        this.cam.el = Math.max(0.05, Math.min(1.45, drag.cam.el + dy * 0.006));
      }
    });
    const end = () => { drag = null; };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", (e) => {
      if (!this.running) return;
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0012);
      const R = Math.max(this.sizeM[0], this.sizeM[1]);
      this.cam.dist = Math.max(R * 0.05, Math.min(R * 3.5, this.cam.dist * f));
    }, { passive: false });
    c.addEventListener("contextmenu", (e) => { if (this.running) e.preventDefault(); });
  }

  _mvp() {
    const w = this.canvas.width || innerWidth, h = this.canvas.height || innerHeight;
    const R = Math.max(this.sizeM[0], this.sizeM[1]);
    const cam = this.cam;
    const ex = cam.tx + Math.sin(cam.az) * Math.cos(cam.el) * cam.dist;
    const ey = cam.ty + Math.sin(cam.el) * cam.dist;
    const ez = cam.tz + Math.cos(cam.az) * Math.cos(cam.el) * cam.dist;
    const proj = perspective(0.96, w / h, Math.max(1, R * 0.001), R * 12);
    const view = lookAt(ex, ey, ez, cam.tx, cam.ty, cam.tz);
    this._camPos = [ex, ey, ez];
    return mul4(proj, view);
  }

  render(dtMs = 16) {
    const gl = this.gl, sim = this.sim, canvas = this.canvas;
    if (!sim.W || !sim.terrainTex || !sim.state || !this.terrGrid) return;
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const mvp = this._mvp();
    this._drawCalls = 0; this._tris = 0;
    const sunDir = [-0.55, 0.75, -0.45];

    // sky backdrop (no depth write/test)
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.skyPrg.p);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    this._drawCalls++;

    // terrain + buildings (bldg height folded into the heightfield)
    gl.useProgram(this.terrPrg.p);
    let u = this.terrPrg.u;
    gl.uniformMatrix4fv(u.uMvp, false, mvp);
    gl.uniform2f(u.uSizeM, this.sizeM[0], this.sizeM[1]);
    gl.uniform1f(u.uExag, this.exag);
    gl.uniform1f(u.uSeaLevel, this.seaLevel);
    gl.uniform2f(u.uTerrTexel, 1 / sim.W, 1 / sim.H);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.terrainTex); gl.uniform1i(u.uTerr, 0);
    if (this.photoTex && this.showPhoto) {
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.photoTex);
      gl.uniform1i(u.uPhoto, 2); gl.uniform1i(u.uHasPhoto, 1);
    } else gl.uniform1i(u.uHasPhoto, 0);
    if (this.streamsTex && this.streamsOn) {
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.streamsTex);
      gl.uniform1i(u.uStreams, 3); gl.uniform1f(u.uStreamsOn, 1);
    } else gl.uniform1f(u.uStreamsOn, 0);
    gl.bindVertexArray(this.terrGrid.vao);
    gl.drawElements(gl.TRIANGLES, this.terrGrid.count, gl.UNSIGNED_INT, 0);
    this._drawCalls++; this._tris += this.terrGrid.count / 3;

    // instanced box buildings (footprints >= 2x2 sim cells only)
    if (this.bldgMesh && this.bldgMesh.n && this.showBuildings) {
      gl.useProgram(this.bldgPrg.p);
      u = this.bldgPrg.u;
      gl.uniformMatrix4fv(u.uMvp, false, mvp);
      gl.uniform2f(u.uSizeM, this.sizeM[0], this.sizeM[1]);
      gl.uniform1f(u.uExag, this.exag);
      gl.uniform2f(u.uTerrTexel, 1 / sim.W, 1 / sim.H);
      gl.uniform3f(u.uSunDir, sunDir[0], sunDir[1], sunDir[2]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.terrainTex); gl.uniform1i(u.uTerr, 0);
      // LOD: instances are area-sorted; zoomed out, draw only the largest
      const R = Math.max(this.sizeM[0], this.sizeM[1]);
      const lod = Math.min(1, Math.max(0.12, (R * 0.45) / this.cam.dist - 0.15));
      const n = Math.max(1, Math.floor(this.bldgMesh.n * lod));
      gl.bindVertexArray(this.bldgMesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, n);
      this._drawCalls++; this._tris += 12 * n;
    }

    // water — binds sim.state[sim.flip] directly (no readback)
    gl.useProgram(this.waterPrg.p);
    u = this.waterPrg.u;
    gl.uniformMatrix4fv(u.uMvp, false, mvp);
    gl.uniform2f(u.uSizeM, this.sizeM[0], this.sizeM[1]);
    gl.uniform1f(u.uExag, this.exag);
    gl.uniform1f(u.uTime, performance.now() / 1000 % 10000);
    gl.uniform1f(u.uWaves, this.waves);
    gl.uniform2f(u.uStateTexel, 1 / sim.W, 1 / sim.H);
    gl.uniform3f(u.uSunDir, sunDir[0], sunDir[1], sunDir[2]);
    gl.uniform3f(u.uCamPos, this._camPos[0], this._camPos[1], this._camPos[2]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sim.terrainTex); gl.uniform1i(u.uTerr, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sim.state[sim.flip]); gl.uniform1i(u.uState, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);            // transparent water: test depth but don't write
    gl.bindVertexArray(this.waterGrid.vao);
    gl.drawElements(gl.TRIANGLES, this.waterGrid.count, gl.UNSIGNED_INT, 0);
    this._drawCalls++; this._tris += this.waterGrid.count / 3;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }
}
