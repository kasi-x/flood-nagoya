# Modules

## 概要

パッケージは 3 つの役割に分かれます:

1. **データ取得・解析** — `config` / `gsitiles` / `plateau_buildings` / `hydro`
2. **Webアセット生成・配信** — `pipeline` / `server` / `precompute`
3. **観測降雨シナリオ生成** — `amedas` / `spatial` / `xrain` / `msm`

## 定数・パス

::: flood_nagoya.config

## データ取得・解析

::: flood_nagoya.gsitiles

::: flood_nagoya.plateau_buildings

::: flood_nagoya.hydro

## Webアセット生成・配信

::: flood_nagoya.pipeline

::: flood_nagoya.precompute

::: flood_nagoya.server

## 観測降雨シナリオ生成

::: flood_nagoya.amedas

::: flood_nagoya.spatial

::: flood_nagoya.xrain

::: flood_nagoya.msm

## Webフロントエンド (web/)

Pythonパッケージではないが、Webアプリ本体は `web/` の素の ES modules で
構成される。3D表示は3種のビュワーが同じインターフェース
(`setRegion` / `updateWater` など) を実装し、`app.js` から切り替えて使う。
設計と比較は [3Dビュワー比較](viewers.md) を参照。

- `app.js` — 地図・範囲選択・UI配線・シミュレーションループ。3Dビュワー
  (three.js / deck.gl / CesiumJS) の生成と切替もここ。
- `sim.js` — GPU (WebGL2) 浅水方程式ソルバー。
- `view3d.js` — three.js ビュワー (既定)。ローカルDEM・建物ラスタ・航空写真
  から地形/水面/建物インスタンスを構築し、流線パーティクルも描く。
- `view3d_deck.js` — deck.gl ビュワー。TerrainLayer (terrarium地形 + GSI
  航空写真) / Tile3DLayer (PLATEAU 3D Tiles) / 水深キャンバスの地形ドレープ
  (BitmapLayer + _TerrainExtension)。
- `view3d_cesium.js` — CesiumJS ビュワー。GSI dem5a_png から作る自前
  terrain provider、PLATEAU 3D Tiles、水深画像レイヤー。
  「建物が浮く」問題の対策 (depthTestAgainstTerrain / applyHeightOffset)
  を含む。
- `geo.js` — ビュワー共通の地理ユーティリティ。Web Mercator 変換、
  regionInfo→経緯度bbox、PLATEAU名古屋市の区ごと tileset URL
  (カタログAPI + 内蔵フォールバック)、水深→キャンバス描画。
- `perf.js` — パフォーマンスHUD (fps・タイル数・ヒープ) と
  `?bench=` / `window.__bench()` ベンチモード。
- `lib/` — 同梱ライブラリ (three.js、deck.gl UMD)。