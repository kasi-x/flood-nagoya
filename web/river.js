/** 1D river-channel model for the GPU flood sim.
 *
 * Channel cells are extracted from the terrain raster by D8 flow
 * accumulation (no sink filling — a screening approximation).  Each cell's
 * discharge follows the rational method (runoff coeff × intensity ×
 * upstream area); Manning's equation converts it to a stage; depth above
 * bankfull spills onto the 2D grid as a prescribed water depth.
 *
 * The field is computed once per region and re-used every frame; only the
 * scalar rain rate changes.
 */

// Hydraulic-geometry scaling (width/depth vs upstream area, km²).
const WIDTH_A = 2.5, WIDTH_B = 0.5;
const DEPTH_C = 0.3, DEPTH_D = 0.4;
const MANNING_RIVER = 0.035;
const RUNOFF_COEFF = 0.65;
const MIN_SLOPE = 1e-4;
const ACC_THRESHOLD_CELLS = 200;   // ~5 km² at 5 m

const D8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

/** Decode the terrain RGBA raster to metres (same encoding as sim.js). */
function decodeTerrCm(data, i) {
  return (data[i * 4] * 65536 + data[i * 4 + 1] * 256 + data[i * 4 + 2]) / 100;
}

/**
 * Extract channel geometry from the terrain raster.
 * terrainData: Uint8Array RGBA (cm), W×H cells, dx metres per cell.
 * Returns {mask, area, slope, width, depth} as Float32/Uint8 arrays.
 */
export function extractChannels(terrainData, W, H, dx) {
  const z = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) z[i] = decodeTerrCm(terrainData, i);

  // D8 steepest-descent direction (flag index into D8, -1 = sink/edge).
  const dir = new Int8Array(W * H).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let best = 0, bestFlag = -1;
      for (let f = 0; f < 8; f++) {
        const nx = x + D8[f][0], ny = y + D8[f][1];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const dist = dx * (D8[f][0] && D8[f][1] ? Math.SQRT2 : 1);
        const s = (z[i] - z[ny * W + nx]) / dist;
        if (s > best) { best = s; bestFlag = f; }
      }
      dir[i] = bestFlag;
    }
  }

  // Flow accumulation: process cells high→low, add each cell's count to
  // its downstream neighbour.
  const acc = new Float64Array(W * H).fill(1);
  const order = new Uint32Array(W * H);
  for (let i = 0; i < W * H; i++) order[i] = i;
  // sort indices by descending elevation
  order.sort((a, b) => z[b] - z[a]);
  for (const i of order) {
    const f = dir[i];
    if (f < 0) continue;
    const x = i % W, y = (i / W) | 0;
    const nx = x + D8[f][0], ny = y + D8[f][1];
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
    acc[ny * W + nx] += acc[i];
  }

  const mask = new Uint8Array(W * H);
  const area = new Float64Array(W * H);
  const slope = new Float64Array(W * H);
  const width = new Float64Array(W * H);
  const depth = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (acc[i] < ACC_THRESHOLD_CELLS) continue;
    mask[i] = 1;
    area[i] = acc[i] * dx * dx;
    const km2 = area[i] / 1e6;
    width[i] = WIDTH_A * Math.pow(km2, WIDTH_B);
    depth[i] = DEPTH_C * Math.pow(km2, DEPTH_D);
    // local slope = drop to the D8 neighbour
    const f = dir[i];
    if (f >= 0) {
      const x = i % W, y = (i / W) | 0;
      const nx = x + D8[f][0], ny = y + D8[f][1];
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const dist = dx * (D8[f][0] && D8[f][1] ? Math.SQRT2 : 1);
        slope[i] = Math.max((z[i] - z[ny * W + nx]) / dist, MIN_SLOPE);
      } else {
        slope[i] = MIN_SLOPE;
      }
    } else {
      slope[i] = MIN_SLOPE;
    }
  }
  return { mask, area, slope, width, depth, W, H };
}

/**
 * Per-cell river overflow depth [m] for a given rainfall intensity.
 * Returns a Float32Array (W*H) suitable for upload as a texture.
 */
export function riverExcessDepth(field, rainMmh) {
  const { mask, area, slope, width, depth, W, H } = field;
  const out = new Float32Array(W * H);
  if (rainMmh <= 0) return out;
  const intensity = rainMmh / 1000 / 3600;  // m/s
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const q = RUNOFF_COEFF * intensity * area[i];            // m³/s
    const denom = Math.max(width[i] * Math.sqrt(slope[i]), 1e-9);
    const stage = Math.pow((q * MANNING_RIVER) / denom, 0.6); // Manning depth
    const ex = stage - depth[i];
    if (ex > 0) out[i] = ex;
  }
  return out;
}
