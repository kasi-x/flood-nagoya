"""Hydrological analysis on the overview grid: fill sinks, D8, accumulation.

These routines only feed the static "流れ筋 (drainage network)" overlay and
preset statistics. The interactive simulation runs on the GPU and needs no
pre-filled DEM (sinks are allowed to hold water, as in reality).
"""

from __future__ import annotations

import heapq

import numpy as np
import numpy.typing as npt

D8_OFFSETS = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]


def fill_sinks_priority_flood(dem: npt.NDArray[np.floating], epsilon: float = 0.001) -> npt.NDArray[np.float64]:
    """Wang & Liu (2006) priority-flood with epsilon gradients (Barnes 2014).

    Depressions are raised to their spill elevation plus ``epsilon`` so that
    every cell has a strict downslope neighbour — D8 routing then works across
    flat urban plains, not just in the hills. Voids (NaN) are seeded at the
    lowest priority so the flood spills into the sea.
    """
    h = int(dem.shape[0])
    w = int(dem.shape[1])
    filled = np.array(dem, dtype=np.float64)
    closed = np.zeros((h, w), dtype=np.bool_)
    heap: list[tuple[float, int, int]] = []

    for x in range(w):
        for y in (0, h - 1):
            _seed(filled, closed, heap, y, x)
    for y in range(h):
        for x in (0, w - 1):
            _seed(filled, closed, heap, y, x)

    while heap:
        z, y, x = heapq.heappop(heap)
        for dx, dy in D8_OFFSETS:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h) or closed[ny, nx]:
                continue
            closed[ny, nx] = True
            zn = float(filled[ny, nx])
            if np.isnan(zn) or zn <= z:
                zn = z + epsilon
                filled[ny, nx] = zn
            heapq.heappush(heap, (zn, ny, nx))
    return filled


def _seed(
    filled: npt.NDArray[np.float64],
    closed: npt.NDArray[np.bool_],
    heap: list[tuple[float, int, int]],
    y: int,
    x: int,
) -> None:
    if closed[y, x]:
        return
    closed[y, x] = True
    z = filled[y, x]
    heapq.heappush(heap, (0.0 if np.isnan(z) else float(z), y, x))


def d8_flow_directions(filled: npt.NDArray[np.floating], cell_size: float) -> npt.NDArray[np.int16]:
    """Steepest-descent D8 direction index (0-7) per cell, -1 at sinks/edges.

    Offsets are encoded as bit flags 1,2,4,8,16,32,64,128 (ESRI style) in the
    return value; sinks get 0.
    """
    h, w = filled.shape
    zpad = np.pad(filled, 1, mode="edge")
    best_slope = np.zeros((h, w), dtype=np.float64)
    best_flag = np.zeros((h, w), dtype=np.int16)
    for flag, (dx, dy) in enumerate(D8_OFFSETS):
        zn = zpad[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w]
        dist = cell_size * (1.4142135623730951 if dx and dy else 1.0)
        slope = (zpad[1 : 1 + h, 1 : 1 + w] - zn) / dist
        take = slope > best_slope
        best_slope[take] = slope[take]
        best_flag[take] = 1 << flag
    best_flag[best_slope <= 0.0] = 0
    return best_flag


def flow_accumulation(filled: npt.NDArray[np.floating], directions: npt.NDArray[np.int16]) -> npt.NDArray[np.float64]:
    """Number of upstream cells draining through each cell (D8)."""
    h, w = filled.shape
    acc = np.ones((h, w), dtype=np.float64)
    # Offsets encode the neighbour index for each ESRI-style D8 flag.
    flag_to_offset = {1 << i: off for i, off in enumerate(D8_OFFSETS)}
    order = np.argsort(filled, axis=None)[::-1]  # high → low
    ys, xs = np.unravel_index(order, (h, w))
    acc_flat = acc.ravel()
    for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
        flag = int(directions[y, x])
        if flag == 0:
            continue
        dx, dy = flag_to_offset[flag]
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w:
            acc_flat[ny * w + nx] += acc_flat[y * w + x]
    return acc


def drainage_network_mask(
    dem: npt.NDArray[np.floating], cell_size: float, threshold: float
) -> tuple[npt.NDArray[np.bool_], npt.NDArray[np.float64]]:
    """Boolean stream mask and contributing-area grid (D8)."""
    filled = fill_sinks_priority_flood(dem)
    directions = d8_flow_directions(filled, cell_size)
    acc = flow_accumulation(filled, directions)
    return acc >= threshold, acc
