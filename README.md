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
- **3D表示 (three.js, PLATEAU View風)**: 地形メッシュ + PLATEAU建物のインスタンス描画 + 水面を立体表示。
  国土地理院航空写真 (ort) を地面にドレープし、**建物あり/なし・航空写真ON/OFF**をリアルタイム切替。
  2D/3Dはワンクリックで切替可能 (OrbitControlsで回転・ズーム)
- **可視化**: 水深 / 流速 / 最大浸水深の切替、流路累積 (D8) による河川・水路のオーバーレイ、氾濫面積の統計表示

## セットアップ

Prerequisites: Python 3.11+ と [uv](https://docs.astral.sh/uv/)、`unzip`。

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

## つかいかた

1. **地図**上で範囲をドラッグ → その範囲の高解像度 (3.9m) シミュレーションが開始
2. または「名古屋市全域で実行」で広域モード (15.6m)
3. 降雨シナリオ (ゲリラ豪雨100mm/h、線状降水帯80mm/h×3h、台風50mm/h×6h) を選択
   - 「観測降雨」には `rain-scenario` で生成した **AMeDAS実測ハイエトグラフ** も現れる (下記)
4. スライダーで降雨強度・排水能力・粗度等を調整、表示を水深/流速/最大浸水深で切替
5. Esc または「地図へ戻る」で地図に戻り、別の範囲を選択。Space+ドラッグで地図パン

## 実際の大雨を再現する (観測降雨シナリオ)

気象庁「過去の気象データ検索」の1時間降水量 (AMeDAS) や国交省 XRAIN
レーダー画像から、実際の大雨を再現できます。生成したシナリオは
Webアプリの「観測降雨」欄に降雨の推移 (スパークライン) つきで並びます。

```bash
# 1. AMeDAS実測ハイエトグラフ (域内一様) — 任意の過去日
#    例: 2026-09-08 の名古屋の記録的豪雨 (線状降水帯, 1時間97.5mm・日合計219.5mm)
uv run python -m flood_nagoya rain-scenario --date 2026-09-08

# 2. XRAINレーダー (空間分布つき・5分毎) — 川の防災情報の保持期間 内 (~8日) のみ
uv run python -m flood_nagoya xrain-scenario --date 2026-09-16

# 3. MSMモデル + AMeDAS較正 (空間分布つき・毎時) — XRAIN保持期限切れの日付用
uv run python -m flood_nagoya msm-scenario --date 2026-09-08

uv run python -m flood_nagoya serve   # 「観測降雨」からシナリオを選択
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

- 本エミュレーターは **雨水のみ** を対象とします。河川氾濫 (堤防越流) や高潮は解きません
  (ただし豪雨時に河川沿いへ水が集まる様子は地形から再現されます)
- **下水道網を陽に解いていません**。「排水能力」スライダーは面上の近似です。
  名古屋市の中心市街地は下水道が整備されており、実災害ではここで示すより浅い浸水となることが多いです
- 建物は「雨を透過しない壁」として扱います (屋根雨は下水へ直行と仮定)
- 地形データは航空レーザー測量由来のため、樹冠下の細街路や地下空間は反映されません
- 検証・教育用途のエミュレーターであり、**行政の浸水ハザードマップではありません**

## 構成

```
src/flood_nagoya/
  gsitiles.py          GSIタイル取得・パース
  plateau_buildings.py PLATEAU CityGML → 建物高さラスタ
  hydro.py             平地補間 (priority-flood + ε勾配) + D8流路累積
  pipeline.py          Web用タイル/オーバービュー/meta.json 生成
  amedas.py            JMA過去データ → 観測降雨シナリオ (rain-scenario)
  spatial.py           空間降雨フレーム共通部 (PNGエンコード・ジオ参照)
  xrain.py             国交省XRAIN画像 → 空間分布降雨 (xrain-scenario)
  msm.py               JMA MSM+AMeDAS較正 → 空間分布降雨 (msm-scenario)
  server.py            静的配信 (no-cache)
web/
  sim.js               WebGL2 浅水方程式エンジン
  view3d.js            three.js 3Dビュー (地形/建物/水面)
  app.js               地図・UI
  index.html / style.css
  lib/                 three.js (vendor)
```

### タイルエンコーディング

- 標高タイル: RGBA PNG、標高cm = `R*65536 + G*256 + B`
- 建物タイル: RGB PNG、高さcm = `R*256 + G`

## 🧰 開発

```sh
just lint    # ruff
just test    # pytest
```

## 🔄 テンプレートからの更新

```sh
uvx copier update --trust --defaults
```

## 📄 License

[MIT](LICENSE)
