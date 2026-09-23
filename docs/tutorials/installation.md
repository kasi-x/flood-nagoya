# セットアップ

## 必要なもの

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) — 環境管理・依存解決
- `unzip` — PLATEAU CityGML の展開用
- `just` — コマンドランナー (`just --list` で全コマンドを確認できます)

## 1. 環境構築

```bash
uv sync          # or: just sync
```

## 2. データ取得とアセット生成

```bash
just dem        # GSI dem5a タイル取得 (約46MB、再実行はキャッシュ利用)
just plateau    # PLATEAU CityGML (2.8GB) 取得 → 建物GML展開 → 建物高さラスタ化
just build      # Webアプリ用アセット生成 (モザイク→欠損処理→タイル化→流路解析)
```

はじめての場合は `just setup` で上記3ステップを一括実行できます。

`just` を使わない場合の生コマンド:

```bash
# GSI dem5a タイル (約46MB)
uv run python -m flood_nagoya download-dem

# PLATEAU CityGML → 建物GMLのみ展開 → ラスタライズ (EPSG:6697 → z15ピクセルグリッド)
mkdir -p data/raw/plateau
curl -o data/raw/plateau/23100_nagoya-shi_city_2022_citygml_4_op.zip \
  "https://assets.cms.plateau.reearth.io/assets/79/e43a02-06b6-40c2-ae97-51eba1b4297b/23100_nagoya-shi_city_2022_citygml_4_op.zip"
unzip -o -q data/raw/plateau/23100_nagoya-shi_city_2022_citygml_4_op.zip \
  "udx/bldg/*" -d data/raw/plateau/extracted/
uv run python -c "from flood_nagoya.plateau_buildings import rasterize_buildings; rasterize_buildings()"

# Webアプリ用アセット生成
uv run python -m flood_nagoya build
```

## 3. 起動

```bash
just serve          # http://127.0.0.1:8642/
# or: uv run python -m flood_nagoya serve
# ポート変更: uv run python -m flood_nagoya serve --port 9000
```

ブラウザで http://127.0.0.1:8642/ を開き、地図上の範囲をドラッグすると
その範囲の高解像度シミュレーションが始まります。

## 観測降雨シナリオ (任意)

実際の大雨を再現するには AMeDAS / XRAIN / MSM のシナリオを生成します:

```bash
just rain 2026-09-08   # AMeDAS実測ハイエトグラフ (任意の過去日)
just xrain 2026-09-16  # XRAINレーダー (空間分布つき・5分毎、直近~8日のみ)
just msm 2026-09-08    # MSM+AMeDAS較正 (空間分布つき・毎時、XRAIN期限切れの日付用)
```

生成したシナリオは Webアプリの「観測降雨」欄に並びます。

## Docker で動かす

ビルド済みアセット (`web/tiles`, `web/overview`, `web/meta.json`) を配信する
軽量ランタイムイメージです。`web/` をあらかじめローカルで生成しておきます
(上記 2 の `just build` まで実行)。

```bash
docker compose up --build     # ./web を bind-mount するので再ビルド不要で即反映
```

詳細は [README](https://github.com/kasi-x/flood-nagoya/blob/main/README.md) の「Docker で実行する」を参照してください。