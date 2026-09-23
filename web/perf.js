// 軽さ調査 (パフォーマンス計測) — 3種の3Dビュワー (three.js / deck.gl / CesiumJS)
// を同じ物差しで測るためのHUDとベンチモード。
//
// - PerfHud: 画面隅に FPS・フレーム時間・JSヒープ・タイル数を常時表示する
// - runBench: スクリプト化したカメラ移動 (軌道→近接) を走らせ、サンプルを
//   集計して JSON サマリを返す (?bench=秒 で自動実行、window.__benchResult)

const now = () => performance.now();

export class PerfHud {
  constructor() {
    this.el = document.createElement("div");
    this.el.id = "perfHud";
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.view = null;
    this.timer = null;
    const urlOn = new URLSearchParams(location.search).has("perf");
    if (urlOn) this.enable();
  }

  enable() {
    this.el.hidden = false;
    if (!this.timer) this.timer = setInterval(() => this._update(), 500);
  }

  disable() {
    this.el.hidden = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setView(view) {
    this.view = view;
  }

  /** 直近1秒のフレーム数からFPSを測る (ビュワーの描画フレームのみ数える)。 */
  _update() {
    const v = this.view;
    if (!v || v.hidden) { this.el.textContent = ""; return; }
    const fc = v.getFrameCount?.() ?? 0;
    if (this._lastFc === undefined || this._lastView !== v) {
      this._lastFc = fc;
      this._lastView = v;
      this._lastT = now();
      return;
    }
    const dt = now() - this._lastT;
    const fps = dt > 0 ? ((fc - this._lastFc) * 1000) / dt : 0;
    this._lastFc = fc;
    this._lastT = now();
    const mem = performance.memory
      ? ` ヒープ ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB`
      : "";
    const extra = v.getPerf ? v.getPerf() : {};
    const tiles = extra.tiles != null ? ` タイル ${extra.tiles}` : "";
    const mbyte = extra.bytes ? ` ${(extra.bytes / 1048576).toFixed(1)}MB` : "";
    const ward = extra.ward ? ` ${extra.ward}` : "";
    const req = extra.requests != null ? ` 要求 ${extra.requests}` : "";
    this.el.textContent =
      `${v.name ?? "3D"} ${fps.toFixed(0)} fps${tiles}${mbyte}${req}${ward}${mem}`;
  }
}

/**
 * ベンチモード: 15秒間カメラを動かしながらフレーム時間をサンプリングする。
 * 序盤10秒は範囲を一周する軌道、残り5秒は中心に寄って高度を下げる。
 * 戻り値は集計済みサマリ (window.__benchResult にも入る)。
 */
export async function runBench(view, seconds = 15, label = view.name) {
  const samples = [];   // {t, ms}
  const fc0 = view.getFrameCount?.() ?? 0;
  const t0 = now();
  let prevFc = fc0;
  const stopAt = t0 + seconds * 1000;

  const raf = () => new Promise((r) => requestAnimationFrame(r));
  while (now() < stopAt) {
    await raf();
    const t = (now() - t0) / 1000;
    const fc = view.getFrameCount?.() ?? 0;
    const fc0n = fc;
    const moved = fc0n !== prevFc;
    prevFc = fc0n;
    moveCamera(view, t, seconds);
    if (moved) samples.push({ t, fc: fc0n });
  }
  // フレームごとの時間差から FPS を復元
  const frames = samples.length;
  const dur = seconds;
  const gaps = [];
  for (let i = 2; i < samples.length; i++) {
    gaps.push(samples[i].t - samples[i - 1].t);
  }
  gaps.sort((a, b) => a - b);
  const pct = (p) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : NaN;
  const heap = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
  const extra = view.getPerf ? view.getPerf() : {};
  const summary = {
    viewer: label,
    seconds: dur,
    frames,
    fpsAvg: +(frames / dur).toFixed(1),
    msMedian: +(pct(0.5) * 1000).toFixed(1),
    msP95: +(pct(0.95) * 1000).toFixed(1),
    heapMB: heap == null ? null : +heap.toFixed(0),
    tiles: extra.tiles ?? null,
    tileMB: extra.bytes ? +(extra.bytes / 1048576).toFixed(1) : null,
  };
  window.__benchResult = summary;
  console.log("bench result:", summary);
  return summary;
}

/** 手動ベンチ用ハンドル (コンソールから __bench(15) のように呼ぶ)。 */
export function bindBenchHandle(getView) {
  window.__bench = (seconds = 15) => {
    const v = getView();
    if (!v) return Promise.reject(new Error("3Dビュワーが未初期化です"));
    return runBench(v, seconds, v.name);
  };
}

/** ベンチ用カメラパス: 0〜2/3は範囲を一周する軌道、残りは中心への近接視点。
 * 実装は各ビュワーの benchCamera() に委譲する。 */
function moveCamera(view, t, total) {
  view.benchCamera?.(t, total);
}
