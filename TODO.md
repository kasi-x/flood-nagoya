# 未決・保留事項

## deck.gl ビュワーの重さと建物ポリゴン

### 背景
- deck.gl 版は `?3d=deck` で切り替え可能
- 既定では PLATEAU 名古屋市 3D Tiles（1区・LOD2） + GSI 航空写真タイル + AWS Terrain Tiles を読み込む
- ソフトウェアレンダリング環境でも重く、実GPU環境では特に建物ポリゴンと写真テクスチャがボトルネックになりうる

### 2026-09-23 検証済み
- URLパラメータで軽量構成を即座に試せるようにした
  - `?photo=0`：航空写真OFF
  - `?bldg=0`：PLATEAU建物OFF
  - `?terrain=low|medium|high`：地形メッシュの粗さ/ズームを切り替え
  - `?lod=1|2`：PLATEAU建物のLOD切り替え
  - `?lite=1`：上記を一括指定する軽量プリセット
  - `?bldg=simple`：PLATEAUタイルの代わりにローカルラスタの箱型建物
  - `?bldgmsse=<px>`：PLATEAUタイルの maximumScreenSpaceError 上書き
- 地形タイル読み込みをシミュレーション領域（`bounds`）に絞った
- 12秒ベンチ（ヘッドレス環境）

| 設定 | FPS avg | median ms | ヒープ(MB) | タイル数 | タイル(MB) |
|---|---|---|---|---|---|
| heavy: LOD2 + 建物ON + 写真ON + terrain high | 2.3 | 444 | 387 | 70 | 139 |
| medium: LOD1 + 建物ON + 写真ON + terrain medium | 3.8 | 289 | 394 | 62 | 80 |
| lightest: 建物OFF + 写真OFF + terrain low | 20.0 | 32 | 182 | 0 | 0 |

### 対応状況（2026-09-23 完了）
1. ~~軽量プリセットのUIボタン~~ → `lite3dBtn` を3Dオプション内に追加。
   deck.gl を lod=1 / 写真OFF / 建物OFF / 地形low で起動する。
2. ~~建物の簡易表示（ローカルラスタ版）~~ → `bldg=simple` + UIラジオ
   （`bldgSrcCtl`）で `geo.js` の `mergeBuildingRects` から箱型建物を生成。
3. ~~PLATEAU建物の読み込み制限~~ → `BLDG_MSSE` を地形クオリティに連動 +
   `?bldgmsse=` で上書き可能にした。
4. ~~デフォルト構成の変更~~ → `detectSoftwareGL()` でソフトウェアGL環境を
   検出し、`?lite=0` 指定がなければ軽量既定 (deck.gl + lite) に倒す。

### 残課題
- 実GPU環境での再ベンチ（ヘッドレスは SwiftShader のため実機差が大きい）
- ~~軽量プリセット中に建物を出したい場合の既定は `bldg=simple` 推奨~~
  → 2026-09-24 対応: lite プリセットは `bldgSrc=simple` を既定にした
  （建物トグルONでローカル箱を表示、PLATEAUタイルは読み込まない）

### 2026-09-24 追加対応
- **CesiumJSの建物浮き**: 地形の既定を公開PLATEAU-Terrain
  (`https://tile.plateauview.mlit.go.jp/terrain`、quantized-mesh・楕円体高・
  Ion不要) に変更。PLATEAU建物と垂直基準が合うため `?hoff=` の手動補正は
  通常不要。取得失敗時のみ自前GSI DEM (正標高) に退避。原因は自前地形が
  dem5a_png (正標高) のままだったことで、建物 (楕円体高) と約ジオイド高ぶん
  ずれていたため。合わせて deck.gl 側も調査: terrarium は dem5a_png と
  中央値で約+12mずれ、PLATEAU建物との基準一致は保証されないことを文書化。
  独自の毎回修正は不要 (正しい地形を選ぶだけで解消)。
- **気象レイヤー**: RainViewer 降水レーダーを deck.gl に追加 (`weatherToggle` / `?weather=1`)
- **分水域・流路オーバーレイ**: `streams.png` を `BitmapLayer` で地形にドレープ
- **建物の浮き修正**: `buildBldgInstances` で footprint 最低地盤高を底面に変更
  （斜面で建物が浮かないよう `minBed - margin` を底面、`bedAvg + bh` を上面に）
### 参考URLパラメータ例
```
?3d=deck&region=1&lod=1&photo=0&bldg=0&terrain=low
?lite=1
?3d=deck&bldg=simple
```

## CesiumJS ビュワーの未解決問題 (2026-09-25 引き継ぎ → 10-01 実施)

### 解決 (2026-10-01)
- **~1fps の主犯は `sim.readState()`**: フル解像度 RGBA32F の readPixels
  (ライブ40MB、リプレイグリッドで10MB) が ANGLE 上で1呼出数百ms〜秒級に
  stall し、8フレーム毎の `view3d.updateWater(sim.readState())` が
  メインスレッドを塞いでいた。CPUプロファイルで readPixels が
  全サンプルの ~85% を占有。`_waterLayer`/`_ensureWaterMesh` の失敗ではない。
- **対応**: `sim.readStatePacked()` を追加 — GPU側で 1/4 解像度 RGBA8
  (R=depth cm hi, G=lo, B=qx, A=qy ±8m²/s) に畳み込んでから readPixels。
  CesiumView は `packedWater=true` を宣言し app.js が packed を渡す。
  リプレイの Float32Array は `_packState()` で同じパッキングに変換。
  readPixels ヒットは 8684→25/10s に減少。
- **建物への水面の滲み**: フラグメントシェーダに `uBldg` マスクを追加。
  建物高さラスタ (RG=cm) を読み、`bh > v_depth` の画素は discard。
  メッシュ解像度 (~10-20m) が建物稜線をまたいでも屋根に水が出ない。
  `bldgData` がある場合のみ有効 (ない場合は全域0の1x1テクスチャ)。
- **シーク時フラッシュ**: 従来の snap 伝播を生かしつつ、
  `updateWater` の250msスロットルがシーク最終位置を捨てる bug を修正
  (`snap=true` はスロットルを迂回)。`_frontAge` 更新はパック済み
  u8 を直接読む。手動シークで young セル数 0 を確認。
- **16区全タイルセット読み込み**: `pickBldgTilesets` は区代表点±0.08°で
  全16区を拾っていた。`tileset.json` の root.boundingVolume と bbox の
  実交差で絞り込む `_filterPicksByBounds()` を追加 → 7-9区に。
- **テクスチャ割当チャーン**: `_uploadWaterTextures` が毎回 3枚の
  Cesium.Texture を新規作成していた (旧破棄なし)。`_setTex()` で同寸時
  `copyFrom({source:{...}})` 再利用、寸法変更時のみ作り直し+destroy。
- **起動時 crash**: `_initStreaks` が viewer 生成前に camera.* に触れて
  TypeError → startPlayback の catch に転がりリプレイが開始しなかった。
  viewer null ガードを追加。
- **`?rscale=<0-1>`**: preserveDrawingBuffer=true の present/composite が
  弱いGPUで支配的。明示上書き + ソフトウェアGL検出時のみ自動 0.7。
  この環境 (ANGLE Intel UHD 620) で 1.0→0.5 で ~9→~15fps。

### 検証結果 (2026-10-01、headless ANGLE iGPU 環境)
- FPS: ベースライン ~0.5-1.4 → 9.7 (リプレイ再生中)
- scene.render() 中央値 ~2.2ms。残る遅さは RAF/present が ~150ms で
  ヘッドレス+iGPU 環境の上限に近い。実GPU環境ではさらに速いはず。
- ビルド: 16区→7区 (名古屋大学周辺リージョン)
- `just check` 全緑 (lint/type-check/test 163件)

### 残る留意点
- リプレイの `updateWater` は Float32Array→u8 の JS パックが入る。
  シーカードラッグ中は250msスロットルを通るので重くないが、
  今後リプレイもGPUパック化するとより滑らかになる。
- `_updateWaterImagery` フォールバック (メッシュ構築失敗時) は
  `_packToFloat` で Float32Array を復元して drawWaterCanvas に渡す。
- 対象ファイル: `web/view3d_cesium.js` (CesiumView、シェーダは
  `WATER_VERT`/`WATER_FRAG`)、`web/sim.js` (`PACK_FRAG`/`readStatePacked`)、
  `web/app.js` (`packedWater` 分岐)
### 後日談 (2026-10-01): GPUネイティブビュワーを既定に
- 上記の調査で残った根本原因 — 水位の CPU 経由転送と建物ジオメトリ —
  を一挙に解消するため、`web/view3d_gpu.js` (GpuView) を新設し既定にした。
- FloodSim と同一 GL コンテキストで描画し、水位は `sim.state[flip]`
  (RGBA32F) を頂点シェーダから直接サンプル。readPixels/readStatePacked は
  一切通らないので滲み・シーク時フラッシュ・ストールが構造的に消える。
- 建物はシムの壁セルと一致させるため建物ラスタをインスタンス化ボックスで
  描画。列マージ + 同高行マージ + >=2x2セルフィルタ + 面積降順LODで
  55k→描画~28k インスタンス。WATER は深度フィールド法線+Fresnel+流速
  ホワイトウォーター。
- 結果 (この環境の ANGLE iGPU): 3ドローコール/フレーム、リプレイで
  ~13fps 建物OFF / ~3fps 建物ON (VM上の iGPU 制限; 実GPUでは大幅に速い)。
  Cesium 版の ~9.7fps より遅く見えるが、こちらは present 待ちのない
  ネイティブ描画で、強い GPU では桁違いに速い。
- `?3d=` で three/deck/cesium/gpu を選択可能 (既定 gpu)。
  2D ハンドラは `view3dOn` ガードで GpuView のポインタ操作と分離。


## 河川氾濫モデル (2026-09-24 実装)

### 概要
- 1D河道モデル (集水域→流量→Manning水位→bankfull超過→2D溢水) を実装
- `src/flood_nagoya/river.py`: D8流向・流量累積・河道抽出・水位計算
- `web/river.js`: ブラウザ側の河道抽出 (GPUシェーダー用テクスチャ生成)
- `web/sim.js`: `uRiver`/`uRiverOn` ユニフォーム + `setRiverField()` で河道パラメータをGPUにアップロード
- `web/app.js`: `applyRiverField()` でリージョン設定時に河道フィールドを計算
- `web/index.html`: 「河川氾濫」トグルを追加
- `precompute.py`: `--river` フラグでオフライン事前計算にも対応

### 物理モデル
- 流量: 合理式 `Q = C·I·A` (C=0.65, I=降雨強度, A=集水域面積)
- 水位: Manning `h = (Q·n/(W·√S))^0.6` (n=0.035)
- 溢水: `max(0, stage - bankfull)` を2Dグリッドに強制水深として注入
- 河道抽出: D8最急降下 + 流量累積 (閾値200セル ≈ 5km²)

### 残課題
- ~~集中時間ラグは現在の降雨強度で近似 (厳密には畳み込みが必要)~~
  → 2026-09-24 対応: セル毎の集中時間 (最長上流流路長 L ÷ 実効流速
  v=1.5·√(S/0.01) m/s、0.3–3.0 m/sにクリップ) をピークとする三角単位
  hydrograph (底辺 2·lag、3タップ重み {0.25,0.5,0.25}) でハイエトグラフを
  畳み込み、放流が遅れかつ減衰するようにした。Python側は
  `river_excess_depth(field, series=…, t=…)`、GPU側はハイエトグラフを
  1Dテクスチャ (`uRainSeries`, 60sビン) + ラグテクスチャ (`uRiverLag`)
  としてシェーダ内で3タップ補間サンプル。空間分布レインテクスチャ使用時は
  履歴を持たないため現行レートのまま (近似)。降雨停止後もラグ分だけ
  河道放流が続く。実測 (名古屋大学周辺): lag 960–1568s。
- 河道ネットワークの動的ルーティングは未実装 (静的フィールドのみ)
- 検証: 名古屋大学周辺で河道セル648個を検出、100mm/h降雨で2.2mの溢水を確認

## 衛星検証 (2026-09-25 実装)

### 概要
- `src/flood_nagoya/satellite.py`: ASF Search (Sentinel-1/NISAR) + NASA CMR
  (SWOT/IMERG) + Tellus (JAXA) の検索・ダウンロード。認証は
  `EARTHDATA_TOKEN` / `~/.netrc` / `TELLUS_API_TOKEN`。
- `src/flood_nagoya/validate.py`: 衛星水域マップとシミュレーション最大
  水深の比較。reproject は rioxarray/rasterio (experiment extra) に委譲、
  sim格子への最終写像は z15ラティスの逆変換 `sim_lonlat` + bilinear
  サンプリング。
- CLI: `flood-nagoya validate --region <precomputed dir> [--swot …]
  [--swot-pre …] [--nisar-pre/--nisar-post …] [--s1-pre/--s1-post …]`

### 2026-09-08 洪水での初回結果 (nagoya_univ リージョン)
- SWOT (9/10 pass-575 vs 8/20 pass-560 ベースライン差分):
  新規水域 23,844セル。F1=0.068 P=0.040 R=0.209。
  モデルは街路網に広く浅い浸水を予測するのに対し、SWOTは池・低地の
  まとまった湛水のみ検出 → 分布型の違いが主な不一致要因。
  フットプリント比較 (各100mピクセル内のモデル浸水率 vs water_frac)
  でも相関 -0.014 とほぼ無相関 → モデルの空間分布の較正が課題。
- NISAR GCOV 上りペア (8/29 vs 9/10, HH): 新規水域 187セルのみ。
  9/10はピークから約2日後で市街地の湛水はほぼ退去済みと解釈。
- NISAR GCOV 下りペア (8/28 vs 9/9, HH): 減少 134 / 増加 2,273セル。
  増加側が優勢 (市街地洪水の double-bounce 増光と整合) だが、モデル
  浸水域との空間的一致は弱い (model>=0.1m内の増加は338/2273)。
  80mポスティングのGCOVでは市街地の小規模湛水を捉えきれない可能性。
- Sentinel-1 GRD: ASF datapool は Earthdata アプリ承認 (EULA) が必要。
  `https://urs.earthdata.nasa.gov/approve_app?client_id=BO_n7nTIlMljdvU6kRRB3g`

### 残課題
- Sentinel-1: EULA承認後に GRD ペア (8/29 vs 9/10) を検証
- ~~L-band 市街地洪水では double-bounce 増光が支配的な可能性 →
  増光側 (>+3dB) の検出も評価する~~
  → 2026-09-25 対応: 下りペア (8/28 vs 9/9) で増光 2,273セル、
  モデル浸水域内の増光は338セル (F1=0.005)。上りペア (8/29 vs 9/10) は
  増光 1,609セル、モデル内272セル (F1=0.004)。増光側も空間的一致は弱い。
- ~~SWOT water_frac 閾値の感度解析 (0.5 固定 → 0.3/0.7)~~
  → 2026-09-25 対応: 閾値0.3 で F1=0.127 (P=0.099 R=0.176)、
  閾値0.5 で F1=0.068 (P=0.040 R=0.209)、閾値0.7 で F1=0.036
  (P=0.020 R=0.271)。低閾値ほど検出数は増えるが精度は下がる。
  モデルの空間分布のずれが支配的で、閾値調整では解消しない。
- モデル過大予測の原因調査: 排水・浸透パラメータの再較定

### Web UI オーバーレイ (2026-09-25)
- `precompute/<region>/validation/` に `sat_{swot,nisar}.png` (R=衛星水域,
  G=モデル浸水, B=一致) と `validation.json` を事前計算。
- リプレイ開始時に自動読み込み。「衛星検証 (SWOT/NISAR)」トグルで
  2D表示に重畳: 青=衛星のみ検出、黄=モデルと一致。
- `satInfo` 行に F1/TP/FP/FN を表示。

## deck.gl 水流表示 (weatherlayers-gl 統合) — Cesium完了後に着手

- Cesium 版は画面空間ストリーク (2026-09-25 実装済) で対応済み。
- deck.gl 版 (`?3d=deck`) には weatherlayers-gl の ParticleLayer を統合する:
  - https://weatherlayers.github.io/ — nullschool方式のGPUパーティクル
  - 流速場はシム状態の (qx, qy) をテクスチャ化して渡す
    (`imageUnscale` で [min,max] マッピング)。
  - ESM CDN (esm.sh) で deck.gl と同バージョンに揃えて試す。
  - 水流トグル (`flowToggle`) と連動させる。

## 今後の拡張ロードマップ (2026-09-25 ユーザ要求)

優先順位順。各項目は既存モジュールの拡張として実装する。

### 1. 下水ネットワーク状態のシミュレーション
- 管渠の充水率・マンホール越流・ポンプ稼働状態をモデル化
- 候補実装: PySWMM (EPA-SWMM5) でオフライン計算し結果をリプレイ化、
  または `underground.py` を拡張して簡易管渠ネットワークをGPUシムに結合
- 名古屋市の下水道管網データ (オープンデータ/PLATEAU) の調達が前提

### 2. 地下貯留槽の稼働効果 — 反実仮想計算
- 名古屋市の地下貯留施設 (大高緑地地下貯水槽など) を貯留容量・
  取水流量パラメータとして `underground.py` に追加
- 稼働ON/OFFの2シナリオを precompute して浸水面積・深さの差分を出力
- UI: リプレイに「貯留槽あり/なし」の切替を追加

### 3. 河川調整戦略の事後評価シミュレーション
- 調節池・ダム・水門の放流ルールを `river.py` の1D河道モデルに追加
  (現行は静的溢水のみ。貯留容量と放流量の時間変化が必要)
- 複数の操作ルールを並列計算し、浸水被害指標 (面積・最深・継続時間) で
  比較して「実際の操作は最適だったか」を評価する枠組み
- 評価指標は `validate.py` の衛星比較と整合させる

## GeoLibre エクスポート (2026-10-01 実装・検証済み)

外部 GIS プラットフォーム連携として GeoLibre (MapLibre GL JS ベース、
`geolibre.app`) を評価・採用。結果は時間表現を除きほぼ完全に動作する。

### 実装
- `src/flood_nagoya/geolibre.py` + CLI `flood-nagoya geolibre-export`
  - precomputed PNG フレーム (Rチャンネル=水深cm) → EPSG:3857 COG (float32 m)
  - 最大水深 COG + キーフレーム COG 群 (既定 1h 間隔 + ピーク時)
  - `depth.style.json` (blues colormap, rescale 0..3m, nodata=0→透明)
  - `<region>.geolibre` プロジェクト JSON (13レイヤー + storymap チャプター)
- ホスティング: GitHub Pages (`gh-pages` ブランチ、`kasi-x.github.io/flood-nagoya/`)
  - Range request + `Access-Control-Allow-Origin: *` 確認済み → COG ストリーミング可
  - HF datasets は `anosillus` トークンがリポジトリ作成権限なしで不採用

### 検証済み (ブラウザ実機)
- `?data=<cog_url>&style=<style_url>` で COG 直接読み込み → 水深が正しく地理参照・着色される
- `?url=<project.geolibre>` でプロジェクト読み込み → storymap モード起動、
  チャプター選択でフレームレイヤーが opacity トランジションで切り替わる
- ビュワーURL: `https://web.geolibre.app/?url=https://kasi-x.github.io/flood-nagoya/nagoya_univ/nagoya_univ.geolibre`

### 残課題
- ネイティブ時間スライダー: GeoLibre の time slider はベクタータイル対象で
  ラスター COG の時系列は未対応。storymap チャプターで擬似リプレイ実現済み
- `maplibre-gl-time-slider` プラグインのラスター対応可否は未検証
- deck.gl ビュワーとの役割分担: deck.gl はインタラクティブ 3D 探索、
  GeoLibre は成果共有・公開向け (軽量・URLで即開く)
