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


class DataError(Exception):
    """Данные не найдены или неполны — сообщаем это словами, а не трейсбеком."""


REQUIRED_FILES = ("edges.parquet", "nodes.parquet", "transactions.parquet")


def check_files(data_dir: Path) -> None:
    if not data_dir.is_dir():
        raise DataError(
            f"папка с данными не найдена: {data_dir}\n"
            f"      укажите путь к выгрузке организаторов, например: "
            f"--data case/data")
    missing = [f for f in REQUIRED_FILES if not (data_dir / f).is_file()]
    if missing:
        raise DataError(
            f"в папке {data_dir} не хватает файлов: {', '.join(missing)}\n"
            f"      ожидаются все три: {', '.join(REQUIRED_FILES)}")


def load(data_dir: Path) -> Dataset:
    check_files(data_dir)
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
    дальше нельзя — лучше остановиться с внятным сообщением на запуске, чем
    отдать выгрузку, посчитанную по битым данным.

    Всё, что делает результат неверным, останавливает прогон (`DataError`).
    Всё, что лишь странно, но поддаётся расчёту, выводится предупреждением:
    решать, доверять ли таким данным, должен аналитик, а не пайплайн.
    """
    if ds.nodes.empty:
        raise DataError("nodes.parquet пуст: ни одного клиента, считать нечего")
    if not ds.nodes.gid.is_unique:
        dup = int(ds.nodes.gid.duplicated().sum())
        raise DataError(f"gid в nodes.parquet не уникален: {dup} повторов")

    # одна строка на пару плательщик→получатель (схема из ТЗ). Дубли опаснее
    # падения: при сборке графа второе ребро молча затрёт первое, и часть
    # оборота исчезнет из расчёта незаметно
    dup_pairs = int(ds.edges.duplicated(subset=["src", "dst"]).sum())
    if dup_pairs:
        raise DataError(
            f"edges.parquet содержит {dup_pairs} повторов пары src→dst; "
            f"ожидается одна строка на пару, суммы уже агрегированы за период")

    missing = (set(ds.edges.src) | set(ds.edges.dst)) - set(ds.nodes.gid)
    if missing:
        raise DataError(
            f"в edges.parquet есть {len(missing)} gid, которых нет в nodes.parquet, "
            f"например {sorted(missing)[:3]}")

    agg = (ds.tx.groupby(["src", "dst"])
             .agg(s=("sum_kzt", "sum"), c=("sum_kzt", "size")).reset_index())
    m = ds.edges.merge(agg, on=["src", "dst"], how="outer", indicator=True)
    if not (m._merge == "both").all():
        only_e = int((m._merge == "left_only").sum())
        only_t = int((m._merge == "right_only").sum())
        raise DataError(
            f"edges.parquet и transactions.parquet не сходятся по парам: "
            f"{only_e} пар только в рёбрах, {only_t} только в транзакциях")

    # пары сошлись — проверяем, что сходятся и величины. На выгрузке
    # организаторов расхождение суммы не превышает 6e-11 (ошибка округления
    # float), поэтому допуск в одну копейку безопасен, а несходящееся
    # количество переводов означает битые данные: метрики «сумма против
    # числа переводов» на них считать нельзя
    bad_sum = int(((m.sum_kzt - m.s).abs() > 0.01).sum())
    bad_cnt = int((m.n_tx != m.c).sum())
    if bad_sum or bad_cnt:
        raise DataError(
            f"edges.parquet и transactions.parquet расходятся в величинах: "
            f"{bad_sum} пар с разной суммой, {bad_cnt} пар с разным числом "
            f"переводов; ожидается, что рёбра — агрегат транзакций")

    warnings = []
    bad_sum = int((ds.edges.sum_kzt <= 0).sum())
    if bad_sum:
        warnings.append(
            f"{bad_sum} рёбер с суммой не больше нуля — доля пропуска и "
            f"осевшие суммы у этих узлов посчитаются, но смысла не имеют")
    loops = int((ds.edges.src == ds.edges.dst).sum())
    if loops:
        warnings.append(
            f"{loops} переводов клиента самому себе — учтены и во входящих, "
            f"и в исходящих, доля пропуска у таких узлов завышена")
    if ds.edges.empty:
        warnings.append("рёбер нет вовсе: все узлы получат роль peripheral")
    if not ds.nodes.is_seed.any():
        warnings.append("нет ни одного seed: приоритет посчитается без "
                        "компоненты связи с известными клиентами")

    gids = set(ds.nodes.gid)
    in_edges = set(ds.edges.src) | set(ds.edges.dst)
    return {
        "warnings": warnings,
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
