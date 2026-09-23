"""Кластеризация сети и гипотезы о назначении кластеров.

Метод: Louvain на НЕОРИЕНТИРОВАННОЙ проекции графа с весом sum_kzt.
Ограничение оговариваем прямо: модульность определена для неориентированных
графов, поэтому на этом шаге направление движения денег теряется. Это
осознанная уступка — кластер отвечает на вопрос «кто с кем связан деньгами»,
а направление восстанавливается внутри кластера ролями узлов, которые
посчитаны на направленном графе.

Узлы без рёбер в отдельный кластер не попадают: им присваивается
cluster_id = -1 («вне сети»), и по нему тоже есть строка в clusters.csv.

Гипотеза кластера собирается из его состава по шаблону: сколько seed,
сколько точек сбора, есть ли координатор, куда уходят деньги. Это не
утверждение о виновности, а формулировка «на что похоже и что проверять».
"""

from __future__ import annotations

import networkx as nx
import numpy as np
import pandas as pd

from . import config as C
from .roles import _m


def detect(UG: nx.Graph, df: pd.DataFrame) -> pd.Series:
    """cluster_id для каждого gid. Нумерация по убыванию размера — стабильна."""
    active = [g for g in UG.nodes if UG.degree(g) > 0]
    sub = UG.subgraph(active)
    comms = nx.community.louvain_communities(
        sub, weight="sum_kzt", seed=C.RANDOM_SEED, resolution=1.0)
    comms = sorted(comms, key=lambda c: (-len(c), min(c)))
    mapping = {}
    for cid, comm in enumerate(comms):
        for gid in comm:
            mapping[gid] = cid
    return df.gid.map(mapping).fillna(-1).astype(int)


def summarize(df: pd.DataFrame, edges: pd.DataFrame) -> pd.DataFrame:
    """Таблица кластеров: размер, seed, внутренний оборот, топ-узлы, гипотеза."""
    cl = df[["gid", "cluster_id", "role", "is_seed", "priority_score",
             "in_kzt", "out_kzt", "depth", "terminal_status"]].copy()
    cid_of = dict(zip(cl.gid, cl.cluster_id))

    e = edges.copy()
    e["c_src"] = e.src.map(cid_of)
    e["c_dst"] = e.dst.map(cid_of)
    internal = e[e.c_src == e.c_dst].groupby("c_src").agg(
        sum_kzt_internal=("sum_kzt", "sum"), n_edges_internal=("n_tx", "size"))
    outflow = e[(e.c_src != e.c_dst)].groupby("c_src").sum_kzt.sum()
    inflow = e[(e.c_src != e.c_dst)].groupby("c_dst").sum_kzt.sum()

    rows = []
    for cid, g in cl.groupby("cluster_id"):
        roles = g.role.value_counts().to_dict()
        top = (g.sort_values("priority_score", ascending=False)
                .head(5).gid.astype("int64").tolist())
        row = {
            "cluster_id": int(cid),
            "n_nodes": int(len(g)),
            "n_seed": int(g.is_seed.sum()),
            "sum_kzt_internal": round(float(internal.sum_kzt_internal.get(cid, 0.0)), 2),
            "top_gids": top,
            "n_coordinator": roles.get("coordinator", 0),
            "n_consolidator": roles.get("consolidator", 0),
            "n_distributor": roles.get("distributor", 0),
            "n_transit": roles.get("transit", 0),
            "n_terminal": roles.get("terminal", 0),
            "n_truncated": int((g.terminal_status == "unknown_truncated").sum()),
            "kzt_out_of_cluster": round(float(outflow.get(cid, 0.0)), 2),
            "kzt_into_cluster": round(float(inflow.get(cid, 0.0)), 2),
            "max_depth": int(g.depth.max()),
        }
        row["hypothesis"] = _hypothesis(row, g)
        rows.append(row)

    out = pd.DataFrame(rows).sort_values("cluster_id").reset_index(drop=True)
    return out


def _hypothesis(row: dict, g: pd.DataFrame) -> str:
    """Гипотеза о назначении кластера — из состава, шаблоном, без домыслов."""
    if row["cluster_id"] == -1:
        return (f"{row['n_nodes']} seed-клиентов без единого перевода в выгрузке: "
                f"либо переводы ниже порога 5 000 KZT, либо вне банка — "
                f"нужен запрос по внешним каналам")
    if row["n_nodes"] <= 3:
        return (f"изолированный фрагмент из {row['n_nodes']} узлов, оборот "
                f"{_m(row['sum_kzt_internal'])} KZT — отдельная мелкая цепочка, "
                f"связи с ядром сети не видно")

    parts = []
    if row["n_seed"] >= 2:
        parts.append(f"сбор средств от {row['n_seed']} известных следствию клиентов")
    elif row["n_seed"] == 1:
        parts.append("одна точка входа со стороны известного следствию клиента")
    else:
        parts.append("нижних звеньев дела в кластере нет — участок ниже по потоку")

    if row["n_coordinator"]:
        parts.append(f"{row['n_coordinator']} узел(ов) над точками сбора — "
                     f"кандидаты в распорядители")
    if row["n_consolidator"]:
        parts.append(f"{row['n_consolidator']} точк(и) консолидации")
    if row["n_distributor"]:
        parts.append(f"{row['n_distributor']} веерных рассылок")
    if row["n_transit"]:
        parts.append(f"{row['n_transit']} транзитных счетов")
    if row["n_terminal"]:
        parts.append(f"{row['n_terminal']} узлов, где деньги остались")

    tail = (f"внутренний оборот {_m(row['sum_kzt_internal'])} KZT, "
            f"наружу уходит {_m(row['kzt_out_of_cluster'])} KZT")
    if row["n_truncated"]:
        tail += f"; {row['n_truncated']} узлов обрезаны 4-м коленом — картина неполна"
    return "; ".join(parts) + ". " + tail
