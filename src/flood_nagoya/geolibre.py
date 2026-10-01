"""Export precomputed flood replays to GeoLibre-compatible assets.

GeoLibre (https://geolibre.app, MapLibre GL JS + deck.gl based GIS platform)
can load Cloud-Optimized GeoTIFFs (COG) and ``.geolibre`` project JSON over
plain HTTP.  This module converts a ``web/precomputed/<region>/`` replay
directory into:

- one COG per selected frame (water depth in metres, EPSG:3857)
- one COG for the cumulative maximum depth
- a raster ``*.style.json`` per COG (blue colormap, rescale 0..vmax)
- a ``<region>.geolibre`` project JSON that references the hosted COGs

The project file targets hosting on a static URL (e.g. a Hugging Face
dataset repo).  View it with::

    https://web.geolibre.app/?url=<base_url>/<region>.geolibre

Requires the ``experiment`` extra (rasterio + pillow).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

import numpy as np

from .config import WEB_DIR
from .precompute import EARTH_M
from .precompute import TILE_PX
from .precompute import Z15

# depth legend: 0(透明) → 5cm → 30cm → 1m → 2m → 3m+
# GeoLibre の raster style rescale は実値 [m]。colormap "blues" を使用。
_DEPTH_VMAX_M = 3.0

# 既定では meta.interval 秒ごとに 1 フレーム選ぶ (時間間隔に正規化)
DEFAULT_FRAME_EVERY_S = 3600.0


class RegionMetaRequired(TypedDict):
    """Keys a ``precomputed/<region>/meta.json`` always carries."""

    interval: float
    times: list[float]
    grid: dict[str, int]
    bounds_px: dict[str, int]


class RegionMeta(RegionMetaRequired, total=False):
    """Full meta.json schema as used by the exporter."""

    name: str
    label: str
    desc: str
    source: str
    scenario: str
    stats: list[dict[str, float]]


@dataclass(frozen=True)
class RegionBounds3857:
    """Web-Mercator (EPSG:3857) bounds of a replay region."""

    xmin: float
    ymin: float
    xmax: float
    ymax: float
    west: float
    south: float
    east: float
    north: float


def _tile_range() -> tuple[int, int]:
    """Global z15 tile indices of the study-area tile grid origin."""
    meta: dict[str, dict[str, int]] = json.loads((WEB_DIR / "meta.json").read_text())
    return int(meta["tile_range"]["x0"]), int(meta["tile_range"]["y0"])


def z15px_to_3857(gx: float, gy: float) -> tuple[float, float]:
    """Global z15 pixel coordinate → EPSG:3857 metres."""
    res = EARTH_M / (2**Z15 * TILE_PX)
    return gx * res - EARTH_M / 2, EARTH_M / 2 - gy * res


def _z15px_to_lonlat(gx: float, gy: float) -> tuple[float, float]:
    lon = gx / (2**Z15 * TILE_PX) * 360.0 - 180.0
    n = np.pi - 2 * np.pi * gy / (2**Z15 * TILE_PX)
    lat = float(np.degrees(np.arctan(np.sinh(n))))
    return lon, lat


def region_bounds(meta: RegionMeta) -> RegionBounds3857:
    """EPSG:3857 + WGS84 bounds of a replay region.

    ``meta.bounds_px`` is measured in full-resolution z15 pixels; the
    frame grid (``meta.grid``) is exactly half that resolution.
    """
    x0, y0 = _tile_range()
    b = meta["bounds_px"]
    gx0, gy0 = x0 * TILE_PX + b["left"], y0 * TILE_PX + b["top"]
    gx1, gy1 = gx0 + b["w"], gy0 + b["h"]
    xmin, ymax = z15px_to_3857(gx0, gy0)
    xmax, ymin = z15px_to_3857(gx1, gy1)
    west, north = _z15px_to_lonlat(gx0, gy0)
    east, south = _z15px_to_lonlat(gx1, gy1)
    return RegionBounds3857(xmin, ymin, xmax, ymax, west, south, east, north)


def frame_depth_m(png_path: Path) -> np.ndarray:
    """Decode a precomputed frame PNG to depth in metres (row 0 = north).

    Encoding (see ``decodeFrame`` in web/app.js): R channel = depth in cm.
    """
    from PIL import Image  # noqa: PLC0415 - pillow is a hard dependency

    with Image.open(png_path) as img:
        arr = np.asarray(img.convert("RGBA"))
    return arr[:, :, 0].astype(np.float32) / 100.0


def max_depth_m(region_dir: Path) -> np.ndarray:
    """Cumulative maximum depth from ``max_*.png`` (gray channel = cm)."""
    frames = sorted(region_dir.glob("max_*.png"))
    if not frames:
        msg = f"{region_dir} に max_*.png がありません"
        raise FileNotFoundError(msg)
    acc = frame_depth_m(frames[0])
    for f in frames[1:]:
        acc = np.maximum(acc, frame_depth_m(f))
    return acc


def _write_cog(depth_m: np.ndarray, bounds: RegionBounds3857, out: Path) -> None:
    """Write a single-band float32 COG (EPSG:3857, nodata=0 → transparent)."""
    import rasterio  # noqa: PLC0415 - experiment extra
    from rasterio.transform import from_bounds  # noqa: PLC0415

    h, w = depth_m.shape
    transform = from_bounds(bounds.xmin, bounds.ymin, bounds.xmax, bounds.ymax, w, h)
    with rasterio.open(
        out,
        "w",
        driver="COG",
        dtype="float32",
        width=w,
        height=h,
        count=1,
        crs="EPSG:3857",
        transform=transform,
        nodata=0.0,
        compress="deflate",
        blocksize=256,
    ) as dst:
        dst.write(depth_m, 1)


def _style_json(vmax_m: float = _DEPTH_VMAX_M) -> dict[str, object]:
    """GeoLibre raster style: depth in metres → blues colormap."""
    return {
        "mode": "single",
        "bands": [1],
        "rescale": [[0.0, vmax_m]],
        "colormap": "blues",
        "reversed": False,
        "nodata": 0.0,
        "opacity": 0.85,
        "gamma": 1.0,
        "stretch": "linear",
    }


def _layer_template() -> dict[str, object]:
    """Style keys emitted by GeoLibre for a cog layer (schema 0.1.0)."""
    return {
        "minZoom": 0,
        "maxZoom": 24,
        "fillColor": "#3b82f6",
        "strokeColor": "#1e40af",
        "strokeWidth": 2,
        "fillOpacity": 0.6,
        "circleRadius": 6,
        "textColor": "#111827",
        "textHaloColor": "#ffffff",
        "textHaloWidth": 2,
        "textSize": 16,
        "extrusionEnabled": False,
        "extrusionColor": "#3b82f6",
        "extrusionOpacity": 0.8,
        "extrusionHeightProperty": "height",
        "extrusionHeightScale": 1,
        "extrusionBase": 0,
        "extrusionAdvancedStyleEnabled": False,
        "extrusionColorExpression": "",
        "extrusionHeightExpression": "",
        "vectorStyleMode": "single",
        "vectorStyleProperty": "",
        "vectorStyleClassCount": 5,
        "vectorStyleColorRamp": "viridis",
        "vectorStyleClassificationScheme": "equal-interval",
        "vectorStyleStops": [{"value": 0, "color": "#dbeafe"}, {"value": 1, "color": "#2563eb"}],
        "vectorStyleExpression": "",
        "pointRenderer": "single",
        "heatmapRadius": 30,
        "heatmapIntensity": 1,
        "heatmapColorRamp": "turbo",
        "heatmapWeightProperty": "",
        "clusterRadius": 50,
        "clusterMaxZoom": 14,
        "rasterBrightnessMin": 0,
        "rasterBrightnessMax": 1,
        "rasterSaturation": 0,
        "rasterContrast": 0,
        "rasterHueRotate": 0,
        "blendMode": "normal",
    }


def _cog_layer(layer_id: str, name: str, cog_url: str, *, visible: bool) -> dict[str, object]:
    """A cog layer entry matching the GeoLibre 0.1.0 schema."""
    return {
        "id": layer_id,
        "name": name,
        "type": "cog",
        "visible": visible,
        "opacity": 1,
        "style": _layer_template(),
        "metadata": {
            "customLayerType": "raster",
            "externalDeckLayer": True,
            "externalNativeLayer": True,
            "identifiable": False,
            "nativeLayerIds": [layer_id],
            "panelCollapsed": True,
            "rasterOverlayMode": "interleaved",
            "rasterSource": "url",
            "rasterState": {"colormap": "blues"},
            "sourceIds": [],
            "sourceKind": "maplibre-gl-raster",
        },
        "source": {"type": "raster", "url": cog_url},
        "sourcePath": cog_url,
    }


def _pick_frames(meta: RegionMeta, every_s: float) -> list[int]:
    """Frame indices: every ``every_s`` model-seconds + the peak-wetness frame."""
    times = meta["times"]
    stats = meta.get("stats") or []
    picked = set(range(0, len(times), max(1, round(every_s / meta["interval"]))))
    if stats:
        peak = max(range(len(stats)), key=lambda i: stats[i].get("a5", 0))
        picked.add(peak)
    picked.add(len(times) - 1)
    return sorted(picked)


def _hhmm(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int(seconds % 3600 // 60)
    return f"+{h}:{m:02d}"


def export_region(
    region_dir: Path,
    out_dir: Path,
    base_url: str,
    *,
    every_s: float = DEFAULT_FRAME_EVERY_S,
    region_name: str | None = None,
) -> dict[str, object]:
    """Build COGs + .style.json + .geolibre project for one replay region.

    ``base_url`` is the public URL prefix where ``out_dir`` will be hosted
    (e.g. a Hugging Face dataset ``resolve/main/<region>`` path).

    Returns a manifest dict listing written files and the viewer URL.
    """
    try:
        import rasterio  # noqa: F401, PLC0415 - presence check only
    except ImportError as e:
        msg = "rasterio が必要です: uv sync --extra experiment"
        raise SystemExit(msg) from e

    region_dir = Path(region_dir)
    name = region_name or region_dir.name
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    meta: RegionMeta = json.loads((region_dir / "meta.json").read_text())
    bounds = region_bounds(meta)
    base = base_url.rstrip("/")

    written: list[str] = []

    # cumulative maximum depth (常に表示する基底レイヤー)
    max_cog = out_dir / "depth_max.tif"
    _write_cog(max_depth_m(region_dir), bounds, max_cog)
    written.append(max_cog.name)

    style_path = out_dir / "depth.style.json"
    style_path.write_text(json.dumps(_style_json()))
    written.append(style_path.name)

    # keyframes
    layers: list[dict[str, object]] = []
    chapters: list[dict[str, object]] = []
    picks = _pick_frames(meta, every_s)
    prev_id: str | None = None
    for i, idx in enumerate(picks):
        t = meta["times"][idx]
        stem = f"frame_{idx:04d}"
        cog = out_dir / f"{stem}.tif"
        _write_cog(frame_depth_m(region_dir / f"{stem}.png"), bounds, cog)
        written.append(cog.name)
        lid = f"flood-{name}-{stem}"
        layers.append(_cog_layer(lid, f"浸水深 {_hhmm(t)}", f"{base}/{stem}.tif", visible=False))
        enter = [{"layerId": lid, "opacity": 0.9, "duration": 800}]
        if prev_id:
            enter.append({"layerId": prev_id, "opacity": 0, "duration": 800})
        chapters.append(
            {
                "id": f"ch{i}",
                "title": f"{meta.get('label', name)} {_hhmm(t)}",
                "description": f"モデル時刻 {_hhmm(t)} の浸水深 (m)",
                "alignment": "left",
                "hidden": False,
                "location": {
                    "center": [
                        round((bounds.west + bounds.east) / 2, 5),
                        round((bounds.south + bounds.north) / 2, 5),
                    ],
                    "zoom": 13.5,
                    "pitch": 45,
                    "bearing": 0,
                },
                "mapAnimation": "flyTo",
                "onChapterEnter": enter,
                "onChapterExit": [{"layerId": lid, "opacity": 0}],
            }
        )
        prev_id = lid

    # 最大浸水深レイヤーは常時表示させるため、追加して不透明度を下げる
    max_lid = f"flood-{name}-max"
    layers.append(_cog_layer(max_lid, "最大浸水深", f"{base}/depth_max.tif", visible=True))
    layers[-1]["opacity"] = 0.6

    project = {
        "version": "0.1.0",
        "name": f"名古屋 浸水リプレイ — {meta.get('label', name)} ({meta.get('name', '')})",
        "mapView": {
            "center": [
                round((bounds.west + bounds.east) / 2, 5),
                round((bounds.south + bounds.north) / 2, 5),
            ],
            "zoom": 13,
            "bearing": 0,
            "pitch": 0,
            "bbox": [
                round(bounds.west, 5),
                round(bounds.south, 5),
                round(bounds.east, 5),
                round(bounds.north, 5),
            ],
        },
        "basemapStyleUrl": "https://tiles.openfreemap.org/styles/liberty",
        "basemapVisible": True,
        "basemapOpacity": 1,
        "layers": layers,
        "metadata": {
            "generator": "flood-nagoya geolibre-export",
            "source": meta.get("source", ""),
            "scenario": meta.get("scenario", ""),
            "frameStyle": f"{base}/depth.style.json",
            "note": "storymap チャプターで時間経過を再生。レイヤーON/OFFでも個別表示可。",
        },
        "storymap": {
            "title": f"{meta.get('label', name)} 浸水リプレイ",
            "subtitle": meta.get("desc", ""),
            "byline": "flood-nagoya GPU浅水シミュレーション",
            "theme": "dark",
            "chapters": chapters,
        },
    }
    proj_path = out_dir / f"{name}.geolibre"
    proj_path.write_text(json.dumps(project, ensure_ascii=False, indent=1))
    written.append(proj_path.name)

    viewer_url = f"https://web.geolibre.app/?url={base}/{name}.geolibre"
    manifest: dict[str, object] = {
        "region": name,
        "label": meta.get("label"),
        "files": written,
        "nFrames": len(picks),
        "bounds4326": [bounds.west, bounds.south, bounds.east, bounds.north],
        "project": f"{base}/{name}.geolibre",
        "viewerUrl": viewer_url,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    written.append("manifest.json")
    return manifest


def main(argv: list[str] | None = None) -> dict[str, object]:
    """CLI entry: export one precomputed region directory."""
    import argparse  # noqa: PLC0415 - CLI-local

    p = argparse.ArgumentParser(prog="flood-nagoya geolibre-export")
    p.add_argument("--region", type=Path, required=True, help="precomputedリージョンディレクトリ (meta.json を含む)")
    p.add_argument(
        "--base-url",
        required=True,
        help="COG等をホストする公開URLプレフィックス (例: https://huggingface.co/datasets/USER/DATASET/resolve/main/REGION)",
    )
    p.add_argument("--out", type=Path, default=None, help="出力先 (既定: outputs/geolibre/<region名>)")
    p.add_argument("--every", type=float, default=DEFAULT_FRAME_EVERY_S, help="キーフレーム間隔 [秒] (既定: 3600)")
    args = p.parse_args(argv)
    out = args.out or Path("outputs/geolibre") / args.region.name
    manifest = export_region(args.region, out, args.base_url, every_s=args.every)
    print(json.dumps(manifest, ensure_ascii=False, indent=1))
    return manifest


if __name__ == "__main__":
    main()
