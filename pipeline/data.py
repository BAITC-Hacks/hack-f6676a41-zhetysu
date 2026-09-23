"""Загрузка и проверка исходных выгрузок."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd


@dataclass
class Dataset:
    edges: pd.DataFrame      # src, dst, sum_kzt, n_tx, depth
    nodes: pd.DataFrame      # gid, depth, is_seed
    tx: pd.DataFrame         # src, dst, date, sum_kzt
    period: str              # "2026-07-01..2026-07-31"
    total_kzt: float

    @property
    def seed_gids(self) -> set:
        return set(self.nodes.loc[self.nodes.is_seed, "gid"])


def load(data_dir: Path) -> Dataset:
    edges = pd.read_parquet(data_dir / "edges.parquet")
    nodes = pd.read_parquet(data_dir / "nodes.parquet")
    tx = pd.read_parquet(data_dir / "transactions.parquet")

    tx["date"] = pd.to_datetime(tx["date"])
    nodes["is_seed"] = nodes["is_seed"].astype(bool)

    period = f"{tx.date.min().date()}..{tx.date.max().date()}"
    return Dataset(edges=edges, nodes=nodes, tx=tx,
                   period=period, total_kzt=float(edges.sum_kzt.sum()))


def sanity(ds: Dataset) -> dict:
    """Проверки консистентности. Расхождение здесь означает, что считать
    дальше нельзя — лучше упасть на запуске, чем отдать жюри мусор."""
    agg = (ds.tx.groupby(["src", "dst"])
             .agg(s=("sum_kzt", "sum"), c=("sum_kzt", "size")).reset_index())
    m = ds.edges.merge(agg, on=["src", "dst"], how="outer", indicator=True)
    assert (m._merge == "both").all(), "edges и transactions не сходятся по парам"

    gids = set(ds.nodes.gid)
    assert set(ds.edges.src) | set(ds.edges.dst) <= gids, "в рёбрах есть gid вне nodes"
    assert ds.nodes.gid.is_unique, "gid в nodes.parquet не уникален"

    in_edges = set(ds.edges.src) | set(ds.edges.dst)
    return {
        "n_nodes": int(len(ds.nodes)),
        "n_edges": int(len(ds.edges)),
        "n_tx": int(len(ds.tx)),
        "n_seed": int(ds.nodes.is_seed.sum()),
        "total_kzt": round(ds.total_kzt, 2),
        "period": ds.period,
        "n_no_edges": int(len(gids - in_edges)),
        "n_no_edges_seed": int(len((gids - in_edges) & ds.seed_gids)),
        "depth_counts": {int(k): int(v) for k, v in
                         ds.nodes.depth.value_counts().sort_index().items()},
    }
