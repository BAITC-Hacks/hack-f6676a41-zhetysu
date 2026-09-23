"""Выгрузки: три CSV по схеме ТЗ и out/graph.json по контракту интерфейса.

Важно про типы gid:
* в CSV gid остаётся int64 — так требует ТЗ;
* в graph.json gid — СТРОКА везде (nodes[].gid, edges[].src/.dst,
  clusters[].top_gids[], top_nodes[].gid). Причина: все 2248 идентификаторов
  18-значные и превышают 2^53, поэтому JSON.parse в браузере исказил бы
  каждый из них и поиск по gid на демо не находил бы узлы.

В JSON не должно быть NaN (JSON.parse такое не принимает) — все нечисловые
значения приводятся к null.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C

ASTANA = timezone(timedelta(hours=5))

# схема ТЗ + дополнительные колонки (добавлять можно, удалять нельзя)
NODES_CSV_COLUMNS = [
    "gid", "role", "role_score", "cluster_id", "priority_score", "evidence",
    # дальше — признаки, на которых построены правила
    "rule_id", "depth", "is_seed", "in_deg", "out_deg", "in_kzt", "out_kzt",
    "in_tx", "out_tx", "pagerank", "betweenness", "hub", "authority",
    "pass_through", "retained_kzt", "unseen_inflow_kzt", "n_seed_payers",
    "truncated_by_depth", "terminal_status", "terminal_p",
    "hold_days_median", "fast_out_share", "max_same_day_payers",
    "max_same_day_one_payer_tx", "flag_fast_transit", "flag_sync_collection",
    "flag_structuring", "timing_score", "downstream_nodes",
    "component_size", "is_articulation",
]

CLUSTERS_CSV_COLUMNS = [
    "cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis",
    "n_coordinator", "n_consolidator", "n_distributor", "n_transit", "n_terminal",
    "n_truncated", "kzt_out_of_cluster", "kzt_into_cluster", "max_depth",
]

GRAPH_NODE_FIELDS = [
    "role", "role_score", "cluster_id", "priority_score", "depth", "is_seed",
    "in_deg", "out_deg", "in_kzt", "out_kzt", "in_tx", "out_tx", "pagerank",
    "pass_through", "truncated_by_depth", "evidence",
    # наши дополнения
    "rule_id", "terminal_status", "terminal_p", "betweenness", "hub", "authority",
    "retained_kzt", "unseen_inflow_kzt", "n_seed_payers", "hold_days_median",
    "fast_out_share", "max_same_day_payers", "max_same_day_one_payer_tx",
    "flag_fast_transit", "flag_sync_collection", "flag_structuring", "timing_score",
    "downstream_nodes", "component_size", "is_articulation", "why",
]


def _clean(v):
    """NaN/NA → None, numpy-типы → python-типы."""
    if v is None or v is pd.NA:
        return None
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else round(f, 8)
    if isinstance(v, (np.str_, str)):
        return str(v)
    if isinstance(v, (list, tuple, np.ndarray)):
        return [_clean(x) for x in v]
    if pd.isna(v):
        return None
    return v


def write_csv(nodes: pd.DataFrame, clusters: pd.DataFrame,
              top: pd.DataFrame, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    n = nodes.copy()
    n["gid"] = n.gid.astype("int64")
    for col in NODES_CSV_COLUMNS:
        if col not in n.columns:
            n[col] = ""
    n[NODES_CSV_COLUMNS].to_csv(out_dir / "nodes_roles.csv", index=False)

    c = clusters.copy()
    c["top_gids"] = c.top_gids.apply(lambda xs: " ".join(str(int(x)) for x in xs))
    c[CLUSTERS_CSV_COLUMNS].to_csv(out_dir / "clusters.csv", index=False)

    t = top.copy()
    t["gid"] = t.gid.astype("int64")
    t[["rank", "gid", "role", "priority_score", "why",
       "cluster_id", "role_score", "rule_id"]].to_csv(
        out_dir / "top_nodes.csv", index=False)


def write_graph_json(nodes: pd.DataFrame, edges: pd.DataFrame,
                     clusters: pd.DataFrame, top: pd.DataFrame,
                     meta_extra: dict, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    node_list = []
    for r in nodes.itertuples(index=False):
        d = {"gid": str(int(r.gid))}
        for f in GRAPH_NODE_FIELDS:
            d[f] = _clean(getattr(r, f, None))
        node_list.append(d)

    edge_list = [{"src": str(int(r.src)), "dst": str(int(r.dst)),
                  "sum_kzt": float(r.sum_kzt), "n_tx": int(r.n_tx),
                  "depth": int(r.depth)}
                 for r in edges.itertuples(index=False)]

    cluster_list = []
    for r in clusters.to_dict("records"):
        item = {k: _clean(v) for k, v in r.items()}
        item["top_gids"] = [str(int(x)) for x in r["top_gids"]]
        cluster_list.append(item)

    top_list = [{"rank": int(r["rank"]), "gid": str(int(r["gid"])),
                 "role": r["role"], "priority_score": float(r["priority_score"]),
                 "why": r["why"]}
                for r in top.to_dict("records")]

    doc = {
        "meta": {
            "n_nodes": int(len(nodes)),
            "n_edges": int(len(edges)),
            "n_seed": int(nodes.is_seed.sum()),
            "total_kzt": round(float(edges.sum_kzt.sum()), 2),
            "period": meta_extra["period"],
            "generated_at": datetime.now(ASTANA).isoformat(timespec="seconds"),
            "stub": False,
            "gid_is_string": True,
            "pipeline_seconds": meta_extra.get("pipeline_seconds"),
            "role_counts": {k: int(v) for k, v in
                            nodes.role.value_counts().items()},
            "terminal_status_counts": {k: int(v) for k, v in
                                       nodes.terminal_status.value_counts().items()},
            # разбивка роли terminal по правилам: сколько подтверждено наблюдением,
            # сколько по осаждению суммы и сколько оценено вероятностью
            "terminal_breakdown": _terminal_breakdown(nodes, meta_extra["thresholds"]),
            "pattern_counts": {
                "flag_fast_transit": int(nodes.flag_fast_transit.sum()),
                "flag_sync_collection": int(nodes.flag_sync_collection.sum()),
                "flag_structuring": int(nodes.flag_structuring.sum()),
                "любой_признак": int((nodes.flag_fast_transit |
                                      nodes.flag_sync_collection |
                                      nodes.flag_structuring).sum()),
            },
            "rule_counts": {k: int(v) for k, v in
                            nodes.rule_id.str.split(":").str[0].value_counts().items()},
            "robustness": meta_extra["robustness"],
            "method": {
                "thresholds": meta_extra["thresholds"],
                "priority_weights": C.PRIORITY_WEIGHTS,
                "censoring": meta_extra["censoring"],
            },
        },
        "roles": C.ROLE_LABELS,
        "nodes": node_list,
        "edges": edge_list,
        "clusters": cluster_list,
        "top_nodes": top_list,
    }

    path = out_dir / "graph.json"
    tmp = out_dir / "graph.json.tmp"
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    tmp.replace(path)   # интерфейс читает файл целиком — подменяем атомарно


def write_method_artifacts(thresholds: dict, censoring: dict, out_dir: Path) -> None:
    (out_dir / "thresholds.json").write_text(
        json.dumps(thresholds, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "censoring_report.json").write_text(
        json.dumps(censoring, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
