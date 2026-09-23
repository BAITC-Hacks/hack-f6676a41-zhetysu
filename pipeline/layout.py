"""Раскладка графа: координаты узлов считаются здесь, браузер только рисует.

Зачем в ядре. Силовая симуляция на клиенте даёт «комки одинаковых шариков»:
она оптимизирует длину рёбер, а не смысл кейса, и результат меняется от
запуска к запуску. Раскладка в пайплайне решает три задачи сразу: картинка
детерминирована (те же координаты на каждом прогоне), телефон не считает
физику, и геометрия несёт смысл.

## Метод: радиальные клинья «кластер = угол, колено = радиус»

    радиус  = колено обхода (depth): seed в центре, 4-е колено по краю
    угол    = кластер: каждый кластер занимает клин, ширина ∝ числу узлов
    внутри клина = по priority_score, важные ближе к оси клина

Отличие от предложенной концентрической схемы «кольцо = колено, сектор внутри
кольца = кластер»: там кластер разрезается на четыре отдельные дуги в разных
кольцах и перестаёт читаться как целое. Здесь кластер — непрерывный клин от
центра к периферии, то есть видно и движение денег от seed наружу (радиально),
и границы кластеров (угловые), а точки консолидации опознаются как узлы, в
которые входят стрелки из соседних клиньев.

Порядок клиньев по кругу не произвольный: кластеры упорядочены жадно по силе
межкластерных денежных связей, поэтому связанные кластеры стоят рядом и хорды
между ними короткие, а не режут схему через центр.

## Панели: компоненты не смешиваются

Сеть не монолитна — 16 слабосвязных компонент плюс 19 seed без рёбер.
Смешивать их в одном диске нельзя, иначе получится каша:

* главная панель — крупнейшая компонента (1877 узлов), занимает основную площадь;
* остальные компоненты — отдельными островками, сложенными в полосу справа,
  радиус островка ∝ sqrt(числа узлов), то есть площадь пропорциональна размеру;
* 19 seed без рёбер — отдельной панелью-решёткой, они ни с чем не связаны.

Площадь делится не поровну: главная панель получает радиус 1.0, компонента из
270 узлов — sqrt(270/1877) ≈ 0.38, островок из двух узлов — минимальные 0.06.

## Разведение наложений

Внутри пары (клин, колено) узлы выкладываются по дуге с шагом не меньше
MIN_DIST. Если на дуге столько места нет, группа разбивается на несколько
подслоёв по радиусу внутри полосы своего кольца — узел слегка отходит от
идеальной окружности, но не накладывается на соседа. Фактический минимальный
зазор проверяется после раскладки (KD-дерево) и пишется в `meta.layout`.

Координаты на выходе нормированы в [0, 1] с сохранением пропорций: единый
масштаб по обеим осям, иначе клинья превратились бы в эллипсы.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

# рабочие единицы: радиус главной панели = 1.0
R_MAIN = 1.0
MIN_DIST = 0.03          # минимальный зазор между центрами узлов
MIN_GAP_NORM = 0.007     # целевой зазор в нормированных координатах
MAX_SHIFT_NORM = 0.02    # насколько узел может отойти от своего места в клине
R_INNER = 0.22           # радиус кольца seed (depth 0)
WEDGE_GAP_TOTAL = 0.06   # суммарная доля окружности, отданная зазорам
MIN_WEDGE_RAD = 0.035    # минимальная ширина клина (~2°)
SAT_MIN_R = 0.06         # минимальный радиус островка
PANEL_GAP = 0.14
MARGIN = 0.03            # отступ от краёв в нормированных координатах


# ------------------------------------------------------------------ панели

def _components(nodes: pd.DataFrame, edges: pd.DataFrame) -> list[list[int]]:
    """Слабые компоненты, по убыванию размера. Реализовано union-find,
    чтобы не тащить networkx в модуль раскладки."""
    parent = {g: g for g in nodes.gid}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for s, d in zip(edges.src, edges.dst):
        ra, rb = find(s), find(d)
        if ra != rb:
            parent[ra] = rb

    groups: dict[int, list[int]] = {}
    for g in nodes.gid:
        groups.setdefault(find(g), []).append(int(g))
    # сортировка: по размеру, затем по минимальному gid — устойчиво между прогонами
    return sorted(groups.values(), key=lambda c: (-len(c), min(c)))


def _order_clusters(cluster_ids: list[int], nodes: pd.DataFrame,
                    edges: pd.DataFrame) -> list[int]:
    """Порядок клиньев по кругу: жадно по силе денежных связей.

    Начинаем с крупнейшего кластера и каждый раз добавляем тот, у которого
    сильнейшая связь с последним поставленным. Связанные кластеры оказываются
    соседями, и межкластерные хорды не режут схему через центр.
    """
    if len(cluster_ids) <= 2:
        return list(cluster_ids)
    cid = dict(zip(nodes.gid, nodes.cluster_id))
    inside = set(cluster_ids)
    w: dict[tuple[int, int], float] = {}
    for s, d, amount in zip(edges.src, edges.dst, edges.sum_kzt):
        a, b = cid.get(s), cid.get(d)
        if a is None or b is None or a == b or a not in inside or b not in inside:
            continue
        key = (min(a, b), max(a, b))
        w[key] = w.get(key, 0.0) + float(amount)

    sizes = nodes[nodes.cluster_id.isin(inside)].cluster_id.value_counts()
    remaining = sorted(inside, key=lambda c: (-int(sizes.get(c, 0)), c))
    order = [remaining.pop(0)]
    while remaining:
        last = order[-1]
        best = max(remaining, key=lambda c: (
            w.get((min(last, c), max(last, c)), 0.0), int(sizes.get(c, 0)), -c))
        remaining.remove(best)
        order.append(best)
    return order


# ------------------------------------------------------------------ клинья

def _centered_order(n: int) -> list[int]:
    """Позиции 0..n-1 в порядке «от середины к краям»: важные — к оси клина."""
    mid = (n - 1) / 2
    return sorted(range(n), key=lambda i: (abs(i - mid), i))


def _place_wedge(group: pd.DataFrame, angle_c: float, width: float,
                 r: float, band: float) -> dict[int, tuple[float, float]]:
    """Узлы одной пары (клин, колено) — по дуге, при нехватке места в несколько
    подслоёв по радиусу."""
    n = len(group)
    if n == 0:
        return {}
    arc = max(width * r, 1e-6)
    k = max(1, math.ceil(n * MIN_DIST / arc))
    max_k = max(1, int(band / MIN_DIST) + 1)
    k = min(k, max_k)

    # узлы по важности: сначала самые приоритетные
    ordered = group.sort_values(["priority_score", "gid"],
                                ascending=[False, True]).gid.tolist()
    layers: list[list[int]] = [[] for _ in range(k)]
    for i, gid in enumerate(ordered):
        layers[i % k].append(gid)

    pos: dict[int, tuple[float, float]] = {}
    for m, layer in enumerate(layers):
        if not layer:
            continue
        r_m = r if k == 1 else r + (m - (k - 1) / 2) * (band / max(k - 1, 1))
        cnt = len(layer)
        step = width / cnt
        slots = _centered_order(cnt)
        for gid, slot in zip(layer, slots):
            a = angle_c + (slot - (cnt - 1) / 2) * step
            pos[gid] = (r_m * math.cos(a), r_m * math.sin(a))
    return pos


def _radial_panel(panel: pd.DataFrame, edges: pd.DataFrame,
                  radius: float) -> tuple[dict[int, tuple[float, float]], dict]:
    """Радиальная раскладка одной панели: клин = кластер, радиус = колено."""
    if len(panel) == 1:
        gid = int(panel.gid.iloc[0])
        return {gid: (0.0, 0.0)}, {}

    cluster_ids = _order_clusters(sorted(panel.cluster_id.unique()), panel, edges)
    counts = panel.cluster_id.value_counts()
    weights = {c: max(float(counts.get(c, 0)), 0.5) for c in cluster_ids}
    total_w = sum(weights.values())

    gap_each = (WEDGE_GAP_TOTAL * 2 * math.pi) / len(cluster_ids)
    free = 2 * math.pi * (1 - WEDGE_GAP_TOTAL)
    widths = {c: max(free * weights[c] / total_w, MIN_WEDGE_RAD) for c in cluster_ids}
    # если минимальные ширины переполнили круг, сжимаем всё пропорционально
    over = sum(widths.values()) + gap_each * len(cluster_ids)
    if over > 2 * math.pi:
        scale = (2 * math.pi - gap_each * len(cluster_ids)) / sum(widths.values())
        widths = {c: w * scale for c, w in widths.items()}

    depths = sorted(panel.depth.unique())
    d_lo, d_hi = min(depths), max(depths)
    span = max(d_hi - d_lo, 1)
    r_of_depth = {d: radius * (R_INNER + (1 - R_INNER) * (d - d_lo) / span)
                  for d in depths}
    # полоса кольца: 85% расстояния до следующего кольца. Меньше — узлы теснятся
    # на самой окружности, больше — кольца сливаются и колено перестаёт читаться
    band = radius * (1 - R_INNER) / span * 0.85

    pos: dict[int, tuple[float, float]] = {}
    wedges: dict[int, dict] = {}
    angle = 0.0
    for c in cluster_ids:
        w = widths[c]
        angle_c = angle + w / 2
        sub = panel[panel.cluster_id == c]
        for d, grp in sub.groupby("depth"):
            pos.update(_place_wedge(grp, angle_c, w, r_of_depth[d], band))
        wedges[int(c)] = {
            "angle_start": round(angle, 5),
            "angle_end": round(angle + w, 5),
            "r_inner": round(min(r_of_depth[d] for d in sub.depth.unique()) - band / 2, 5),
            "r_outer": round(max(r_of_depth[d] for d in sub.depth.unique()) + band / 2, 5),
        }
        angle += w + gap_each
    return pos, wedges


def _relax(pts: np.ndarray, min_dist: float, max_shift: float,
           iters: int = 30) -> tuple[np.ndarray, int]:
    """Разведение наложений: только расталкивание, без притяжения.

    Кольца и клинья задают смысл, поэтому силовой симуляции здесь нет — узел
    лишь отодвигается от слишком близкого соседа и не более чем на max_shift
    от своего места в клине. Порядок обработки пар фиксирован, случайности нет,
    поэтому результат одинаков на каждом прогоне.
    """
    anchor = pts.copy()
    for _ in range(iters):
        pairs = sorted(cKDTree(pts).query_pairs(min_dist))
        if not pairs:
            break
        disp = np.zeros_like(pts)
        for i, j in pairs:
            v = pts[i] - pts[j]
            dist = float(np.hypot(*v))
            if dist < 1e-12:
                # совпавшие точки расходятся по детерминированному направлению
                ang = (i * 2.399963)  # золотой угол, зависит только от индекса
                v = np.array([math.cos(ang), math.sin(ang)])
                dist = 1e-12
            push = (min_dist - dist) / 2 * v / max(dist, 1e-12)
            disp[i] += push
            disp[j] -= push
        pts = pts + disp
        # не даём узлу уехать далеко от своего кольца и клина
        delta = pts - anchor
        d = np.hypot(delta[:, 0], delta[:, 1])
        too_far = d > max_shift
        if too_far.any():
            k = np.where(too_far, max_shift / np.maximum(d, 1e-12), 1.0)
            pts = anchor + delta * k[:, None]
    left = len(sorted(cKDTree(pts).query_pairs(min_dist)))
    return pts, left


def _grid_panel(panel: pd.DataFrame, radius: float) -> dict[int, tuple[float, float]]:
    """Решётка — для узлов без рёбер: кольца и клинья им нечего показывать."""
    gids = sorted(int(g) for g in panel.gid)
    cols = max(1, int(math.ceil(math.sqrt(len(gids)))))
    rows = int(math.ceil(len(gids) / cols))
    step = max(MIN_DIST, 2 * radius / max(cols, rows))
    pos = {}
    for i, gid in enumerate(gids):
        cx, cy = i % cols, i // cols
        pos[gid] = ((cx - (cols - 1) / 2) * step, ((rows - 1) / 2 - cy) * step)
    return pos


# ------------------------------------------------------------------ сборка

def compute(nodes: pd.DataFrame, edges: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """Возвращает (координаты узлов, геометрия кластеров, описание для meta)."""
    comps = _components(nodes, edges)
    by_gid = nodes.set_index("gid")

    main = comps[0]
    isolated = [c[0] for c in comps if len(c) == 1]
    islands = [c for c in comps[1:] if len(c) >= 2]

    panels = [{"id": 0, "kind": "main", "gids": main,
               "radius": R_MAIN, "label": "основная сеть"}]
    for i, comp in enumerate(islands, start=1):
        panels.append({
            "id": i, "kind": "island", "gids": comp,
            "radius": max(SAT_MIN_R, R_MAIN * math.sqrt(len(comp) / len(main))),
            "label": f"изолированный фрагмент, {len(comp)} узлов",
        })
    if isolated:
        panels.append({"id": len(panels), "kind": "no_edges", "gids": isolated,
                       "radius": max(SAT_MIN_R, R_MAIN * math.sqrt(len(isolated) / len(main))),
                       "label": f"seed без рёбер, {len(isolated)} узлов"})

    # главная панель в центре, остальные — полосой справа, полки сверху вниз
    panels[0]["center"] = (0.0, 0.0)
    sats = sorted(panels[1:], key=lambda p: (-p["radius"], p["id"]))
    x_left = R_MAIN + PANEL_GAP
    cursor_y, col_max_r = R_MAIN, 0.0
    for p in sats:
        r = p["radius"]
        if cursor_y - 2 * r < -R_MAIN and cursor_y != R_MAIN:
            x_left += 2 * col_max_r + PANEL_GAP
            cursor_y, col_max_r = R_MAIN, 0.0
        p["center"] = (x_left + r, cursor_y - r)
        cursor_y -= 2 * r + PANEL_GAP * 0.5
        col_max_r = max(col_max_r, r)

    pos: dict[int, tuple[float, float]] = {}
    wedge_geom: dict[int, dict] = {}
    panel_of: dict[int, int] = {}
    for p in panels:
        sub = by_gid.loc[p["gids"]].reset_index()
        cx, cy = p["center"]
        if p["kind"] == "no_edges":
            local = _grid_panel(sub, p["radius"])
            local_wedges = {}
        else:
            local, local_wedges = _radial_panel(sub, edges, p["radius"])
        for gid, (x, y) in local.items():
            pos[gid] = (cx + x, cy + y)
            panel_of[gid] = p["id"]
        for c, w in local_wedges.items():
            w["panel"] = p["id"]
            w["panel_center_x"], w["panel_center_y"] = cx, cy
            wedge_geom[c] = w

    xy = pd.DataFrame({"gid": list(pos), "x_raw": [pos[g][0] for g in pos],
                       "y_raw": [pos[g][1] for g in pos]})

    # нормировка в [MARGIN, 1-MARGIN] единым масштабом по обеим осям
    x0, x1 = xy.x_raw.min(), xy.x_raw.max()
    y0, y1 = xy.y_raw.min(), xy.y_raw.max()
    scale = (1 - 2 * MARGIN) / max(x1 - x0, y1 - y0, 1e-9)
    off_x = MARGIN + ((1 - 2 * MARGIN) - (x1 - x0) * scale) / 2
    off_y = MARGIN + ((1 - 2 * MARGIN) - (y1 - y0) * scale) / 2
    xy["x"] = (xy.x_raw - x0) * scale + off_x
    xy["y"] = (xy.y_raw - y0) * scale + off_y

    # разведение наложений и фактический зазор — проверяем, а не обещаем
    pts, left = _relax(xy[["x", "y"]].to_numpy(), MIN_GAP_NORM, MAX_SHIFT_NORM)
    pts[:, 0] = np.clip(pts[:, 0], MARGIN, 1 - MARGIN)
    pts[:, 1] = np.clip(pts[:, 1], MARGIN, 1 - MARGIN)
    xy["x"] = pts[:, 0].round(5)
    xy["y"] = pts[:, 1].round(5)

    d, _ = cKDTree(pts).query(pts, k=2)
    nn = d[:, 1]

    geom = _cluster_geometry(nodes, xy, wedge_geom, scale, panel_of)
    meta = {
        "метод": "радиальные клинья: угол = кластер, радиус = колено обхода",
        "описание": (
            "seed в центре, колена 1–4 — наружу; каждый кластер занимает клин, "
            "ширина клина пропорциональна числу узлов, внутри клина узлы "
            "отсортированы по priority_score (важные ближе к оси). Порядок "
            "клиньев подобран жадно по силе межкластерных денежных связей, "
            "поэтому связанные кластеры стоят рядом."),
        "панели": [
            {"id": p["id"], "kind": p["kind"], "label": p["label"],
             "n_nodes": len(p["gids"]),
             "center_x": round((p["center"][0] - x0) * scale + off_x, 5),
             "center_y": round((p["center"][1] - y0) * scale + off_y, 5),
             "radius": round(p["radius"] * scale, 5)}
            for p in panels],
        "координаты": "нормированы в [0,1], единый масштаб по осям, y растёт вверх",
        "детерминированность": "случайности нет, координаты одинаковы на каждом прогоне",
        "разведение_наложений": (
            f"расталкивание до зазора {MIN_GAP_NORM} с ограничением смещения "
            f"{MAX_SHIFT_NORM}; пар ближе порога осталось {left}"),
        "минимальный_зазор_между_узлами": round(float(nn.min()), 5),
        "медианный_зазор": round(float(np.median(nn)), 5),
        "узлов_ближе_0.005": int((nn < 0.005).sum()),
        "на_клиенте": "силовая симуляция не нужна — интерфейс рисует готовые x, y",
    }
    return xy[["gid", "x", "y"]], geom, meta


def _cluster_geometry(nodes: pd.DataFrame, xy: pd.DataFrame,
                      wedges: dict[int, dict], scale: float,
                      panel_of: dict[int, int]) -> pd.DataFrame:
    """Центр и радиус подложки кластера — считаются по факту координат."""
    df = nodes[["gid", "cluster_id"]].merge(xy, on="gid", how="left")
    rows = []
    for cid, g in df.groupby("cluster_id"):
        cx, cy = float(g.x.mean()), float(g.y.mean())
        rad = float(np.sqrt((g.x - cx) ** 2 + (g.y - cy) ** 2).max())
        w = wedges.get(int(cid), {})
        rows.append({
            "cluster_id": int(cid),
            "center_x": round(cx, 5),
            "center_y": round(cy, 5),
            "radius": round(rad + 0.008, 5),
            # панель определяем по фактическим узлам кластера: у кластеров
            # без клина (seed без рёбер) угловой геометрии нет
            "panel": int(pd.Series([panel_of.get(int(g), 0) for g in g.gid]).mode().iat[0]),
            "angle_start": w.get("angle_start"),
            "angle_end": w.get("angle_end"),
            # радиусы клина — в тех же нормированных единицах, что x и y;
            # центр панели интерфейс берёт из meta.layout.панели
            "r_inner": round(w["r_inner"] * scale, 5) if "r_inner" in w else None,
            "r_outer": round(w["r_outer"] * scale, 5) if "r_outer" in w else None,
        })
    return pd.DataFrame(rows)
