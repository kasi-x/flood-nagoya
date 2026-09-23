# 3Dビュワー比較 (three.js / deck.gl / CesiumJS)

浸水シミュレーションの3D表示を、従来の独自 three.js ビュワーに加え
**deck.gl** と **CesiumJS** の2種を追加実装し、同じシミュレーション状態を
3つの描画経路で表示できるようにした。3D表示中はパネルの「3Dビュワー」
セグメント (または `?3d=three|deck|cesium`) で切り替えられる。

本ページは実装の設計判断と、軽さ (転送量・描画負荷) の調査結果をまとめたもの。

## 「建物が浮く」問題と各ビュワーの解決方針

PLATEAU の 3D Tiles を CesiumJS 等で表示すると、建物が空中に浮いて見える
ことがある。原因と対策は
[Zenn: PLATEAU 3D Tiles を CesiumJS で表示する](https://zenn.dev/investaitech/articles/730bd6f9fa90c0)
の「建物が浮く」問題の項が詳しい。要約すると:

1. **地形が未適用** — 既定の滑らかな楕円体 (EllipsoidTerrainProvider) の上に
   実際の標高位置にある建物を置くため、起伏のある地域で浮いて見える。
   → 実際の地形 (PLATEAU-Terrain / 国土地理院 DEM) を terrain provider に設定する。
2. **地形による隠蔽が無効** — `scene.globe.depthTestAgainstTerrain = true` を
   設定し、地形の裏側を正しく隠す。
3. **微細なずれ** — 地形適用後もわずかに浮き/沈みが残る場合は
   `tileset.modelMatrix` の平行移動 (`applyHeightOffset`) で吸収する。

| ビュワー | 建物のソース | 浮き対策 |
|---|---|---|
| three.js (既定) | ローカルの建物高さラスタからインスタンス箱を生成 | 建物の底面を表示メッシュの地盤高にスナップし、傾斜地ではスカートを伸ばす。データが同じDEM由来のため原理的にずれない |
| deck.gl | PLATEAU 3D Tiles (b3dm, 実寸) | Tile3DLayer が地心直交座標の絶対高さを持つため、地形が同じ国土地理院 DEM 系 (terrarium) なら一致する。浮きの微調整は未実装 (必要なら CesiumJS と同様の modelMatrix 相当の変換を追加できる)。簡易建物 (`bldg=simple`) は footprint 最低地盤高を底面にして斜面で浮かないようにした |
| CesiumJS | PLATEAU 3D Tiles (b3dm, 実寸) | 上記 1–3 をそのまま実装。既定の地形は GSI dem5a_png から作った自前 terrain provider (欠測は周辺平均で補間)。`?ionToken=` で Cesium Ion トークンを与えると記事と同じ PLATEAU-Terrain (Ion asset 3258112) に切替。`?hoff=` で高さオフセット (m) を調整できる |

## アーキテクチャ

3ビュワーとも `setRegion()` / `updateWater()` / `setBuildingsVisible()` など
共通のインターフェース (`web/app.js` から利用) を持ち、シミュレーション状態
(Float32Array の水深グリッド) の受け渡しは同一である。

- **three.js** (`web/view3d.js`): ローカルのDEM・建物ラスタ・航空写真から
  シーンを構築。GPUシミュレーションの状態を数フレームごとにCPUへ読み戻し、
  頂点シェーダで水面を変形させる。流線パーティクル・波のアニメ等の演出は
  このビュワーのみ。
- **deck.gl** (`web/view3d_deck.js`): 地形は `TerrainLayer` が AWS Terrain
  Tiles (terrarium) を、質感は GSI 航空写真タイルをストリーミング。
  建物は `Tile3DLayer` で PLATEAU 名古屋市 (中区など対象区) の 3D Tiles を
  公式データカタログ API
  (`https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets`) から
  引いて表示する。水面はシミュレーション状態を水深色キャンバスに描き、
  `BitmapLayer` + `_TerrainExtension` で地形表面にドレープする
  (「deck.glで水を可視化する」実証)。雨は GPU パーティクルで描く
  (下記「雨のGPU描写」)。カタログ取得に失敗した場合は
  内蔵の tileset URL 表 (`web/geo.js`) にフォールバックする。
  気象レイヤーとして RainViewer 降水レーダー (`weatherToggle`) を
  `TileLayer` + `BitmapLayer` で地形に重ねられる (無料・APIキー不要)。
  分水域・流路オーバーレイ (`streamsSimToggle`) も `BitmapLayer` で
  シミュレーション領域にドレープする。
- **CesiumJS** (`web/view3d_cesium.js`): Web上で実寸都市モデルを表示する
  定番構成。地形は GSI dem5a_png を HeightmapTerrainData に変換する自前
  provider (`?ionToken=` で PLATEAU-Terrain に差し替え)、建物は
  `Cesium3DTileset`、水面は水深キャンバスを `SingleTileImageryProvider`
  で範囲矩形にドレープする。deck.gl 版と同じく地形の裏側の隠蔽
  (`depthTestAgainstTerrain`) と `applyHeightOffset` を実装済み。

CesiumJS は配布サイズが大きいためローカルには置かず公式CDNから、
deck.gl は 2MB の UMD バンドルを `web/lib/deck.gl.min.js` に同梱して
オフラインでも起動するようにした (MIT License)。

## 軽さの調査

同じ地域 (栄 7×5.5km、中区の PLATEAU 建物) を3ビュワーで表示したときの
計測値。計測は画面右上の「パフォーマンス表示」HUD、または
`window.__bench(秒)` / `?bench=秒` (カメラを動かしてFPSをサンプリング) で
行える。

| 項目 | three.js | deck.gl | CesiumJS |
|---|---|---|---|
| ネットワーク (建物) | **0** (ローカルラスタ) | LOD2 約138MB / LOD1 約86MB (中区) | LOD2 約57MB (tileset合計、必要部分のみストリーミング) |
| ネットワーク (地形・写真) | 0 | 地形+写真タイルをストリーミング | 同左 |
| 描画 (ドローコール) | 4 | レイヤー3種+タイルごと | タイルごと (表示中 17 コマンド) |
| 三角形数 | 約311万 (建物インスタンス含む) | 地形メッシュ+建物タイル | LOD制御により視点依存 |
| 起動までの準備 | タイル合成のみ (速い) | Cesium/PLATEAUタイルの到着次第 | 同左 |

ソフトウェアレンダリング (SwiftShader) 環境でのカメラ移動ベンチ
(12秒、`?bench=12`) では three.js 0.3fps / deck.gl 1.8fps / CesiumJS 2.8fps
であったが、これは three.js の約311万三角形がソフトウェア描画で破綻する
ことを示す値で、**実GPU環境では three.js が最も軽く60fpsで動作する**
(2Dシミュレーションと同一プロセスで動かす前提の設計のため)。
逆に GPU が弱く回線が速い環境では、画面内の必要部分だけを描く
deck.gl / CesiumJS のストリーミング方式が有利になる。

### 使い分けの指針

- **既定 (three.js)**: ライブ計算との併用・演出 (流線/波)・オフライン。
  ローカルデータだけで完結し、GPU があれば最軽量。
- **deck.gl**: 実寸 PLATEAU 建物を軽量フレームワークで表示したい場合。
  水の可視化は地形ドレープ (キャンバス 1 枚) で実装でき、カスタム
  レイヤーによる発展 (水深ごとのシェーダ表現) もしやすい。
- **CesiumJS**: 地形への正確な沈み込みが要る場合。PLATEAU-Terrain
  (Ion) や 3D Tiles の成熟したストリーミング、地形による隠蔽が標準で
  用意されている。その代わりランタイムが最も重い。

## 雨のGPU描写 (deck.gl)

deck.glビュワーでは降雨そのものを GPU で描画できる
(3Dオプションの「雨を表示」/ `?rain=1`)。

- **構造**: 雨筋 (16〜40m の斜め線分) を6,000本ぶんの頂点バッファとして
  初期化時に一度だけ作り、`LineLayer` を垂直周期 220m ずらして2枚重ねる。
- **アニメーション**: 毎フレームのCPU処理は `modelMatrix` の平行移動量
  (雨幕を下げて周期ラップ) と `opacity` の2つの uniform 差し替えだけ。
  頂点バッファもデータ配列も更新しないため、CPUコストは実質ゼロで
  描画は2ドローコールに収まる。
- **降雨との連動**: シミュレーションの現在の雨強度 (mm/h) を
  `setRainIntensity()` で受けて不透明度を変える。0.5mm/h 未満で自動的に
  消え、降り始め/止み間のフェードも表現する。
- **コスト計測**: `?bench=` での雨ON/OFF比較では差は誤差範囲
  (タイルストリーミングの揺らぎより小さい)。ソフトウェアレンダリング
  環境でも median フレーム時間は同程度で、GPU負荷の増分は
  インスタンス2描画ぶんのみ。

## URLパラメータ

| パラメータ | 意味 |
|---|---|
| `?3d=three\|deck\|cesium` | 3Dビュワーの初期選択 |
| `?region=<index\|名前>` | 標準リージョンを3Dで開く (例: `?region=1`) |
| `?lod=1\|2` | PLATEAU建物のLOD (deck.gl / CesiumJS)。LOD1は軽い |
| `?hoff=<m>` | CesiumJS の建物タイルの高さオフセット (浮きの微調整) |
| `?ionToken=<token>` | Cesium Ion トークン (PLATEAU-Terrain asset 3258112 を使う) |
| `?perf` | 2D表示中もパフォーマンスHUDを出す |
| `?rain=1` | deck.glビュワーで雨のGPUパーティクルを既定ONにする |
| `?weather=1` | deck.glビュワーで降水レーダー (RainViewer) を既定ONにする |
| `?exag=<倍率>` | three.js ビュワーの垂直誇張 |
