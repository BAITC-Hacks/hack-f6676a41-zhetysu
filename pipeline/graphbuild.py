"""Сборка графа.

Граф денег НАПРАВЛЕННЫЙ и ВЗВЕШЕННЫЙ — направление движения средств несёт
основной смысл кейса, поэтому все ролевые метрики считаются на DiGraph.
Неориентированная проекция (UG) используется ровно в одном месте —
в кластеризации Louvain, и это ограничение оговорено в METHOD.md.
"""

from __future__ import annotations

import networkx as nx

from .data import Dataset


def build(ds: Dataset) -> tuple[nx.DiGraph, nx.Graph]:
    G = nx.DiGraph()
    # все узлы, включая те, что не встречаются ни в одном ребре
    G.add_nodes_from(ds.nodes.gid.tolist())
    for r in ds.edges.itertuples(index=False):
        G.add_edge(int(r.src), int(r.dst),
                   sum_kzt=float(r.sum_kzt), n_tx=int(r.n_tx), depth=int(r.depth))

    UG = nx.Graph()
    UG.add_nodes_from(G.nodes)
    for u, v, d in G.edges(data=True):
        if UG.has_edge(u, v):
            UG[u][v]["sum_kzt"] += d["sum_kzt"]
            UG[u][v]["n_tx"] += d["n_tx"]
        else:
            UG.add_edge(u, v, sum_kzt=d["sum_kzt"], n_tx=d["n_tx"])
    return G, UG
