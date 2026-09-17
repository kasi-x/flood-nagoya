// GPU shallow-water rain-on-grid engine (WebGL2).
//
// Physics: LISFLOOD-FP style explicit "pipe" scheme (Bates et al. 2010):
//  - flow between cells driven by free-surface gradient,
//  - implicit Manning friction, wet/dry threshold, outflow limiter,
//  - rain source, sewer-drainage + infiltration sinks,
//  - PLATEAU building footprints act as solid walls (no rain, no flux).
// State texture (RGBA32F): x = h [m], y = qE [m2/s], z = qS [m2/s],
// w = max depth so far [m]. +y in texture space points south.

export const MODE_TERRAIN = 0, MODE_DEPTH = 1, MODE_SPEED = 2, MODE_MAXDEPTH = 3;

const VERT = `#version 300 es
void main(){
  // fullscreen triangle
  vec2 p = vec2((gl_VertexID<<1 & 2), (gl_VertexID & 2));
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

const SIM_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform sampler2D uTerrain;
uniform sampler2D uBldg;
uniform float uDt, uDx, uG, uManning, uRain, uDrain, uInfil, uBldgOn;
out vec4 oState;

float elev(ivec2 p){
  vec4 t = texelFetch(uTerrain, clamp(p, ivec2(0), textureSize(uTerrain,0)-1), 0);
  return (t.r*65536.0 + t.g*256.0 + t.b)/100.0;
}
float bldg(ivec2 p){
  vec4 t = texelFetch(uBldg, clamp(p, ivec2(0), textureSize(uBldg,0)-1), 0);
  return (t.r*256.0 + t.g)/100.0;
}
vec4 state(ivec2 p){
  ivec2 sz = textureSize(uState,0);
  if(any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, sz))) return vec4(0.0);
  return texelFetch(uState, p, 0);
}

// pipe flux from cell (h0,z0,with old flux q0) to its east/south neighbour
float flux(float q0, float h0, float z0, float h1, float z1, float b1){
  if(uBldgOn > 0.5 && b1 > 0.0) return 0.0;          // wall
  float hf = max(h0, h1);
  if(hf < 0.005) return 0.0;                          // dry face
  float dEta = (z0 + h0) - (z1 + h1);
  // LISFlood-FP: q_{t+dt} = (q_t - g*hf*dt*(eta1 - eta0)/dx) / friction
  // with eta1-eta0 = -dEta this becomes q_t + g*hf*dt*dEta/dx
  float q = q0 + uG * hf * uDt * dEta / uDx;
  float fr = uG * uDt * hf * uManning * uManning * abs(q) / pow(hf, 7.0/3.0);
  q /= (1.0 + fr);                                    // implicit Manning
  // donor-cell limiting: water cannot exceed what the cell it flows
  // FROM actually holds (prevents mass-printing feedback at closed corners)
  float hDonor = dEta > 0.0 ? h0 : h1;
  float qcap = min(0.25 * hDonor * uDx / uDt, 15.0 * max(hDonor, 0.005));
  return clamp(q, -qcap, qcap);
}

void main(){
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 s = state(P);
  float z0 = elev(P);
  float b0 = bldg(P);
  bool wall = uBldgOn > 0.5 && b0 > 0.0;

  ivec2 PE = P + ivec2(1,0), PS = P + ivec2(0,1);
  float hE = state(PE).x, hS = state(PS).x;
  float qE = flux(s.y, s.x, z0, hE, elev(PE), bldg(PE));
  float qS = flux(s.z, s.x, z0, hS, elev(PS), bldg(PS));

  // inflows from the west and north neighbours (explicit: old fluxes)
  vec4 sW = state(P + ivec2(-1,0));
  vec4 sN = state(P + ivec2(0,-1));
  float inW = (uBldgOn > 0.5 && bldg(P+ivec2(-1,0)) > 0.0) ? 0.0 : sW.y;
  float inN = (uBldgOn > 0.5 && bldg(P+ivec2(0,-1)) > 0.0) ? 0.0 : sN.z;

  float h = s.x;
  float loss = min(h, (uDrain + uInfil) * uDt);
  float h1 = h + uDt/uDx * (inW - qE + inN - qS) - loss + uRain * uDt;
  h1 = max(h1, 0.0);
  if(wall){ h1 = 0.0; qE = 0.0; qS = 0.0; }
  oState = vec4(h1, qE, qS, max(s.w, h1));
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform sampler2D uTerrain;
uniform sampler2D uBldg;
uniform sampler2D uStreams;   // map mode only; 0 otherwise
uniform vec2 uGrid;           // sim/overview grid size in cells
uniform vec3 uView;           // screen px -> grid px: gp = (frag - c/2)/s + center
uniform vec2 uCanvas;
uniform int uMode;            // 0 terrain 1 depth 2 speed 3 maxdepth
uniform float uTime;
uniform float uDx;
uniform int uBldgOn;
uniform int uMapMode;         // 1: sea/streams styling for the overview
out vec4 fragColor;

float elevAt(vec2 gp){
  vec4 t = texture(uTerrain, (gp+0.5)/uGrid);
  return (t.r*65536.0 + t.g*256.0 + t.b)/100.0;
}
float bldgAt(vec2 gp){
  vec4 t = texture(uBldg, (gp+0.5)/uGrid);
  return (t.r*256.0 + t.g)/100.0;
}

vec3 depthRamp(float d){
  vec3 c = vec3(0.85, 0.93, 1.0);
  c = mix(c, vec3(0.45, 0.73, 0.93), smoothstep(0.03, 0.12, d));
  c = mix(c, vec3(0.24, 0.52, 0.86), smoothstep(0.12, 0.30, d));
  c = mix(c, vec3(0.13, 0.32, 0.72), smoothstep(0.30, 0.70, d));
  c = mix(c, vec3(0.24, 0.17, 0.55), smoothstep(0.70, 1.50, d));
  c = mix(c, vec3(0.10, 0.06, 0.28), smoothstep(1.50, 3.50, d));
  return c;
}

void main(){
  vec2 gp = (gl_FragCoord.xy - uCanvas*0.5)/uView.z + uView.xy;
  vec2 uv = (gp + 0.5)/uGrid;
  if(any(lessThan(gp, vec2(0.0))) || any(greaterThanEqual(gp, uGrid))){
    fragColor = vec4(0.055, 0.066, 0.086, 1.0); return;   // outside grid
  }
  vec4 terr = texture(uTerrain, uv);
  float z = (terr.r*65536.0 + terr.g*256.0 + terr.b)/100.0;
  bool isSea = uMapMode == 1 && terr.a < 0.6 && terr.a > 0.01;

  // terrain shading (hillshade from elevation gradient, 6x vertical boost)
  float tx = elevAt(gp + vec2(1,0)) - elevAt(gp - vec2(1,0));
  float ty = elevAt(gp + vec2(0,1)) - elevAt(gp - vec2(0,1));
  vec3 n = normalize(vec3(-tx, -ty, 2.0*uDx/6.0));
  vec3 L = normalize(vec3(-0.55, -0.65, 0.75));
  float shade = clamp(dot(n, L), 0.0, 1.0)*0.75 + 0.25;

  vec3 col;
  if(isSea){
    col = vec3(0.16, 0.24, 0.33);
  } else {
    float hn = clamp(z/220.0, 0.0, 1.0);
    vec3 land = mix(vec3(0.42, 0.48, 0.36), vec3(0.62, 0.58, 0.47), smoothstep(0.05, 0.5, hn));
    land = mix(land, vec3(0.55, 0.50, 0.45), smoothstep(0.5, 1.0, hn));
    col = land * shade;
  }
  // buildings (PLATEAU footprints)
  float b = uBldgOn == 1 ? bldgAt(gp) : 0.0;
  if(b > 0.0){
    float bn = clamp(b/30.0, 0.0, 1.0);
    col = mix(vec3(0.30, 0.31, 0.34), vec3(0.44, 0.45, 0.50), bn) * (shade*0.55 + 0.45);
  }
  // drainage network overlay (map)
  if(uMapMode == 1){
    float st = texture(uStreams, uv).r;
    col = mix(col, vec3(0.25, 0.55, 0.85), smoothstep(0.15, 0.9, st)*0.85);
  }

  float alpha = 1.0;
  if(uMode >= 1){
    vec4 s = texture(uState, uv);
    float h = s.x;
    float show = uMode == 3 ? s.w : h;
    if(show > 0.008 && uMode != 2){
      float d = show;
      vec3 wc = depthRamp(d);
      float a = clamp(d*5.0, 0.10, 0.94);
      if(uMode == 3) a *= 0.75;
      // moving shimmer where water is deep enough to flow
      vec4 s2 = texture(uState, uv);
      float sp = length(s2.yz)/max(h, 0.02);
      float shimmer = 0.92 + 0.08*sin(uTime*2.4 + (gp.x+gp.y)*0.55 + sp*6.0);
      col = mix(col, wc*shimmer, a);
    }
    if(uMode == 2){
      float sp = length(s.yz)/max(h, 0.02);
      if(h > 0.02 && sp > 0.05){
        float t = clamp(log(sp)/log(30.0), 0.0, 1.0);
        vec3 sc = mix(vec3(0.9,0.95,0.6), vec3(0.95,0.35,0.15), smoothstep(0.35, 0.8, t));
        sc = mix(sc, vec3(0.85,0.1,0.35), smoothstep(0.8, 1.0, t));
        col = mix(col, sc, clamp(h*5.0, 0.0, 0.85));
      }
    }
  }
  fragColor = vec4(col, alpha);
}`;

const REDUCE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform ivec2 uGrid;
out vec4 o;
void main(){
  ivec2 base = ivec2(gl_FragCoord.xy) * 16;
  float sumH = 0.0; float c1 = 0.0; float c2 = 0.0; float c3 = 0.0;
  for(int dy = 0; dy < 16; dy++){
    for(int dx = 0; dx < 16; dx++){
      ivec2 p = base + ivec2(dx, dy);
      if(any(greaterThanEqual(p, uGrid))) continue;
      float h = texelFetch(uState, p, 0).x;
      sumH += h;
      c1 += h > 0.05 ? 1.0 : 0.0;
      c2 += h > 0.30 ? 1.0 : 0.0;
      c3 += h > 1.00 ? 1.0 : 0.0;
    }
  }
  o = vec4(sumH, c1/256.0, c2/256.0, c3/256.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) + "\n" + src);
  }
  return sh;
}

function program(gl, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p));
  }
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

function makeTex(gl, w, h, internal, format, type, data) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);  // image row 0 = north = v=1
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return t;
}

export class FloodSim {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: false, alpha: false, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2非対応のブラウザです");
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("EXT_color_buffer_float が利用できません");
    }
    this.gl = gl;
    this.simPrg = program(gl, SIM_FRAG);
    this.renderPrg = program(gl, RENDER_FRAG);
    this.reducePrg = program(gl, REDUCE_FRAG);
    this.vao = gl.createVertexArray();
    this.view = { x: 0, y: 0, z: 1 };   // grid px: center + scale (screen px per cell)
    this.params = { rain: 0, drain: 15, infil: 1, manning: 0.03, bldgOn: 1 };
    this.time = 0;                      // simulated seconds
    this.rainLeft = 0;                  // seconds of rain remaining
    this.rainSeries = null;             // observed hyetograph [[t_sec, mm_h], ...]
    this.rainEnd = 0;                   // series end time (seconds)
    this.paused = true;
    this.volume0 = 0;
    this.stats = null;
  }

  /** terrainData: Uint8Array RGBA (cm encoding); bldgData same or null. */
  setGrid(width, height, mPerPx, terrainData, bldgData) {
    const gl = this.gl;
    this.W = width; this.H = height; this.dx = mPerPx;
    this.terrainTex = makeTex(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, terrainData);
    this.bldgTex = makeTex(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE,
      bldgData ? bldgData : new Uint8Array(width * height * 4));
    this.state = [null, null];
    for (let i = 0; i < 2; i++) {
      this.state[i] = makeTex(gl, width, height, gl.RGBA32F, gl.RGBA, gl.FLOAT,
        new Float32Array(width * height * 4));
    }
    this.fbo = [gl.createFramebuffer(), gl.createFramebuffer()];
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.state[i], 0);
    }
    // reduction target (1/16 grid, capped)
    this.rw = Math.max(1, Math.ceil(width / 16));
    this.rh = Math.max(1, Math.ceil(height / 16));
    this.reduceTex = makeTex(gl, this.rw, this.rh, gl.RGBA32F, gl.RGBA, gl.FLOAT, null);
    this.reduceFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reduceFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.reduceTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.flip = 0;
    this.time = 0;
    this.rainLeft = 0;
    this.paused = true;
    this.maxCells = width * height;
  }

  reset() {
    const gl = this.gl;
    const empty = new Float32Array(this.W * this.H * 4);
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.state[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.W, this.H, 0, gl.RGBA, gl.FLOAT, empty);
    }
    this.time = 0;
    this.rainLeft = this.rainSeries ? this.rainEnd : this.durationMin * 60 || 0;
    this.stats = null;
  }

  startScenario(rainMMh, durationMin) {
    this.params.rain = rainMMh;
    this.rainSeries = null;
    this.durationMin = durationMin;
    this.rainLeft = durationMin * 60;
    this.time = 0;
    this.paused = false;
  }

  /** Observed rainfall: piecewise-linear hyetograph [[t_sec, mm_h], ...]. */
  startHyetograph(series) {
    this.rainSeries = series;
    this.rainEnd = series[series.length - 1][0];
    this.rainLeft = this.rainEnd;
    this.time = 0;
    this.paused = false;
  }

  /** Rain intensity at model time t (mm/h); constant rate when no series. */
  rainRateAt(t) {
    const s = this.rainSeries;
    if (!s) return this.params.rain;
    if (t <= s[0][0]) return s[0][1];
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i][0]) {
        const t0 = s[i - 1][0], r0 = s[i - 1][1];
        return r0 + (s[i][1] - r0) * (t - t0) / Math.max(s[i][0] - t0, 1e-6);
      }
    }
    return 0;
  }

  setParams(p) { Object.assign(this.params, p); }

  /** Upload an <img> (overview png) as the terrain texture. */
  makeTexFromImage(img) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return t;
  }

  emptyTex(w, h) {
    return makeTex(this.gl, w, h, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE,
      new Uint8Array(w * h * 4));
  }

  step(dt) {
    const gl = this.gl;
    const src = this.state[this.flip], dst = this.state[1 - this.flip];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1 - this.flip]);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.simPrg.p);
    const u = this.simPrg.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);   gl.uniform1i(u.uState, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.terrainTex); gl.uniform1i(u.uTerrain, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.bldgTex);    gl.uniform1i(u.uBldg, 2);
    const p = this.params;
    const rainOn = this.rainLeft > 0 && !this.paused;
    const rainMMh = this.rainSeries ? this.rainRateAt(this.time) : p.rain;
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uDx, this.dx);
    gl.uniform1f(u.uG, 9.81);
    gl.uniform1f(u.uManning, p.manning);
    gl.uniform1f(u.uRain, rainOn ? rainMMh / 1000 / 3600 : 0);
    gl.uniform1f(u.uDrain, p.drain / 1000 / 3600);
    gl.uniform1f(u.uInfil, p.infil / 1000 / 3600);
    gl.uniform1f(u.uBldgOn, p.bldgOn);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.flip = 1 - this.flip;
    if (rainOn) this.rainLeft -= dt;
    this.time += dt;
  }

  /** Simulate `seconds` of model time in fixed substeps. */
  advance(seconds, maxSubsteps) {
    const dt = 0.05;
    let n = Math.ceil(seconds / dt);
    n = Math.min(n, maxSubsteps);
    for (let i = 0; i < n; i++) this.step(dt);
    return n * dt;
  }

  render(mode) {
    const gl = this.gl;
    const c = this.canvas;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.055, 0.066, 0.086, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.renderPrg.p);
    const u = this.renderPrg.u;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state ? this.state[this.flip] : null);
    gl.uniform1i(u.uState, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.terrainTex); gl.uniform1i(u.uTerrain, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.bldgTex);    gl.uniform1i(u.uBldg, 2);
    if (this.streamsTex) {
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.streamsTex); gl.uniform1i(u.uStreams, 3);
    } else { gl.uniform1i(u.uStreams, 0); }
    gl.uniform2f(u.uGrid, this.W, this.H);
    gl.uniform3f(u.uView, this.view.x, this.view.y, this.view.z);
    gl.uniform2f(u.uCanvas, c.width, c.height);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1f(u.uTime, performance.now() / 1000 % 10000);
    gl.uniform1f(u.uDx, this.dx);
    gl.uniform1i(u.uBldgOn, this.params.bldgOn > 0.5 ? 1 : 0);
    gl.uniform1i(u.uMapMode, this.mapMode ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Full-state readback for the 3D view (Float32Array W*H*4). */
  readState() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.flip]);
    const buf = new Float32Array(this.W * this.H * 4);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return buf;
  }

  /** Aggregate statistics; returns {volume, a5, a30, a100} (m3 / m2). */
  computeStats() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reduceFbo);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.useProgram(this.reducePrg.p);
    const u = this.reducePrg.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.state[this.flip]);
    gl.uniform1i(u.uState, 0);
    gl.uniform2i(u.uGrid, this.W, this.H);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const buf = new Float32Array(this.rw * this.rh * 4);
    gl.readPixels(0, 0, this.rw, this.rh, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let sumH = 0, f1 = 0, f2 = 0, f3 = 0;
    for (let i = 0; i < this.rw * this.rh; i++) {
      sumH += buf[i * 4]; f1 += buf[i * 4 + 1]; f2 += buf[i * 4 + 2]; f3 += buf[i * 4 + 3];
    }
    const cells = this.W * this.H;
    // each reduction texel sums a 16x16 block: sumH is already the true
    // total depth sum, while f1..f3 hold true counts divided by `block`
    const block = 256;
    const cellArea = this.dx * this.dx;
    this.stats = {
      volume: sumH * cellArea,
      a5: f1 * block * cellArea,
      a30: f2 * block * cellArea,
      a100: f3 * block * cellArea,
      cells,
    };
    return this.stats;
  }

  /** Rain volume that has fallen so far (m3). */
  rainVolume() {
    let mmTotal;
    if (this.rainSeries) {
      const s = this.rainSeries;
      const t = Math.min(this.time, this.rainEnd);
      mmTotal = 0;
      for (let i = 1; i < s.length; i++) {
        const t1 = Math.min(s[i][0], t);
        if (t1 <= s[i - 1][0]) break;
        mmTotal += (s[i - 1][1] + s[i][1]) / 2 * (t1 - s[i - 1][0]) / 3600;
        if (s[i][0] >= t) break;
      }
    } else {
      mmTotal = this.params.rain * Math.min(this.time, (this.durationMin || 0) * 60) / 3600;
    }
    return mmTotal / 1000 * this.W * this.H * this.dx * this.dx;
  }

  dispose() {
    const gl = this.gl;
    for (const k of ["terrainTex", "bldgTex", "streamsTex", "reduceTex"]) {
      if (this[k]) { gl.deleteTexture(this[k]); this[k] = null; }
    }
    if (this.state) for (const t of this.state) gl.deleteTexture(t);
    if (this.fbo) for (const f of this.fbo) gl.deleteFramebuffer(f);
    if (this.reduceFbo) gl.deleteFramebuffer(this.reduceFbo);
    this.state = null;
    this.fbo = null;
    this.reduceFbo = null;
  }
}
