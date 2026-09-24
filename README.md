# flood_nagoya — 名古屋市 雨水流出エミュレーター

*名古屋市の実標高 (国土地理院 5m DEM) と PLATEAU 建物データを用いた、GPU浅水方程式ベースの雨水流出エミュレーター*

ブラウザ上で、雨が名古屋市の街をどう流れ、どこに溜まるかをインタラクティブに計算・可視化します。

## 特徴

- **実データに基づく地形**
  - 標高: 国土地理院「地図タイル」dem5a (数値標高モデル5m、平成以降測量) — 約3.9m解像度、名古屋市域約1,130タイル
  - 建物: 国土交通省 **Project PLATEAU** 名古屋市 (2022年度, CityGML) — 約 **73.7万棟** の LOD0 フットプリント + `measuredHeight` を流路障害物 (壁) としてラスタライズ
- **物理モデル**: LISFLOOD-FP型の陽解法パイプスキーム (Bates et al. 2010)
  - 自由水面勾配による流動 + Manning粗度による暗解法摩擦
  - wet/dry判定、流出制限、流速上限により安定
  - 降雨強度・継続時間、下水道排水能力、地盤浸透、粗度係数をすべてリアルタイム調整可能
- **GPU計算 (WebGL2)**: 最大約1,150万セル (≈13×12km @3.9m) をリアルタイム計算。市域全体モード (~15.6m解像度) も選択可能
- **高潮・風浪境界条件 (事前計算)**: `precompute --sea-level 1.5` で海面水位を
  1.5m 引き上げ、沿岸低地への逆押しを近似。名古屋港・熱田など低地での
  複合リスク検討用。境界セルは領域外縁の低標高セルを自動判定 (簡易)。
- **1D河道モデル (河川氾濫)**: D8集水域→合理式流量→Manning水位→
  bankfull超過分を氾濫原へ溢水として注入。集中時間をピークとする
  三角単位hydrographで降雨を畳み込み、放流の遅れと減衰を再現。
  ライブ計算では「河川氾濫」トグル、事前計算では `precompute --river`
- **既往災害再現**: 台風19号(2019-10-12)・令和5年梅雨前線豪雨などの
  AMeDAS名古屋観測雨量をワンコマンドでシナリオ化
- **簡易地下空間内水モデル (事前計算)**: `precompute --underground` で
  名古屋駅・栄・伏見の地下街を単一貯水池として扱い、地表冠水からの
  マンホール流入を近似。地下深さマップ `underground_*.png` を出力
- **3D表示 (three.js, PLATEAU View風)**: 地形メッシュ + PLATEAU建物のインスタンス描画 + 水面を立体表示。
  国土地理院航空写真 (ort) を地面にドレープし、**建物あり/なし・航空写真ON/OFF**をリアルタイム切替。
  2D/3Dはワンクリックで切替可能 (OrbitControlsで回転・ズーム)
- **可視化**: 水深 / 流速 / 最大浸水深の切替、風マップ風の**流線パーティクル**による流れの可視化 (2D/3D)、
  **分水域・流路 (D8集水)** オーバーレイ、氾濫面積の統計表示。UIはPLATEAU View風のライトテーマ
- **事前計算リプレイ**: 栄エリア × 実測降雨 (AMeDAS 2026-09-08) の結果を
  numpy でオフライン計算して保存し、起動してすぐ再生できる (`python -m flood_nagoya precompute`)

## セットアップ

Prerequisites: Python 3.11+ と [uv](https://docs.astral.sh/uv/)、`unzip`、および `just`。

```bash
just sync      # uv sync --locked — 環境構築
just dem       # 1. GSI dem5a タイル取得 (約46MB、再実行はキャッシュ利用)
just plateau   # 2. PLATEAU CityGML (2.8GB) 取得 → 建物GML展開 → 建物高さラスタ化
just build     # 3. Webアプリ用アセット生成 (モザイク→欠損処理→タイル化→流路解析)
just serve     # 4. 起動 → http://127.0.0.1:8642/
```

はじめての場合は `just sync && just setup` で 1–3 まで一括実行できます。
`just` を使わない場合の生コマンドは:

```bash
uv sync

# 1. GSI dem5a タイルを取得 (約46MB。再実行でキャッシュ利用)
uv run python -m flood_nagoya download-dem

# 2. PLATEAU CityGML (2.8GB) を取得して建物GMLのみ展開
mkdir -p data/raw/plateau
curl -o data/raw/plateau/23100_nagoya-shi_city_2022_citygml_4_op.zip \
  "https://assets.cms.plateau.reearth.io/assets/79/e43a02-06b6-40c2-ae97-51eba1b4297b/23100_nagoya-shi_city_2022_citygml_4_op.zip"
unzip -o -q data/raw/plateau/23100_nagoya-shi_city_2022_citygml_4_op.zip \
  "udx/bldg/*" -d data/raw/plateau/extracted/

# 3. 建物ラスタライズ (EPSG:6697 → z15ピクセルグリッド)
uv run python -c "
from flood_nagoya.plateau_buildings import rasterize_buildings
rasterize_buildings()
"

# 4. Webアプリ用アセット生成 (モザイク→欠損処理→タイル化→流路解析)
uv run python -m flood_nagoya build

# 5. 起動
uv run python -m flood_nagoya serve   # http://127.0.0.1:8642/
```

## Docker で実行する

ビルド済みアセット (`web/tiles`, `web/overview`, `web/meta.json`) を配信する
軽量なランタイムイメージです。`data/raw` (約12GB) はコンテキストに含めない
ため、`web/` はあらかじめローカルで生成しておきます (上記セットアップ 1–4)。

```bash
# 方法1: Compose (推奨 — ./web をbind-mountするので、
#        ローカルで build し直すと再ビルド不要で即反映される)
docker compose up --build          # http://localhost:8642/

# 方法2: 直接 docker build / run
docker build --target runtime -t flood-nagoya .
docker run --rm -p 8642:8642 flood-nagoya   # http://localhost:8642/
```

その他のコマンド:

```bash
# ポートやバインド先を変えたいとき
docker run --rm -p 9000:8642 flood-nagoya \
  python -m flood_nagoya serve --host 0.0.0.0 --port 8642

# アセットが無い状態で起動すると、先に build を促すエラーで終了する
docker run --rm flood-nagoya python -m flood_nagoya serve --host 0.0.0.0
```

## つかいかた

起動すると既定で **栄エリアの浸水リプレイ** (2026-09-08 の AMeDAS実測降雨
「最大 97.5 mm/h・合計 219.5 mm」を事前計算した結果) を3D再生します。
タイムラインのドラッグで任意時刻へ即時シーク、流線パーティクルで水の流れ、
色で水深を表現します。

1. 事前計算リプレイが無い環境では、代わりに栄中心のライブ計算で起動
2. **地図**上で範囲をドラッグ → その範囲の高解像度 (3.9m) ライブ計算も可能
3. または「名古屋市全域で実行」で広域モード (15.6m)
4. 表示を水深/流速/最大浸水深で切替、Esc で地図に戻る。Space+ドラッグで地図パン

### 3Dビュワーを切り替える (three.js / deck.gl / CesiumJS)

3D表示中はパネルの「3Dビュワー」で描画エンジンを切り替えられる
(URL では `?3d=three|deck|cesium`):

- **three.js** (既定) — ローカルのDEM・建物ラスタ・航空写真だけで完結する
  軽量描画。流線パーティクルや波の演出はこちらのみ。
- **deck.gl** — PLATEAU の実寸 3D Tiles 建物を Tile3DLayer で表示。
  水面は地形へのドレープ、降雨は GPU パーティクル (「雨を表示」) で可視化。
- **CesiumJS** — 公開PLATEAU-Terrain (Ion不要の quantized-mesh、楕円体高) 上に
  PLATEAU 建物を実寸表示。垂直基準が合うため建物の浮きは原理的に起きない
  (地形の取得失敗時は自前GSI DEMに退避し `?hoff=` で微調整)。

詳しい設計と軽さの比較は [docs/viewers.md](docs/viewers.md) を参照。

## 実際の大雨を再現する (観測降雨シナリオ)

気象庁「過去の気象データ検索」の1時間降水量 (AMeDAS) や国交省 XRAIN
レーダー画像から、実際の大雨を再現できます。生成したシナリオは
Webアプリの「観測降雨」欄に降雨の推移 (スパークライン) つきで並びます。

### 栄エリアの事前計算リプレイを生成する

ライブ計算を待たずにすぐ結果を見るため、リプレイデータを事前生成できます
(numpy によるオフライン計算、10分程度。出力は `web/precomputed/` でgit管理外):

```bash
uv run python -m flood_nagoya precompute   # 既定: AMeDAS 2026-09-08 / 栄 7×5.5km
```

```bash
# 1. AMeDAS実測ハイエトグラフ (域内一様) — 任意の過去日
#    例: 2026-09-08 の名古屋の記録的豪雨 (線状降水帯, 1時間97.5mm・日合計219.5mm)
just rain 2026-09-08        # = uv run python -m flood_nagoya rain-scenario --date 2026-09-08

# 2. XRAINレーダー (空間分布つき・5分毎) — 川の防災情報の保持期間 内 (~8日) のみ
just xrain 2026-09-16       # = uv run python -m flood_nagoya xrain-scenario --date 2026-09-16

# 3. MSMモデル + AMeDAS較正 (空間分布つき・毎時) — XRAIN保持期限切れの日付用
just msm 2026-09-08         # = uv run python -m flood_nagoya msm-scenario --date 2026-09-08

# 4. 既往災害シナリオ (AMeDAS名古屋) — 台風19号・2023年梅雨前線など
just historical hagibis-2019   # 令和元年東日本台風
just historical meiyu-2023     # 令和5年6月末 梅雨前線豪雨
just historical july-2023      # 令和5年7月 梅雨前線通過雨
just historical-all            # 全て生成

just serve                  # 「観測降雨」からシナリオを選択
```

- 時刻は JST。etrn表の「17時」= 16〜17時の雨なので、ハイエトグラフの
  t=16h のレートとして反映されます
- **XRAIN** (国交省 川の防災情報) は表示画像 (階級色付きPNG) を取得して
  階級中央値の雨量強度に復元します。1枚=5分・250m相当。サーバ保持期間は
  約8日で、それより前の日は `RetentionError` になります
- **MSM較正** は気象庁メソモデル (5km・毎時, Open-Meteo archive API) の
  空間パターンを、AMeDAS地点の毎時観測値に合わせて較正したものです
  (レーダー実測ではない点に注意。シナリオJSONの `note` にも記載)
- 計器・設置場所により市公式発表値 (例: 9/8事案の「1時間104.5mm」) と
  AMeDAS値 (97.5mm) は異なります
- 再現時は「下水道排水能力」スライダーにも注意 (既定20mm/h)。弱い雨は
  排水が上回りほぼ冠水しないため、状況に応じて調整してください

## データ出典・ライセンス

| データ | 出典 | 利用規約 |
|---|---|---|
| 標高 (dem5a) | 国土地理院「地図タイル」 | [国土地理院コンテンツ利用規約](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html) |
| 航空写真 (ort) | 国土地理院「地図タイル」(3D表示の地面テクスチャ) | 同上 |
| 建物 | Project PLATEAU 名古屋市 (2022) | [PLATEAU利用規約](https://www.mlit.go.jp/plateau/site-policy/) |

## モデルの精度と限界 (重要)

- 本エミュレーターは **雨水のみ** を対象とします。高潮は解きません。
  河川氾濫は1D河道スクリーニングモデル (集水域→合理式流量→Manning水位→氾濫原への溢水、
  集中時間をピークとする三角単位hydrograph畳み込み付き) で近似しており、
  動的河道ルーティングや河口逆流は解きません
- **下水道網を陽に解いていません**。「排水能力」スライダーは面上の近似です。
  名古屋市の中心市街地は下水道が整備されており、実災害ではここで示すより浅い浸水となることが多いです
- 建物は「雨を透過しない壁」として扱います (屋根雨は下水へ直行と仮定)
- 地形データは航空レーザー測量由来のため、樹冠下の細街路や地下空間は反映されません
- `--sea-level` は外縁低標高セルへの簡易水位強制であり、実際の高潮・河口逆流を
  厳密に解いていません。名古屋港など海岸を含む領域で効果を出すには領域設定が必要です
- `--underground` は名古屋駅・栄・伏見を大局的な貯水池として近似した簡易モデルです。
  個別の地下道・ポンプ・止水板は表現していません
- 検証・教育用途のエミュレーターであり、**行政の浸水ハザードマップではありません**

## 構成

```
src/flood_nagoya/
  __main__.py           CLI (download-dem / build / serve / *-scenario)
  config.py             対象領域・GSIタイルスキーム・パス定数
  gsitiles.py           GSI dem5a タイルの取得・パース        (download-dem)
  plateau_buildings.py  PLATEAU CityGML → 建物高さラスタ
  hydro.py              平地補間 (priority-flood + ε勾配) + D8流路累積
  pipeline.py           Web用タイル/オーバービュー/meta.json 生成 (build)
  amedas.py             JMA過去データ → 観測降雨シナリオ      (rain-scenario)
  spatial.py            空間降雨フレーム共通部 (PNGエンコード・ジオ参照)
  xrain.py              国交省XRAIN画像 → 空間分布降雨        (xrain-scenario)
  msm.py                JMA MSM + AMeDAS較正 → 空間分布降雨   (msm-scenario)
  server.py             静的配信 (no-cache)                   (serve)
web/
  sim.js                WebGL2 浅水方程式エンジン
  view3d.js             three.js 3Dビュー (地形/建物/水面)
  app.js                地図・UI
  index.html / style.css
  lib/                  three.js (vendor)
tests/
  test_cli / test_qa / test_server / test_pipeline_units
  test_spatial / test_amedas / test_xrain / test_msm
docs/                   API リファレンス (mkdocstrings: `just docs`)
```

データ/成果物は `data/` (取得データ、git管理外)、`web/tiles`・`web/overview`・
`web/meta.json`・`web/scenarios/` (`just build` の生成物、git管理外)、
`outputs/` (解析結果) に分かれます。

### タイルエンコーディング

- 標高タイル: RGBA PNG、標高cm = `R*65536 + G*256 + B`
- 建物タイル: RGB PNG、高さcm = `R*256 + G`

## 🧰 開発・コマンド一覧

品質チェック (`check` は全項目を実行。コミット前は `just fix` → `just check`):

```sh
just lint    # ruff (format + lint)
just type-check  # basedpyright / pyrefly / vulture / deptry / typos
just test    # pytest + coverage
just check   # lint + type-check + test
just fix     # ruff auto-fix + format + typos -w (コミット前)
just docs    # APIドキュメント生成 (mkdocstrings)
```

アプリ操作 (`./data` を必要とするもの。詳細は「セットアップ」参照):

| コマンド | 内容 |
|---|---|
| `just sync` | `uv sync --locked` — 環境構築 |
| `just setup` | `dem` + `plateau` + `build` を一括実行 |
| `just dem` | GSI dem5a タイル取得 (download-dem) |
| `just plateau` | PLATEAU CityGML 取得 → 展開 → 建物ラスタ化 |
| `just build` | Webアプリ用アセット生成 |
| `just serve` | 起動 (ポート等は生コマンドで: `uv run python -m flood_nagoya serve --port 9000`) |
| `just tunnel` | Cloudflareクイックトンネルで外部公開 (URLは起動のたびに変わる。cloudflared が必要) |
| `just rain 2026-09-08` | AMeDAS観測降雨シナリオ生成 |
| `just xrain 2026-09-16` | XRAINレーダー降雨シナリオ生成 (直近~8日) |
| `just msm 2026-09-08` | MSM+AMeDAS較正シナリオ生成 |
| `just historical hagibis-2019` | 既往災害AMeDASシナリオ生成 |
| `just historical-all` | 全既往災害AMeDASシナリオ生成 |
| `just precompute-surge 1.5` | 海面水位1.5m上昇の事前計算 |
| `just precompute --underground` | 地下空間内水モデル付き事前計算 |

## 🔄 テンプレートからの更新

```sh
uvx copier update --trust --defaults
```

## 📄 License

[MIT](LICENSE)
