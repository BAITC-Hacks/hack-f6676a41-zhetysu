"""Устойчивость сети: изъятие топ-N по нашему приоритету против случайного.

Зачем это в пайплайне, а не в браузере. Интерфейс сам пересчитывает компоненты
и отрезанный оборот при движении ползунка — это дёшево. Чего в браузере дёшево
не получить — базовой линии: чтобы сказать «изъятие 20 узлов разваливает сеть»,
нужно знать, что даёт изъятие СЛУЧАЙНЫХ 20 узлов. Это 20 повторов на каждом
значении N, и считать их на клиенте незачем.

Смысл сравнения: если наше ранжирование ничего не находит, целевое изъятие
работает не лучше случайного и кривые совпадают. Расхождение кривых — это и
есть проверяемое доказательство, что priority_score выделяет узлы, на которых
держится сеть.

Метрики при изъятии k узлов (граф рассматривается как неориентированный, потому
что речь о связности инфраструктуры, а не о направлении платежа):

* `lcc_share` — доля оставшихся узлов в крупнейшей связной компоненте;
* `n_components` — на сколько фрагментов распалась сеть;
* `cut_kzt_share` — доля оборота на рёбрах, задетых изъятием.

Случайная базовая линия усредняется по 20 выборкам с фиксированным seed,
поэтому результат воспроизводим.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from .config import RANDOM_SEED

MAX_N = 50           # столько же, сколько у ползунка в интерфейсе
RANDOM_REPEATS = 20


def _metrics(idx_alive: np.ndarray, src: np.ndarray, dst: np.ndarray,
             w: np.ndarray, n_nodes: int) -> tuple[float, int, float]:
    keep_edge = idx_alive[src] & idx_alive[dst]
    n_alive = int(idx_alive.sum())
    if n_alive == 0:
        return 0.0, 0, 1.0
    m = coo_matrix(
        (np.ones(keep_edge.sum()), (src[keep_edge], dst[keep_edge])),
        shape=(n_nodes, n_nodes))
    n_comp, labels = connected_components(m, directed=False)
    sizes = np.bincount(labels[idx_alive])
    lcc = int(sizes.max()) if len(sizes) else 0
    # изолированные удалённые узлы не должны считаться компонентами
    comp_alive = len(np.unique(labels[idx_alive]))
    cut_share = float(w[~keep_edge].sum() / w.sum()) if w.sum() else 0.0
    return lcc / n_alive, comp_alive, cut_share


def curves(nodes: pd.DataFrame, edges: pd.DataFrame) -> dict:
    gids = nodes.gid.to_numpy()
    pos = {g: i for i, g in enumerate(gids)}
    n_nodes = len(gids)
    src = edges.src.map(pos).to_numpy()
    dst = edges.dst.map(pos).to_numpy()
    w = edges.sum_kzt.to_numpy(float)

    order = (nodes.sort_values(["priority_score", "gid"], ascending=[False, True])
                  .gid.map(pos).to_numpy())
    ks = list(range(0, MAX_N + 1))

    tgt = {"lcc_share": [], "n_components": [], "cut_kzt_share": []}
    for k in ks:
        alive = np.ones(n_nodes, bool)
        alive[order[:k]] = False
        lcc, nc, cut = _metrics(alive, src, dst, w, n_nodes)
        tgt["lcc_share"].append(round(lcc, 4))
        tgt["n_components"].append(int(nc))
        tgt["cut_kzt_share"].append(round(cut, 4))

    rng = np.random.default_rng(RANDOM_SEED)
    rnd_raw = {"lcc_share": [], "n_components": [], "cut_kzt_share": []}
    for k in ks:
        acc = {"lcc_share": [], "n_components": [], "cut_kzt_share": []}
        for _ in range(RANDOM_REPEATS):
            alive = np.ones(n_nodes, bool)
            if k:
                alive[rng.choice(n_nodes, size=k, replace=False)] = False
            lcc, nc, cut = _metrics(alive, src, dst, w, n_nodes)
            acc["lcc_share"].append(lcc)
            acc["n_components"].append(nc)
            acc["cut_kzt_share"].append(cut)
        for key in rnd_raw:
            rnd_raw[key].append(acc[key])

    rnd = {k: [round(float(np.mean(v)), 4) for v in rnd_raw[k]] for k in rnd_raw}
    rnd_sd = {k: [round(float(np.std(v)), 4) for v in rnd_raw[k]] for k in rnd_raw}

    def at(k: int) -> dict:
        i = ks.index(k)
        lcc_t, lcc_r = tgt["lcc_share"][i], rnd["lcc_share"][i]
        return {
            "n_removed": k,
            "targeted_lcc_share": lcc_t,
            "random_lcc_share": lcc_r,
            "lcc_ratio": round(lcc_r / lcc_t, 2) if lcc_t else None,
            "targeted_components": tgt["n_components"][i],
            "random_components": rnd["n_components"][i],
            "targeted_cut_kzt_share": tgt["cut_kzt_share"][i],
            "random_cut_kzt_share": rnd["cut_kzt_share"][i],
            "cut_ratio": (round(tgt["cut_kzt_share"][i] / rnd["cut_kzt_share"][i], 2)
                          if rnd["cut_kzt_share"][i] else None),
        }

    return {
        "метод": ("изъятие топ-N по priority_score против изъятия N случайных узлов, "
                  f"{RANDOM_REPEATS} повторов на каждое N, seed={RANDOM_SEED}"),
        "связность": "неориентированная проекция: речь об инфраструктуре, а не о направлении платежа",
        "n_removed": ks,
        "targeted": tgt,
        "random_mean": rnd,
        "random_std": rnd_sd,
        "summary": {f"at_{k}": at(k) for k in (10, 20, 30, 50)},
    }
