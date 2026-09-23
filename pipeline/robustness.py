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

Метрики при изъятии k узлов:

* `lcc_share` — доля оставшихся узлов в крупнейшей связной компоненте
  (неориентированная проекция: речь о связности инфраструктуры);
* `n_components` — на сколько фрагментов распалась сеть;
* `cut_kzt_share` — доля оборота на рёбрах, задетых изъятием;
* `seed_reach_share` — какая доля узлов, достижимых от seed в целом графе,
  остаётся достижимой (обход направленный, от живых seed по исходящим);
* `seed_reach_kzt_share` — какая доля оборота остаётся на маршрутах от seed.

Две последние метрики важнее первых: изъятие 20 узлов из 2248 в разреженном
графе почти не меняет размер крупнейшей компоненты, и честнее показать это
прямо, чем выдавать слабое расхождение за развал сети. Практический смысл для
следствия несёт другое — сколько денежных маршрутов от известных клиентов
перестаёт работать.

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


def _reach_from_seed(alive: np.ndarray, indptr: np.ndarray, indices: np.ndarray,
                     seed_idx: np.ndarray) -> np.ndarray:
    """Направленный обход от живых seed по исходящим рёбрам живых узлов."""
    seen = np.zeros(len(alive), bool)
    stack = [int(s) for s in seed_idx if alive[s]]
    for s in stack:
        seen[s] = True
    while stack:
        u = stack.pop()
        for v in indices[indptr[u]:indptr[u + 1]]:
            if alive[v] and not seen[v]:
                seen[v] = True
                stack.append(int(v))
    return seen


def _metrics(idx_alive: np.ndarray, src: np.ndarray, dst: np.ndarray,
             w: np.ndarray, n_nodes: int, indptr: np.ndarray,
             indices: np.ndarray, seed_idx: np.ndarray) -> dict:
    keep_edge = idx_alive[src] & idx_alive[dst]
    n_alive = int(idx_alive.sum())
    total_w = w.sum()
    if n_alive == 0:
        # изъяты все узлы: набор ключей тот же, что и в обычной ветке, иначе
        # вызывающий код падает на отсутствующем поле
        return {"lcc_share": 0.0, "n_components": 0, "cut_kzt_share": 1.0,
                "seed_reach_nodes": 0, "seed_reach_kzt": 0.0}

    m = coo_matrix(
        (np.ones(keep_edge.sum()), (src[keep_edge], dst[keep_edge])),
        shape=(n_nodes, n_nodes))
    _, labels = connected_components(m, directed=False)
    sizes = np.bincount(labels[idx_alive])
    lcc = int(sizes.max()) if len(sizes) else 0
    # изолированные изъятые узлы не должны считаться отдельными фрагментами
    comp_alive = len(np.unique(labels[idx_alive]))

    seen = _reach_from_seed(idx_alive, indptr, indices, seed_idx)
    reach_edge = keep_edge & seen[src]
    return {
        "lcc_share": lcc / n_alive,
        "n_components": comp_alive,
        "cut_kzt_share": float(w[~keep_edge].sum() / total_w) if total_w else 0.0,
        "seed_reach_nodes": int(seen.sum()),
        "seed_reach_kzt": float(w[reach_edge].sum()),
    }


KEYS = ["lcc_share", "n_components", "cut_kzt_share",
        "seed_reach_share", "seed_reach_kzt_share"]


def curves(nodes: pd.DataFrame, edges: pd.DataFrame) -> dict:
    gids = nodes.gid.to_numpy()
    pos = {g: i for i, g in enumerate(gids)}
    n_nodes = len(gids)
    src = edges.src.map(pos).to_numpy()
    dst = edges.dst.map(pos).to_numpy()
    w = edges.sum_kzt.to_numpy(float)
    seed_idx = nodes.loc[nodes.is_seed, "gid"].map(pos).to_numpy()

    # список смежности по исходящим рёбрам — для обхода от seed
    adj = coo_matrix((np.ones(len(src)), (src, dst)),
                     shape=(n_nodes, n_nodes)).tocsr()
    indptr, indices = adj.indptr, adj.indices

    def measure(alive: np.ndarray, base: dict | None) -> dict:
        m = _metrics(alive, src, dst, w, n_nodes, indptr, indices, seed_idx)
        ref = base or m
        m["seed_reach_share"] = (m["seed_reach_nodes"] / ref["seed_reach_nodes"]
                                 if ref["seed_reach_nodes"] else 0.0)
        m["seed_reach_kzt_share"] = (m["seed_reach_kzt"] / ref["seed_reach_kzt"]
                                     if ref["seed_reach_kzt"] else 0.0)
        return m

    # база: целый граф. Доли достижимости считаются от неё, а не от всего графа,
    # потому что часть узлов от seed недостижима и без всякого изъятия
    base = measure(np.ones(n_nodes, bool), None)

    order = (nodes.sort_values(["priority_score", "gid"], ascending=[False, True])
                  .gid.map(pos).to_numpy())
    # на графе меньше MAX_N узлов изымать 50 нечего: кривая строится до того,
    # сколько узлов есть. На выгрузке организаторов (2248 узлов) это не влияет
    ks = list(range(0, min(MAX_N, max(n_nodes - 1, 0)) + 1))

    tgt = {k: [] for k in KEYS}
    for k in ks:
        alive = np.ones(n_nodes, bool)
        alive[order[:k]] = False
        m = measure(alive, base)
        for key in KEYS:
            tgt[key].append(int(m[key]) if key == "n_components" else round(m[key], 4))

    rng = np.random.default_rng(RANDOM_SEED)
    rnd_raw = {k: [] for k in KEYS}
    for k in ks:
        acc = {key: [] for key in KEYS}
        for _ in range(RANDOM_REPEATS):
            alive = np.ones(n_nodes, bool)
            if k:
                alive[rng.choice(n_nodes, size=k, replace=False)] = False
            m = measure(alive, base)
            for key in KEYS:
                acc[key].append(m[key])
        for key in KEYS:
            rnd_raw[key].append(acc[key])

    rnd = {k: [round(float(np.mean(v)), 4) for v in rnd_raw[k]] for k in rnd_raw}
    rnd_sd = {k: [round(float(np.std(v)), 4) for v in rnd_raw[k]] for k in rnd_raw}

    def at(k: int) -> dict:
        i = ks.index(k)

        def ratio(a: float, b: float) -> float | None:
            return round(a / b, 2) if b else None

        # для доли отрезанного считаем «во сколько раз больше», для доли
        # сохранившегося — «во сколько раз меньше осталось»
        return {
            "n_removed": k,
            "targeted_lcc_share": tgt["lcc_share"][i],
            "random_lcc_share": rnd["lcc_share"][i],
            "lcc_ratio": ratio(rnd["lcc_share"][i], tgt["lcc_share"][i]),
            "targeted_components": tgt["n_components"][i],
            "random_components": rnd["n_components"][i],
            "targeted_cut_kzt_share": tgt["cut_kzt_share"][i],
            "random_cut_kzt_share": rnd["cut_kzt_share"][i],
            "cut_ratio": ratio(tgt["cut_kzt_share"][i], rnd["cut_kzt_share"][i]),
            "targeted_seed_reach_share": tgt["seed_reach_share"][i],
            "random_seed_reach_share": rnd["seed_reach_share"][i],
            "targeted_seed_reach_kzt_share": tgt["seed_reach_kzt_share"][i],
            "random_seed_reach_kzt_share": rnd["seed_reach_kzt_share"][i],
            "seed_reach_kzt_cut_ratio": ratio(
                1 - tgt["seed_reach_kzt_share"][i], 1 - rnd["seed_reach_kzt_share"][i]),
        }

    return {
        "метод": ("изъятие топ-N по priority_score против изъятия N случайных узлов, "
                  f"{RANDOM_REPEATS} повторов на каждое N, seed={RANDOM_SEED}"),
        "метрики": {
            "lcc_share": "доля живых узлов в крупнейшей компоненте (неориентированно)",
            "n_components": "на сколько фрагментов распалась сеть",
            "cut_kzt_share": "доля оборота на рёбрах, задетых изъятием",
            "seed_reach_share": "доля узлов, оставшихся достижимыми от seed (направленно)",
            "seed_reach_kzt_share": "доля оборота, оставшегося на маршрутах от seed",
        },
        "база_без_изъятия": {
            "достижимо_от_seed_узлов": int(base["seed_reach_nodes"]),
            "оборот_на_маршрутах_от_seed": round(float(base["seed_reach_kzt"]), 2),
        },
        "n_removed": ks,
        "targeted": tgt,
        "random_mean": rnd,
        "random_std": rnd_sd,
        "summary": {f"at_{k}": at(k) for k in (10, 20, 30, 50) if k in ks},
    }
