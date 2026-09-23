"""Tests for the PLATEAU CityGML building rasterizer."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from flood_nagoya import plateau_buildings as pb

GML_HEADER = """<?xml version="1.0" encoding="UTF-8"?>
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0"
  xmlns:bldg="http://www.opengis.net/citygml/building/2.0"
  xmlns:gml="http://www.opengis.net/gml">
"""

GML_FOOTER = "</core:CityModel>"


def _building(height: str | None, poslists: list[str]) -> str:
    """One bldg:Building element; poslists are raw posList text bodies."""
    height_xml = f"<bldg:measuredHeight>{height}</bldg:measuredHeight>" if height else ""
    fps = "".join(
        f"<bldg:lod0FootPrint><gml:MultiSurface><gml:surfaceMember>"
        f"<gml:Polygon><gml:exterior><gml:LinearRing>"
        f"<gml:posList>{body}</gml:posList>"
        f"</gml:LinearRing></gml:exterior></gml:Polygon>"
        f"</gml:surfaceMember></gml:MultiSurface></bldg:lod0FootPrint>"
        for body in poslists
    )
    return f"<core:cityObjectMember><bldg:Building>{height_xml}{fps}</bldg:Building></core:cityObjectMember>"


def _write_gml(path: Path, buildings: list[str]) -> Path:
    path.write_text(GML_HEADER + "".join(buildings) + GML_FOOTER, encoding="utf-8")
    return path


# 名古屋市中心部の小さな矩形 (EPSG:6697 は lat,lon 順)
SQUARE_2D = "35.1700 136.9000 35.1700 136.9010 35.1710 136.9010 35.1710 136.9000 35.1700 136.9000"
SQUARE_3D = (
    "35.1700 136.9000 50.0 35.1700 136.9010 50.0 35.1710 136.9010 50.0 35.1710 136.9000 50.0 35.1700 136.9000 50.0"
)


def test_iter_buildings_2d_footprint(tmp_path: Path) -> None:
    gml = _write_gml(tmp_path / "a.gml", [_building("12.5", [SQUARE_2D])])
    out = list(pb._iter_buildings(gml))
    assert len(out) == 1
    polys, height_m = out[0]
    assert height_m == 12.5
    assert polys[0].shape == (5, 2)
    # EPSG:6697 axis order: lat first, lon second
    assert polys[0][0, 0] == pytest.approx(35.17)
    assert polys[0][0, 1] == pytest.approx(136.9)


def test_iter_buildings_3d_poslist_detected(tmp_path: Path) -> None:
    gml = _write_gml(tmp_path / "a.gml", [_building("8.0", [SQUARE_3D])])
    polys, height_m = next(iter(pb._iter_buildings(gml)))
    assert height_m == 8.0
    # 3D posList → stride 3, elevation column dropped
    assert polys[0].shape == (5, 2)
    assert polys[0][:, 0].max() == pytest.approx(35.171)


def test_iter_buildings_skips_missing_or_bad_height(tmp_path: Path) -> None:
    gml = _write_gml(
        tmp_path / "a.gml",
        [_building(None, [SQUARE_2D]), _building("abc", [SQUARE_2D]), _building("7.0", [SQUARE_2D])],
    )
    out = list(pb._iter_buildings(gml))
    assert len(out) == 1
    assert out[0][1] == 7.0


def test_iter_buildings_skips_tiny_poslist(tmp_path: Path) -> None:
    gml = _write_gml(tmp_path / "a.gml", [_building("5.0", ["35.17 136.9"])])
    assert list(pb._iter_buildings(gml)) == []


def test_looks_3d_heuristic() -> None:
    # 3D posList: every 3rd value is a plausible elevation (m)
    assert pb._looks_3d(np.array([35.0, 136.9, 40.0, 35.1, 136.9, 40.0, 35.1, 137.0, 40.0]))
    # every-3rd value out of the plausible elevation range → treated as 2D
    assert not pb._looks_3d(np.array([35.0, 136.9, 99999.0, 35.1, 136.9, 40.0, 35.1, 137.0, 40.0]))
    assert not pb._looks_3d(np.array([35.0, 136.9, -200.0, 35.1, 136.9, 40.0, 35.1, 137.0, 40.0]))


def test_rasterize_buildings_no_gml_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pb, "PLATEAU_EXTRACT_DIR", tmp_path)
    (tmp_path / "udx" / "bldg").mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="no bldg GML"):
        pb.rasterize_buildings(tmp_path / "out.npz")


def test_rasterize_buildings_paints_height(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bldg_dir = tmp_path / "udx" / "bldg"
    bldg_dir.mkdir(parents=True)
    _write_gml(bldg_dir / "533946.gml", [_building("10.0", [SQUARE_2D])])
    monkeypatch.setattr(pb, "PLATEAU_EXTRACT_DIR", tmp_path)
    # one z15 tile covering the building
    monkeypatch.setattr(pb, "bbox_tile_range", lambda: (28844, 28844, 12960, 12960))

    out = pb.rasterize_buildings(tmp_path / "out.npz")
    data = np.load(out)
    heights = data["heights"]
    assert heights.shape == (256, 256)
    assert int(data["x0"]) == 28844 and int(data["y0"]) == 12960
    assert heights.max() == 1000  # 10.0 m → 1000 cm
    assert (heights > 0).sum() > 0


def test_rasterize_buildings_clips_absurd_height(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bldg_dir = tmp_path / "udx" / "bldg"
    bldg_dir.mkdir(parents=True)
    _write_gml(bldg_dir / "533946.gml", [_building("999.0", [SQUARE_2D])])
    monkeypatch.setattr(pb, "PLATEAU_EXTRACT_DIR", tmp_path)
    monkeypatch.setattr(pb, "bbox_tile_range", lambda: (28844, 28844, 12960, 12960))

    out = pb.rasterize_buildings(tmp_path / "out.npz")
    heights = np.load(out)["heights"]
    # 999 m → 99900 cm exceeds the int16-safe cap; must clip, not wrap negative
    assert heights.max() == 32000
    assert heights.min() >= 0
