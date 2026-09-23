"""Приоритет проверки: «кого из 2248 смотреть первым и почему».

priority_score = взвешенная сумма шести компонент, каждая в [0,1], затем
нормировка на максимум по графу. Компоненты — перцентили наблюдаемых
величин, поэтому скор не зависит от абсолютного масштаба выгрузки.

    money             0.25  перцентиль max(in_kzt, out_kzt)
    in_concentration  0.18  перцентиль in_deg — сколько плательщиков сходится
    structure         0.14  среднее перцентилей betweenness и pagerank
    seed_link         0.12  прямая связь с известными следствию клиентами
    retention         0.09  перцентиль осевшей суммы
    role              0.12  вес роли в иерархии группы × уверенность в роли
    timing            0.10  временные паттерны (см. patterns.py): сквозной транзит,
                            синхронный сбор в один день, дробление сумм

Отдельное решение: 81 seed-клиент следствию УЖЕ известен, инструмент нужен,
чтобы показать невидимую часть сети (ТЗ: «фокус проверки смещается с 81
курьера на реальные точки консолидации»). Поэтому итоговый скор seed
умножается на KNOWN_SEED_DISCOUNT = 0.5. Seed при этом не исчезают из
выгрузок и остаются на схеме.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C
from . import patterns
from .fmt import money as _m, pct as _pt, n_payers, n_receivers

KNOWN_SEED_DISCOUNT = 0.5

COMPONENT_LABELS = {
    "money": "объём потока",
    "in_concentration": "число плательщиков",
    "structure": "позиция в сети",
    "seed_link": "связь с известными клиентами",
    "retention": "осевшая сумма",
    "role": "роль в структуре",
    "timing": "поведение во времени",
}


def compute(df: pd.DataFrame) -> pd.DataFrame:
    money = df[["in_kzt", "out_kzt"]].max(axis=1)
    comp = pd.DataFrame(index=df.index)
    comp["money"] = money.rank(pct=True)
    comp["in_concentration"] = df.in_deg.rank(pct=True)
    comp["structure"] = (df.betweenness.rank(pct=True) + df.pagerank.rank(pct=True)) / 2
    comp["seed_link"] = np.minimum(
        1.0, 0.5 * (df.n_seed_payers > 0) + 0.5 * np.minimum(df.n_seed_payers, 4) / 4)
    comp["retention"] = df.retained_kzt.rank(pct=True)
    comp["role"] = (df.role.map(C.ROLE_PRIORITY_WEIGHT).fillna(0.05) *
                    (0.5 + 0.5 * df.role_score))
    comp["timing"] = df.timing_score.fillna(0.0)

    raw = sum(C.PRIORITY_WEIGHTS[k] * comp[k] for k in C.PRIORITY_WEIGHTS)
    raw = raw * np.where(df.is_seed, KNOWN_SEED_DISCOUNT, 1.0)
    score = (raw / raw.max()).clip(0, 1)

    out = pd.DataFrame({"gid": df.gid, "priority_score": score.round(4)})
    for k in comp:
        out[f"pc_{k}"] = comp[k].round(3)
    out["why"] = [_why(df.loc[i], comp.loc[i], score.loc[i]) for i in df.index]
    return out


def _why(f: pd.Series, c: pd.Series, s: float) -> str:
    """Обоснование позиции в топ-листе: что именно вытолкнуло узел наверх."""
    contrib = {k: C.PRIORITY_WEIGHTS[k] * c[k] for k in C.PRIORITY_WEIGHTS}
    top = sorted(contrib, key=contrib.get, reverse=True)[:3]
    # у каждой причины указываем, в какие верхние проценты графа попал узел
    drivers = ", ".join(
        f"{COMPONENT_LABELS[k]} (верхние {max(1, round(100 * (1 - c[k])))}%)"
        if k != "role" else f"{COMPONENT_LABELS[k]} ({f.role})"
        for k in top)

    facts = []
    if f.in_deg:
        seed_part = f" (seed: {int(f.n_seed_payers)})" if f.n_seed_payers else ""
        facts.append(f"вход {_m(f.in_kzt)} KZT от {n_payers(f.in_deg)}{seed_part}")
    if f.out_deg:
        facts.append(f"выход {_m(f.out_kzt)} KZT на {n_receivers(f.out_deg)}")
    if f.retained_kzt > 0:
        facts.append(f"осело {_m(f.retained_kzt)} KZT")
    if f.role == "transit" and not pd.isna(f.pass_through):
        facts.append(f"пропуск {_pt(f.pass_through)}")
    if f.unseen_inflow_kzt > 0:
        facts.append(f"{_m(f.unseen_inflow_kzt)} KZT пришло вне выборки")
    if f.terminal_status == "unknown_truncated":
        facts.append(f"обход обрезан, P(конечный)={f.terminal_p:.2f}")
    tnote = patterns.note(f)
    if tnote:
        facts.append(tnote)
    if f.is_seed:
        facts.append("seed — следствию уже известен, приоритет снижен вдвое")

    return f"{'; '.join(facts)}. Поднят по: {drivers}"[:300]


def top_nodes(df: pd.DataFrame, n: int = 30) -> pd.DataFrame:
    t = (df.sort_values(["priority_score", "gid"], ascending=[False, True])
           .head(n).reset_index(drop=True))
    t.insert(0, "rank", np.arange(1, len(t) + 1))
    return t[["rank", "gid", "role", "priority_score", "why",
              "cluster_id", "role_score", "rule_id"]]
