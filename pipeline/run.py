"""Единая точка входа ядра анализа.

    python -m pipeline.run --data case/data --out out

Один запуск, без ручных шагов: сырые parquet → метрики → модель обрыва обхода
→ роли → кластеры → приоритеты → четыре файла в out/.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import pandas as pd

from . import (censoring, clusters, config, data, export, features, graphbuild,
               priority, roles)


def log(msg: str) -> None:
    print(msg, flush=True)


def build_all(data_dir: Path, out_dir: Path) -> dict:
    t0 = time.perf_counter()

    log("[1/7] загрузка данных")
    ds = data.load(data_dir)
    stats = data.sanity(ds)
    log(f"      узлов {stats['n_nodes']}, рёбер {stats['n_edges']}, "
        f"транзакций {stats['n_tx']}, seed {stats['n_seed']}, "
        f"оборот {stats['total_kzt']:,.0f} KZT")
    log(f"      узлов без рёбер: {stats['n_no_edges']} "
        f"(seed среди них: {stats['n_no_edges_seed']})")

    log("[2/7] сборка направленного взвешенного графа")
    G, UG = graphbuild.build(ds)

    log("[3/7] метрики узлов (структура, деньги, время)")
    feats = features.build(G, ds)

    log("[4/7] модель обрыва обхода: настоящие конечные vs обрезанные 4-м коленом")
    cens, cens_report = censoring.estimate(feats)
    feats = feats.merge(cens, on="gid", how="left")
    log(f"      обрезано обходом: {cens_report['обрезанных_узлов']}, "
        f"из них ожидаемо настоящих конечных: "
        f"{cens_report['ожидаемое_число_настоящих_конечных_среди_обрезанных']}")
    log(f"      AUC модели: in-sample {cens_report['обучение']['auc_insample']}, "
        f"cv5 {cens_report['обучение']['auc_cv5']}, "
        f"колено 3 (out-of-depth) {cens_report['валидация_по_коленам']['auc']}")

    log("[5/7] роли по формальным правилам с порогами из распределений")
    th = roles.thresholds(feats)
    role_tab = roles.assign(feats, th)
    nodes = feats.merge(role_tab, on="gid", how="left")
    log("      пороги: " + ", ".join(
        f"{k}={v['value']}" for k, v in th.items() if not isinstance(v["value"], list)))
    log("      роли: " + ", ".join(
        f"{k}={v}" for k, v in nodes.role.value_counts().items()))

    log("[6/7] кластеры (Louvain на неориентированной проекции) и приоритеты")
    nodes["cluster_id"] = clusters.detect(UG, nodes)
    prio = priority.compute(nodes)
    nodes = nodes.merge(prio, on="gid", how="left")
    cl_tab = clusters.summarize(nodes, ds.edges)
    top = priority.top_nodes(nodes, n=30)
    log(f"      кластеров: {len(cl_tab)}, "
        f"крупнейший: {int(cl_tab.n_nodes.max())} узлов, "
        f"кластеров с 2+ seed: {int((cl_tab.n_seed >= 2).sum())}")

    log("[7/7] выгрузки")
    elapsed = round(time.perf_counter() - t0, 2)
    export.write_csv(nodes, cl_tab, top, out_dir)
    export.write_graph_json(
        nodes, ds.edges, cl_tab, top,
        {"period": ds.period, "thresholds": th, "censoring": _cens_brief(cens_report),
         "pipeline_seconds": elapsed},
        out_dir)
    export.write_method_artifacts(th, cens_report, out_dir)

    checks = verify(nodes, cl_tab, top, out_dir, stats)
    log(f"      готово за {elapsed} с → {out_dir}/nodes_roles.csv, clusters.csv, "
        f"top_nodes.csv, graph.json")
    return {"elapsed": elapsed, "checks": checks}


def _cens_brief(r: dict) -> dict:
    return {
        "метод": r["модель"],
        "признаки": r["признаки"],
        "обрезанных_узлов": r["обрезанных_узлов"],
        "ожидаемо_настоящих_конечных": r["ожидаемое_число_настоящих_конечных_среди_обрезанных"],
        "auc_out_of_depth": r["валидация_по_коленам"]["auc"],
        "порог_роли_terminal": r["решение"],
    }


def verify(nodes, cl_tab, top, out_dir: Path, stats: dict) -> dict:
    """Самопроверка выгрузок — то же, что будет проверять жюри механически."""
    n = pd.read_csv(out_dir / "nodes_roles.csv")
    checks = {
        "nodes_roles.csv строк == 2248": len(n) == 2248,
        "gid уникален": n.gid.is_unique,
        "роль у каждого узла": n.role.notna().all() and (n.role != "").all(),
        "роли только из словаря": set(n.role) <= set(config.ROLES),
        "role_score в [0,1]": n.role_score.between(0, 1).all(),
        "priority_score в [0,1]": n.priority_score.between(0, 1).all(),
        "cluster_id у каждого узла": n.cluster_id.notna().all(),
        "evidence непустой": (n.evidence.fillna("").str.len() > 0).all(),
        "evidence содержит числа": n.evidence.str.contains(r"\d").all(),
        "evidence <= 200 символов": (n.evidence.str.len() <= 200).all(),
        "clusters.csv непустой": len(cl_tab) > 0,
        "гипотеза у каждого кластера": (cl_tab.hypothesis.str.len() > 0).all(),
        "top_nodes.csv >= 20 строк": len(top) >= 20,
        "top отсортирован по приоритету": top.priority_score.is_monotonic_decreasing,
        "все кластеры узлов есть в clusters.csv":
            set(n.cluster_id) == set(cl_tab.cluster_id),
    }
    bad = [k for k, v in checks.items() if not v]
    log("      самопроверка: " + ("все пункты пройдены" if not bad
                                  else "ПРОВАЛЕНО → " + "; ".join(bad)))
    return checks


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Граф денег — ядро анализа")
    ap.add_argument("--data", default="case/data", help="папка с parquet-файлами")
    ap.add_argument("--out", default="out", help="куда писать выгрузки")
    a = ap.parse_args(argv)

    res = build_all(Path(a.data), Path(a.out))
    if not all(res["checks"].values()):
        return 1
    if res["elapsed"] > 300:
        log(f"ВНИМАНИЕ: прогон занял {res['elapsed']} с — больше лимита ТЗ (300 с)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
