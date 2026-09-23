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
- 軽量プリセット中に建物を出したい場合の既定は `bldg=simple` 推奨
  （現状プリセットは建物OFFのまま）

### 参考URLパラメータ例
```
?3d=deck&region=1&lod=1&photo=0&bldg=0&terrain=low
?lite=1
?3d=deck&bldg=simple
```
