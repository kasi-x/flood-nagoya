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
  → 2026-09-24 対応: セル毎の `lag_s` をピークとする三角単位 hydrograph
  (底辺 2·lag、3タップ重み {0.25,0.5,0.25}) でハイエトグラフを畳み込み、
  放流が遅れかつ減衰するようにした。Python側は
  `river_excess_depth(field, series=…, t=…)`、GPU側はハイエトグラフを
  1Dテクスチャ (`uRainSeries`, 60sビン) + ラグテクスチャ (`uRiverLag`)
  としてシェーダ内で3タップ補間サンプル。空間分布レインテクスチャ使用時は
  履歴を持たないため現行レートのまま (近似)。降雨停止後もラグ分だけ
  河道放流が続く。
- 河道ネットワークの動的ルーティングは未実装 (静的フィールドのみ)
- 検証: 名古屋大学周辺で河道セル648個を検出、100mm/h降雨で2.2mの溢水を確認
