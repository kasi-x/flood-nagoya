// 地理座標ユーティリティ — 3Dビュワー (three.js / deck.gl / CesiumJS) 共通。
// シミュレーション格子 (regionInfo) と Web Mercator タイル座標の相互変換、
// PLATEAU 建物 3D Tiles の選択、水深フィールドのキャンバス描画を提供する。

const TILE_PX = 256;
const Z15 = 15;   // ソースタイルのズーム (regionInfo の left/top は z15 px)

// Web Mercator: タイル座標 (小数) → 経緯度
export function tileXToLon(x, z) {
  return x / 2 ** z * 360 - 180;
}
export function tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * regionInfo (W, H, dx, left, top) から [west, south, east, north] を度で返す。
 * left/top は tile_range 原点からの z15 ピクセルオフセット。
 * セルサイズ dx [m] から z15 ピクセル換算の幅・高さを求めるので、
 * 全域モード (overview) と通常リージョンの両方で正しくなる。
 */
export function regionBBox(ri, meta) {
  const { x0, y0 } = meta.tile_range;
  // 1 z15 px = meta.z15MPerPx m (meta.bbox 中央緯度)。dx から z15 px 数を出す。
  const pxW = ri.W * ri.dx / meta.z15MPerPx;
  const pxH = ri.H * ri.dx / meta.z15MPerPx;
  const tx0 = x0 + ri.left / TILE_PX;
  const ty0 = y0 + ri.top / TILE_PX;
  const tx1 = tx0 + pxW / TILE_PX;
  const ty1 = ty0 + pxH / TILE_PX;
  return [
    tileXToLon(tx0, Z15), tileYToLat(ty1, Z15),
    tileXToLon(tx1, Z15), tileYToLat(ty0, Z15),
  ];
}

// ---------- PLATEAU 建物 3D Tiles ----------
// 名古屋市 (23100) の区ごとの tileset.json。実行時に公式データカタログ API から
// 取得して cache するが、API が使えない環境でも表示できるよう
// 2026-09 時点のカタログ内容をフォールバックとして保持する。
// 出典: Project PLATEAU 名古屋市 2022 (CC BY 4.0 / PLATEAU利用規約)
export const NAGOYA_WARDS = [
  {
    ward: "千種区", code: "23101", lon: 136.9345, lat: 35.1565, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/e3/c5a409-dfb4-415c-a0a1-3c2c565fb3b8/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23101_chikusa-ku_lod1/tileset.json"
    }
  },
  {
    ward: "東区", code: "23102", lon: 136.9432, lat: 35.1827, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/02/d91205-c321-4541-b93d-47d699041068/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23102_higashi-ku_lod1/tileset.json",
      "2": "https://assets.cms.plateau.reearth.io/assets/8c/61d87b-1235-4a68-8f92-d9fabc3a83a6/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23102_higashi-ku_lod2/tileset.json"
    }
  },
  {
    ward: "北区", code: "23103", lon: 136.9117, lat: 35.1832, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/5d/9e8a10-159a-4aab-b7fb-9b50e4739f53/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23103_kita-ku_lod1/tileset.json"
    }
  },
  {
    ward: "西区", code: "23104", lon: 136.8845, lat: 35.1965, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/83/8dff0f-7706-4a88-8de5-2418f41889aa/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23104_nishi-ku_lod1/tileset.json",
      "2": "https://assets.cms.plateau.reearth.io/assets/39/2a339e-9442-4e4e-bed6-ee48d5ca8feb/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23104_nishi-ku_lod2/tileset.json"
    }
  },
  {
    ward: "中村区", code: "23105", lon: 136.8585, lat: 35.1693, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/20/220623-b369-4fd9-9525-0cf09de0c447/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23105_nakamura-ku_lod1/tileset.json",
      "2": "https://assets.cms.plateau.reearth.io/assets/e2/807542-e5d2-4f05-a1e2-85fa59db11b3/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23105_nakamura-ku_lod2/tileset.json"
    }
  },
  {
    ward: "中区", code: "23106", lon: 136.9026, lat: 35.1653, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/ea/bf8edc-e0d9-466f-a9f7-822b3ef34851/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23106_naka-ku_lod1/tileset.json",
      "2": "https://assets.cms.plateau.reearth.io/assets/40/8090fa-6b99-4e7c-b21c-0e2634f65e01/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23106_naka-ku_lod2/tileset.json"
    }
  },
  {
    ward: "昭和区", code: "23107", lon: 136.932, lat: 35.1502, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/ad/df2ca9-381e-41fa-b79b-dfcc964638a7/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23107_showa-ku_lod1/tileset.json"
    }
  },
  {
    ward: "瑞穂区", code: "23108", lon: 136.9347, lat: 35.1335, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/ed/2043ca-8471-4d5d-ae9f-cedcb46a75aa/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23108_mizuho-ku_lod1/tileset.json"
    }
  },
  {
    ward: "熱田区", code: "23109", lon: 136.9024, lat: 35.1288, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/48/98bbde-44d2-483f-9191-6653e5744ad3/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23109_atsuta-ku_lod1/tileset.json"
    }
  },
  {
    ward: "中川区", code: "23110", lon: 136.8547, lat: 35.139, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/a9/1dc07d-d6b2-470a-8431-6a73334ce00a/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23110_nakagawa-ku_lod1/tileset.json",
      "2": "https://assets.cms.plateau.reearth.io/assets/07/acbe1b-356a-47a1-8ea3-b6d7490f7989/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23110_nakagawa-ku_lod2/tileset.json"
    }
  },
  {
    ward: "港区", code: "23111", lon: 136.8826, lat: 35.0922, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/79/d67234-5b9d-4515-a16b-55edfe7d3bd3/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23111_minato-ku_lod1/tileset.json",
      "2": "https://assets.cms.plateau.reearth.io/assets/a0/e447aa-07b0-4036-bb01-56dc6cbb9984/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23111_minato-ku_lod2/tileset.json"
    }
  },
  {
    ward: "南区", code: "23112", lon: 136.9109, lat: 35.1097, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/52/c3206f-5462-4b84-ad50-a34ccf9303f4/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23112_minami-ku_lod1/tileset.json"
    }
  },
  {
    ward: "守山区", code: "23113", lon: 136.9443, lat: 35.2162, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/42/4f909f-374b-4fae-8dde-1023720e7ea5/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23113_moriyama-ku_lod1/tileset.json"
    }
  },
  {
    ward: "緑区", code: "23114", lon: 136.9596, lat: 35.1168, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/4b/c438fd-635e-4b65-ae6f-df30d2cf5bdf/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23114_midori-ku_lod1/tileset.json"
    }
  },
  {
    ward: "名東区", code: "23115", lon: 136.9953, lat: 35.1783, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/e8/fb6aed-a8cb-4a04-8729-c73d12705f94/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23115_meito-ku_lod1/tileset.json"
    }
  },
  {
    ward: "天白区", code: "23116", lon: 136.9655, lat: 35.1253, urls: {
      "1": "https://assets.cms.plateau.reearth.io/assets/aa/899325-e5ab-4d5b-9c34-4e9c420e5035/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23116_tempaku-ku_lod1/tileset.json"
    }
  },
];

/** 最近傍の区を選ぶ (区境界の厳密な判定はしない簡易方式)。 */
export function pickWard(lon, lat) {
  let best = NAGOYA_WARDS[0], dBest = Infinity;
  for (const w of NAGOYA_WARDS) {
    const d = (w.lon - lon) ** 2 + (w.lat - lat) ** 2;
    if (d < dBest) { dBest = d; best = w; }
  }
  return best;
}

let catalogCache = null;   // {ward_code: {lod: url}}

/** PLATEAU公式データカタログAPIから名古屋市bldgのtileset URL一覧を取得 (失敗時null)。 */
export async function fetchWardCatalog() {
  if (catalogCache) return catalogCache;
  try {
    const r = await fetch("https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets");
    if (!r.ok) return null;
    const d = await r.json();
    const map = {};
    for (const ds of d.datasets || []) {
      if (ds.city_code === "23100" && ds.type_en === "bldg" && ds.url) {
        const byLoad = (map[ds.ward_code] ??= {});
        const lod = String(ds.lod);
        // textureありを優先 (no_textureは軽さ比較用)
        if (!byLoad[lod] || ds.texture) byLoad[lod] = ds.url;
      }
    }
    if (!Object.keys(map).length) return null;
    catalogCache = map;
    return map;
  } catch {
    return null;
  }
}

/** 指定位置の区の建物 tileset.json URL を返す。lod: "1"|"2"。
 * カタログAPIを優先し、失敗すれば内蔵テーブルにフォールバックする。 */
export async function pickBldgTileset(lon, lat, lod = "2") {
  const w = pickWard(lon, lat);
  const cat = await fetchWardCatalog();
  let url = cat?.[w.code]?.[lod];
  if (!url && lod === "2") url = cat?.[w.code]?.["1"];
  if (!url) url = w.urls[lod] || w.urls["1"];
  return { ward: w.ward, url };
}

/** bbox と重なる全区の建物 tileset を返す (区境をまたぐリージョン用)。
 * 区の厳密な境界ポリゴンは持たないので、区の代表点が bbox+マージン内に
 * ある区を選ぶ。マージンは区の典型的な半径 (~3km ≈ 0.03°) を見込む。 */
export async function pickBldgTilesets(bbox, lod = "2") {
  const [west, south, east, north] = bbox;
  // 代表点と bbox の最短距離が区の典型的な半径 (~7km ≈ 0.08°) 以内なら含める。
  const M = 0.08;
  const wards = NAGOYA_WARDS.filter((w) => {
    const dx = Math.max(west - w.lon, 0, w.lon - east);
    const dy = Math.max(south - w.lat, 0, w.lat - north);
    return Math.hypot(dx, dy) <= M;
  });
  if (!wards.length) wards.push(pickWard((west + east) / 2, (south + north) / 2));
  const cat = await fetchWardCatalog();
  const out = [];
  for (const w of wards) {
    let url = cat?.[w.code]?.[lod];
    if (!url && lod === "2") url = cat?.[w.code]?.["1"];
    if (!url) url = w.urls[lod] || w.urls["1"];
    if (url) out.push({ ward: w.ward, url });
  }
  return out;
}

// ---------- 建物高さラスタ → 箱インスタンス (three.js / deck.gl 共通) ----------
// terrainData は標高(cm)を R*65536+G*256+B、bldgData は建物高さ(cm)を
// R*256+G で保持する RGBA ラスタ。行0は北端。

/** RGBAラスタの画素 i から標高 (m) を復号する。 */
export function decodeTerrCm(data, i) {
  return (data[i * 4] * 65536 + data[i * 4 + 1] * 256 + data[i * 4 + 2]) / 100;
}

/**
 * 建物高さラスタを同一高さの矩形に貪欲マージする。
 * ピクセル毎に箱を立てると建物が細い棒の束に見えるため 1棟=1矩形にまとめ、
 * 孤立した1セルの高層スパイク (>=60m かつ近傍の半分以下) はノイズとして除外する。
 * 戻り値: [sx, sy, w, h, hCm] の配列 (sy=0 が北端)。
 */
export function mergeBuildingRects(bldgData, W, H) {
  const bhAt = (x, y) => {
    const i = (y * W + x) * 4;
    return bldgData[i] * 256 + bldgData[i + 1];
  };
  const visited = new Uint8Array(W * H);
  const rects = [];
  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const si = sy * W + sx;
      if (visited[si]) continue;
      const hCm = bhAt(sx, sy);
      visited[si] = 1;
      if (!hCm) continue;
      const tol = Math.max(100, hCm * 0.02);   // 許容誤差: 1m または 2%
      let w = 1;
      while (sx + w < W && !visited[si + w]) {
        const hj = bhAt(sx + w, sy);
        if (!hj || Math.abs(hj - hCm) > tol) break;
        w++;
      }
      let hh = 1;
      grow: while (sy + hh < H) {
        for (let dx = 0; dx < w; dx++) {
          const j = (sy + hh) * W + sx + dx;
          if (visited[j]) break grow;
          const hj = bhAt(sx + dx, sy + hh);
          if (!hj || Math.abs(hj - hCm) > tol) break grow;
        }
        hh++;
      }
      for (let dy = 0; dy < hh; dy++) {
        visited.fill(1, (sy + dy) * W + sx, (sy + dy) * W + sx + w);
      }
      // 孤立した1セルの高層スパイクはノイズとして除外する
      if (w * hh === 1 && hCm >= 6000) {
        const nb = Math.max(
          sx > 0 ? bhAt(sx - 1, sy) : 0,
          sx + 1 < W ? bhAt(sx + 1, sy) : 0,
          sy > 0 ? bhAt(sx, sy - 1) : 0,
          sy + 1 < H ? bhAt(sx, sy + 1) : 0,
        );
        if (nb < hCm * 0.5) continue;
      }
      rects.push([sx, sy, w, hh, hCm]);
    }
  }
  return rects;
}

// ---------- 水深フィールドのキャンバス描画 ----------
// 2D/3D (three.js) の水面カラーランプと同じ勾配。
export function depthRamp(d) {
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const sm = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  let c = [209, 242, 255];
  c = mix(c, [84, 181, 242], sm(0.03, 0.20, d));
  c = mix(c, [46, 115, 232], sm(0.20, 0.50, d));
  c = mix(c, [41, 74, 207], sm(0.50, 1.00, d));
  c = mix(c, [66, 54, 184], sm(1.00, 2.00, d));
  c = mix(c, [92, 46, 158], sm(2.00, 3.50, d));
  return c;
}

/**
 * シミュレーション状態 (Float32Array RGBA, row0=南) を水深色のキャンバスに描く。
 * 出力キャンバスの row0 は北 (地理画像の慣習に合わせる)。
 * maxW を与えると幅を制限して縮小描画する (CesiumへのPNG転送量の抑制)。
 */
export function drawWaterCanvas(canvas, state, stateW, stateH, maxW = Infinity) {
  const scale = Math.min(1, maxW / stateW);
  const cw = Math.max(1, Math.round(stateW * scale));
  const ch = Math.max(1, Math.round(stateH * scale));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  const img = ctx.createImageData(cw, ch);
  const px = img.data;
  for (let j = 0; j < ch; j++) {
    // state row0=南 → 出力 row0=北
    const srcRow = Math.min(stateH - 1, Math.floor((ch - 1 - j) / scale));
    for (let i = 0; i < cw; i++) {
      const srcCol = Math.min(stateW - 1, Math.floor(i / scale));
      const d = state[(srcRow * stateW + srcCol) * 4];
      const o = (j * cw + i) * 4;
      if (!(d > 0.01)) { px[o + 3] = 0; continue; }
      const c = depthRamp(d);
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
      px[o + 3] = Math.round(Math.min(0.92, Math.max(0.18, d * 5)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** 遅延スクリプト読み込み (同一URLは1回だけ)。 */
export function loadScript(src, id) {
  return new Promise((resolve, reject) => {
    const done = () => resolve();
    let el = id ? document.getElementById(id) : null;
    if (el) return done();
    el = document.createElement("script");
    if (id) el.id = id;
    el.src = src;
    el.onload = done;
    el.onerror = () => reject(new Error(`スクリプトの読み込みに失敗: ${src}`));
    document.head.appendChild(el);
  });
}
