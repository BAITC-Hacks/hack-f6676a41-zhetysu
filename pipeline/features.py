"""Метрики узлов: структурные, денежные и временные.

Здесь нет ролей — только измеримые признаки. Каждый признак назван так,
чтобы аналитик без ML-образования понимал, что он означает.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import networkx as nx

from .config import FAST_TRANSIT_DAYS
from .data import Dataset


# ------------------------------------------------------------------ структура

def structural(G: nx.DiGraph, ds: Dataset) -> pd.DataFrame:
    df = ds.nodes[["gid", "depth", "is_seed"]].copy()
    df["gid"] = df.gid.astype("int64")

    maps = {
        "in_deg": dict(G.in_degree()),
        "out_deg": dict(G.out_degree()),
        "in_kzt": dict(G.in_degree(weight="sum_kzt")),
        "out_kzt": dict(G.out_degree(weight="sum_kzt")),
        "in_tx": dict(G.in_degree(weight="n_tx")),
        "out_tx": dict(G.out_degree(weight="n_tx")),
    }
    for col, m in maps.items():
        df[col] = df.gid.map(m).fillna(0)
    for col in ("in_deg", "out_deg", "in_tx", "out_tx"):
        df[col] = df[col].astype(int)

    # PageRank по сумме — влияние узла в потоке денег
    df["pagerank"] = df.gid.map(nx.pagerank(G, weight="sum_kzt")).fillna(0.0)
    # HITS: authority — «сборщик», hub — «источник рассылки»
    # HITS решается через собственные векторы и на графе без рёбер падает
    # внутри scipy (ARPACK: «starting vector is zero»). Для вырожденного графа
    # хаб и авторитет не определены — ставим нули, роли от них не зависят.
    try:
        hubs, auth = nx.hits(G, max_iter=1000, normalized=True)
    except Exception:
        hubs = auth = {g: 0.0 for g in G.nodes}
    # hub/authority неотрицательны по определению; у мелких значений остаётся
    # численный шум порядка 1e-19, из-за которого два прогона давали разные
    # байты в выгрузке — отсекаем, чтобы результат был строго воспроизводим
    df["hub"] = df.gid.map(hubs).fillna(0.0).clip(lower=0.0).round(10)
    df["authority"] = df.gid.map(auth).fillna(0.0).clip(lower=0.0).round(10)
    # Посредничество: сколько кратчайших путей движения денег идёт через узел.
    # Считаем на ненагруженном направленном графе — интерпретация «сколько
    # цепочек проходит через узел», а не «сколько тенге».
    df["betweenness"] = df.gid.map(
        nx.betweenness_centrality(G, weight=None)).fillna(0.0)

    # доля полученного, ушедшая дальше; NaN у узлов без входящих
    df["pass_through"] = np.where(df.in_kzt > 0,
                                  df.out_kzt / df.in_kzt.replace(0, np.nan), np.nan)
    # сколько денег осело в узле (в пределах выборки)
    df["retained_kzt"] = (df.in_kzt - df.out_kzt).clip(lower=0.0)
    # ЛОВУШКА 2: узел отдал больше, чем получил по данным. Это не аномалия,
    # а невидимое поступление извне выборки (граф собран только по исходящим).
    df["unseen_inflow_kzt"] = (df.out_kzt - df.in_kzt).clip(lower=0.0)

    # ЛОВУШКА 1: формальный признак обрыва обхода (без вывода о роли)
    df["truncated_by_depth"] = (df.depth == 4) & (df.out_deg == 0)

    # средние размеры перевода — суммы и количество переводов разные сигналы
    df["avg_in_tx_kzt"] = np.where(df.in_tx > 0, df.in_kzt / df.in_tx.replace(0, np.nan), np.nan)
    df["avg_out_tx_kzt"] = np.where(df.out_tx > 0, df.out_kzt / df.out_tx.replace(0, np.nan), np.nan)

    # сколько плательщиков узла — seed (известные следствию клиенты)
    seed = ds.seed_gids
    e = ds.edges
    sp = e[e.src.isin(seed)].groupby("dst").src.nunique()
    df["n_seed_payers"] = df.gid.map(sp).fillna(0).astype(int)
    # сколько получателей узла — seed (возвратный поток к известным клиентам)
    sr = e[e.dst.isin(seed)].groupby("src").dst.nunique()
    df["n_seed_receivers"] = df.gid.map(sr).fillna(0).astype(int)

    # концентрация входящих по сумме (HHI): 1.0 — весь вход от одного плательщика
    def hhi(g, by, val):
        s = g.groupby(by)[val].sum()
        tot = s.sum()
        return float(((s / tot) ** 2).sum()) if tot > 0 else np.nan
    # на пустом наборе рёбер groupby().apply() возвращает не Series, а пустой
    # DataFrame, и map() по нему падает — поэтому вырожденный случай отдельно
    if e.empty:
        in_hhi = out_hhi = pd.Series(dtype=float)
    else:
        in_hhi = e.groupby("dst").apply(lambda g: hhi(g, "src", "sum_kzt"),
                                        include_groups=False)
        out_hhi = e.groupby("src").apply(lambda g: hhi(g, "dst", "sum_kzt"),
                                         include_groups=False)
    df["in_hhi"] = df.gid.map(in_hhi)
    df["out_hhi"] = df.gid.map(out_hhi)

    # крупнейшее входящее и исходящее ребро
    df["max_in_edge_kzt"] = df.gid.map(e.groupby("dst").sum_kzt.max()).fillna(0.0)
    df["max_out_edge_kzt"] = df.gid.map(e.groupby("src").sum_kzt.max()).fillna(0.0)

    # профиль ПЛАТЕЛЬЩИКОВ узла. Важно: для узла 4-го колена плательщики лежат
    # на 3-м колене и измерены полностью, поэтому эти признаки доступны и там,
    # где собственные исходящие переводы узла не выгружались (см. censoring.py).
    out_deg_map = df.set_index("gid").out_deg
    w = e.assign(p_out=e.src.map(out_deg_map).fillna(0))
    pagg = w.groupby("dst").agg(payer_out_deg_max=("p_out", "max"),
                                payer_out_deg_mean=("p_out", "mean"))
    df["payer_out_deg_max"] = df.gid.map(pagg.payer_out_deg_max).fillna(0.0)
    df["payer_out_deg_mean"] = df.gid.map(pagg.payer_out_deg_mean).fillna(0.0)
    # какая доля поступлений пришла от «веерных» плательщиков: если платил узел,
    # рассылающий на десятки адресов, получатель чаще оказывается листом цепочки
    fan_t = float(df.out_deg.quantile(0.975))
    if e.empty:
        fan_share = pd.Series(dtype=float)
    else:
        w2 = w.assign(x=w.sum_kzt * (w.p_out >= fan_t))
        fan_share = w2.groupby("dst").apply(
            lambda g: g.x.sum() / g.sum_kzt.sum() if g.sum_kzt.sum() else np.nan,
            include_groups=False)
    df["fan_payer_share"] = df.gid.map(fan_share)

    # взаимные пары (A->B и B->A) и участие в коротком цикле — возвратные потоки
    mutual = {u for u, v in G.edges() if G.has_edge(v, u)}
    df["mutual_pair"] = df.gid.isin(mutual)
    in_cycle: set[int] = set()
    for cyc in nx.simple_cycles(G, length_bound=6):
        in_cycle.update(cyc)
    df["in_cycle"] = df.gid.isin(in_cycle)

    # достижимость вниз по потоку: сколько узлов ниже и сколько денег под узлом
    reach = {}
    for gid in G.nodes:
        reach[gid] = len(nx.descendants(G, gid))
    df["downstream_nodes"] = df.gid.map(reach).fillna(0).astype(int)

    # размер слабой компоненты и признак точки сочленения (устойчивость сети)
    comp_of, comp_size = {}, {}
    for comp in nx.weakly_connected_components(G):
        for gid in comp:
            comp_of[gid] = min(comp)
            comp_size[gid] = len(comp)
    df["component_size"] = df.gid.map(comp_size).fillna(1).astype(int)
    UGs = nx.Graph(G)
    cuts = set(nx.articulation_points(UGs)) if UGs.number_of_edges() else set()
    df["is_articulation"] = df.gid.isin(cuts)
    return df


# ------------------------------------------------------------------- время

def temporal(ds: Dataset) -> pd.DataFrame:
    """Временные признаки по transactions.parquet.

    hold_days_median — сколько в среднем деньги лежали на счёте: для каждого
    исходящего перевода берётся ближайшее предшествующее поступление.
    Малое значение при высоком pass_through — признак сквозного транзита.
    """
    tx = ds.tx
    day_end = tx.date.max()

    inc = tx[["dst", "src", "date", "sum_kzt"]].rename(columns={"dst": "gid", "src": "cp"})
    out = tx[["src", "dst", "date", "sum_kzt"]].rename(columns={"src": "gid", "dst": "cp"})

    rows = []
    in_by = {g: v.sort_values("date") for g, v in inc.groupby("gid")}
    out_by = {g: v.sort_values("date") for g, v in out.groupby("gid")}

    for gid in set(in_by) | set(out_by):
        gi = in_by.get(gid)
        go = out_by.get(gid)
        r = {"gid": gid}

        if gi is not None:
            r["first_in_date"] = gi.date.min()
            r["last_in_date"] = gi.date.max()
            r["days_after_last_in"] = int((day_end - gi.date.max()).days)
            # синхронные поступления: максимум разных плательщиков в один день
            per_day = gi.groupby("date").cp.nunique()
            r["max_same_day_payers"] = int(per_day.max())
            r["n_in_days"] = int(gi.date.nunique())
            # дробление: максимум переводов от одного плательщика за один день
            r["max_same_day_one_payer_tx"] = int(
                gi.groupby(["date", "cp"]).size().max())
        if go is not None:
            r["first_out_date"] = go.date.min()
            r["last_out_date"] = go.date.max()
            per_day_o = go.groupby("date").cp.nunique()
            r["max_same_day_receivers"] = int(per_day_o.max())
            r["n_out_days"] = int(go.date.nunique())

        # время удержания
        if gi is not None and go is not None:
            in_dates = gi.date.to_numpy()
            holds, fast_sum, tot_sum = [], 0.0, 0.0
            for d, amount in zip(go.date.to_numpy(), go.sum_kzt.to_numpy()):
                prev = in_dates[in_dates <= d]
                tot_sum += float(amount)
                if len(prev):
                    h = (d - prev[-1]) / np.timedelta64(1, "D")
                    holds.append(float(h))
                    if h <= FAST_TRANSIT_DAYS:
                        fast_sum += float(amount)
            if holds:
                r["hold_days_median"] = float(np.median(holds))
                r["hold_days_min"] = float(np.min(holds))
                r["fast_out_share"] = float(fast_sum / tot_sum) if tot_sum else np.nan
        rows.append(r)

    # без транзакций временных признаков нет, но колонка gid нужна для merge
    return pd.DataFrame(rows) if rows else pd.DataFrame({"gid": pd.Series(dtype="int64")})


def build(G: nx.DiGraph, ds: Dataset) -> pd.DataFrame:
    df = structural(G, ds).merge(temporal(ds), on="gid", how="left")
    # множества контрагентов — нужны для определения координатора (второй проход)
    payers = ds.edges.groupby("dst").src.apply(set)
    receivers = ds.edges.groupby("src").dst.apply(set)
    df["payer_set"] = [payers.get(g, set()) for g in df.gid]
    df["receiver_set"] = [receivers.get(g, set()) for g in df.gid]
    # временные признаки: целочисленные получают значение по умолчанию,
    # остальные остаются пустыми. Колонки создаются даже если транзакций нет
    # вовсе — иначе дальше по конвейеру не найдётся ожидаемое поле
    for col, default in (("max_same_day_payers", 0), ("max_same_day_receivers", 0),
                         ("max_same_day_one_payer_tx", 0), ("n_in_days", 0),
                         ("n_out_days", 0), ("days_after_last_in", -1)):
        df[col] = (df[col].fillna(default).astype(int) if col in df
                   else pd.Series(default, index=df.index, dtype=int))
    for col in ("hold_days_median", "hold_days_min", "fast_out_share",
                "first_in_date", "last_in_date", "first_out_date", "last_out_date"):
        if col not in df:
            df[col] = pd.Series(pd.NA, index=df.index, dtype="object")
    return df
