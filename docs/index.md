# flood-nagoya

名古屋市の実標高 (国土地理院 5m DEM) と PLATEAU 建物データを用いた、
GPU 浅水方程式ベースの雨水流出エミュレーター。

ブラウザ上で、雨が名古屋市の街をどう流れ、どこに溜まるかを
インタラクティブに計算・可視化します。詳細は [README](https://github.com/kasi-x/flood-nagoya/blob/main/README.md) を参照。

## 特徴

- **実データに基づく地形**: 国土地理院 dem5a (約3.9m解像度) + PLATEAU 名古屋市 (2022) 約73.7万棟の建物高さ
- **物理モデル**: LISFLOOD-FP 型の陽解法パイプスキーム (Bates et al. 2010)
  - 降雨強度・継続時間、下水道排水能力、地盤浸透、粗度係数をリアルタイム調整可能
- **GPU計算 (WebGL2)**: 最大約1,150万セルをリアルタイム計算
- **3D表示 (three.js, PLATEAU View風)**: 地形 + 建物 + 水面、航空写真ドレープのON/OFF
- **観測降雨の再現**: AMeDAS実測ハイエトグラフ / XRAINレーダー / MSM+AMeDAS較正 から
  実際の大雨シナリオを生成

## クイックスタート

Prerequisites: Python 3.11+ / [uv](https://docs.astral.sh/uv/) / `unzip` / `just`

```bash
just sync && just setup   # 環境 + 標高/建物データ + アセット生成
just serve                # http://127.0.0.1:8642/
```

詳細は [セットアップ](tutorials/installation.md) と [README](https://github.com/kasi-x/flood-nagoya/blob/main/README.md) を参照。

## API リファレンス

- [Modules](modules.md) — パッケージ各モジュールのドキュメント

## モデルの精度と限界

- 雨水のみ対象 (高潮は解かない)。河川氾濫は1D河道スクリーニングモデルで近似。
  下水道網は陽に解かず「排水能力」は面上近似。
- 検証・教育用途のエミュレーターであり、**行政の浸水ハザードマップではありません**。