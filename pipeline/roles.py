"""Присвоение ролей: формальные правила с порогами из распределений.

Главное требование кейса (must have 3): по любому названному gid команда
за минуту объясняет, почему роль именно такая. Поэтому:

* правило каждой роли — набор неравенств над измеренными признаками;
* пороги берутся как КВАНТИЛИ наблюдаемых распределений, а не подбираются
  под желаемый ответ; сами значения пишутся в `out/thresholds.json`;
* правила применяются в фиксированном порядке приоритета, порядок — часть метода;
* для seed действует отдельная ветка: у них входящие суммы занижены
  (граф собран ОТ них), поэтому pass_through для seed не используется.

Порядок приоритета правил (первое сработавшее побеждает):

    0. нет рёбер в выгрузке        → peripheral
    1. веер получателей            → distributor
    2. сходимость плательщиков     → consolidator
    3. пропуск средств дальше      → transit
    4. деньги остались             → terminal
    5. иначе                       → peripheral

Затем отдельным проходом выделяется coordinator — узел, стоящий НАД точками
сбора: его плательщики сами являются consolidator/distributor, либо он
получает напрямую от двух и более seed при высокой посреднической позиции.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C


# ------------------------------------------------------------------ пороги

def thresholds(df: pd.DataFrame) -> dict:
    """Пороги = квантили наблюдаемых распределений. Считаются на прогоне."""
    in_deg_t = int(np.ceil(df.in_deg.quantile(C.Q_CONSOLIDATOR_IN_DEG)))
    out_deg_t = int(np.ceil(df.out_deg.quantile(C.Q_DISTRIBUTOR_OUT_DEG)))
    materiality = float(df.loc[df.in_kzt > 0, "in_kzt"].quantile(C.Q_MATERIALITY))
    money_t = float(df[["in_kzt", "out_kzt"]].max(axis=1).quantile(C.Q_MONEY))
    in_money_t = float(df.in_kzt.quantile(C.Q_MONEY))
    betw_t = float(df.betweenness.quantile(C.Q_BETWEENNESS))
    return {
        "in_deg_consolidator": {
            "value": max(in_deg_t, 3),
            "правило": f"in_deg >= квантиль {C.Q_CONSOLIDATOR_IN_DEG} распределения in_deg",
            "смысл": "«много разных плательщиков» = верхние 2.5% узлов графа",
        },
        "out_deg_distributor": {
            "value": max(out_deg_t, 8),
            "правило": f"out_deg >= квантиль {C.Q_DISTRIBUTOR_OUT_DEG} распределения out_deg",
            "смысл": "«веерная рассылка» = верхние 2.5% узлов графа",
        },
        "materiality_kzt": {
            "value": round(materiality, 2),
            "правило": f"медиана in_kzt среди узлов с поступлениями",
            "смысл": "ниже этой суммы узел не характеризует структуру группы",
        },
        "money_high_kzt": {
            "value": round(money_t, 2),
            "правило": f"квантиль {C.Q_MONEY} от max(in_kzt, out_kzt)",
            "смысл": "«крупный оборот» = верхние 5% узлов",
        },
        "in_money_high_kzt": {
            "value": round(in_money_t, 2),
            "правило": f"квантиль {C.Q_MONEY} распределения in_kzt",
            "смысл": "«на узел сходятся крупные деньги» = верхние 5% по поступлениям",
        },
        "betweenness_high": {
            "value": round(betw_t, 8),
            "правило": f"квантиль {C.Q_BETWEENNESS} betweenness",
            "смысл": "«узел стоит между» = верхний 1% по посредничеству",
        },
        "transit_pass_through": {
            "value": [C.TRANSIT_PT_LOW, C.TRANSIT_PT_HIGH],
            "правило": f"{C.TRANSIT_PT_LOW} <= out_kzt/in_kzt <= {C.TRANSIT_PT_HIGH}",
            "смысл": "деньги прошли дальше практически в полном объёме",
        },
        "terminal_p_min": {
            "value": C.TERMINAL_P_MIN,
            "правило": "terminal_p >= 0.70 для узлов, обрезанных 4-м коленом",
            "смысл": "не объявляем конечным того, чьи исходящие никто не выгружал",
        },
    }


# ------------------------------------------------------------------ формат

def _m(x: float) -> str:
    """Деньги человекочитаемо."""
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "0"
    if x >= 1_000_000:
        return f"{x / 1_000_000:.1f} млн".replace(".0 млн", " млн")
    if x >= 1_000:
        return f"{x / 1_000:.0f} тыс."
    return f"{x:.0f}"


def _pt(x) -> str:
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "—"
    return f"{100 * x:.0f}%"


# ------------------------------------------------------------------ правила

def assign(df: pd.DataFrame, th: dict) -> pd.DataFrame:
    """Возвращает таблицу gid, role, role_score, evidence, rule_id."""
    T_IN = th["in_deg_consolidator"]["value"]
    T_OUT = th["out_deg_distributor"]["value"]
    MAT = th["materiality_kzt"]["value"]

    role = pd.Series("peripheral", index=df.index, dtype=object)
    score = pd.Series(0.5, index=df.index, dtype=float)
    rule = pd.Series("R5.peripheral", index=df.index, dtype=object)
    ev = pd.Series("", index=df.index, dtype=object)

    pt = df.pass_through
    fast = df.get("fast_out_share", pd.Series(np.nan, index=df.index)).fillna(0.0)
    hold = df.get("hold_days_median", pd.Series(np.nan, index=df.index))
    is_seed = df.is_seed.to_numpy()

    # --- 0. узлы без рёбер ---------------------------------------------------
    no_edges = (df.in_deg == 0) & (df.out_deg == 0)

    # --- 1. distributor: веерная рассылка -----------------------------------
    m_dist = (df.out_deg >= T_OUT) & ~no_edges

    # --- 2. consolidator: сходимость многих плательщиков в немногие выходы ---
    fan_ok = df.out_deg <= np.maximum(2, C.CONSOLIDATOR_FANOUT_RATIO * df.in_deg)
    m_cons = (df.in_deg >= T_IN) & fan_ok & ~m_dist & ~no_edges

    # --- 3. transit: деньги прошли дальше ------------------------------------
    pt_band = pt.between(C.TRANSIT_PT_LOW, C.TRANSIT_PT_HIGH)
    fast_transit = (fast >= 0.6) & (pt >= 0.6)
    # для seed pass_through неинформативен (ловушка 2) — только исходящий профиль
    m_trans = (~m_dist & ~m_cons & ~no_edges & (df.out_deg >= 1) &
               (((pt_band | fast_transit) & ~df.is_seed) |
                (df.is_seed & (df.out_deg >= 1))))

    # --- 4. terminal: деньги пришли и остались -------------------------------
    # Роль определяется ПОВЕДЕНИЕМ (получил и не отправил), а не размером суммы;
    # материальность влияет на role_score и на приоритет, но не на роль.
    observed_sink = df.terminal_status == "observed_sink"
    trunc = df.terminal_status == "unknown_truncated"
    m_term = (~m_dist & ~m_cons & ~m_trans & ~no_edges & (df.in_kzt > 0) &
              (observed_sink | (trunc & (df.terminal_p >= C.TERMINAL_P_MIN))))

    # --- применяем в порядке приоритета -------------------------------------
    role[m_dist] = "distributor"
    rule[m_dist] = f"R1.distributor: out_deg >= {T_OUT}"
    score[m_dist] = np.clip(0.5 * df.loc[m_dist, "out_deg"] / T_OUT, 0.5, 1.0)

    role[m_cons] = "consolidator"
    rule[m_cons] = f"R2.consolidator: in_deg >= {T_IN} и out_deg <= max(2, in_deg/2)"
    base = np.clip(0.5 * df.loc[m_cons, "in_deg"] / T_IN, 0.5, 1.0)
    keeps = (df.loc[m_cons, "pass_through"].fillna(0.0) <= 0.2)
    score[m_cons] = np.minimum(1.0, base + 0.1 * keeps)

    role[m_trans] = "transit"
    rule[m_trans] = (f"R3.transit: pass_through в [{C.TRANSIT_PT_LOW}, {C.TRANSIT_PT_HIGH}] "
                     f"либо >=60% исходящих в пределах {C.FAST_TRANSIT_DAYS} суток")
    tr_pt = pt[m_trans]
    tr_score = np.where(
        tr_pt.between(C.TRANSIT_PT_LOW, C.TRANSIT_PT_HIGH),
        1.0 - 0.5 * (tr_pt - 1.0).abs() / 0.2,
        0.5 + 0.2 * fast[m_trans])
    # у seed вход занижен: уверенность в роли ограничиваем
    tr_score = np.where(df.loc[m_trans, "is_seed"], 0.55, tr_score)
    score[m_trans] = np.clip(np.nan_to_num(tr_score, nan=0.5), 0.4, 1.0)

    role[m_term] = "terminal"
    # подтверждённый наблюдением сток: 0.9, если сумма материальна, иначе 0.65;
    # обрезанный обходом: уверенность равна вероятности по модели
    term_score = np.where(
        observed_sink[m_term],
        np.where(df.loc[m_term, "in_kzt"] >= MAT, 0.9, 0.65),
        df.loc[m_term, "terminal_p"])
    score[m_term] = term_score
    rule[m_term] = np.where(
        observed_sink[m_term],
        "R4.terminal: out_deg = 0 при наблюдаемых исходящих (depth <= 3)",
        f"R4.terminal: обрезан 4-м коленом, terminal_p >= {C.TERMINAL_P_MIN}")

    score[no_edges] = 0.3
    rule[no_edges] = "R0.peripheral: нет рёбер в выгрузке"

    out = pd.DataFrame({"gid": df.gid, "role": role, "role_score": score, "rule_id": rule})

    # --- 5. coordinator: уровень НАД точками сбора --------------------------
    out = _coordinator_pass(df, out, th)

    # --- обоснования --------------------------------------------------------
    out["evidence"] = [
        _evidence(df.loc[i], out.loc[i], th) for i in df.index
    ]
    out["role_score"] = out.role_score.astype(float).round(3)
    return out


def _coordinator_pass(df: pd.DataFrame, out: pd.DataFrame, th: dict) -> pd.DataFrame:
    """Координатор — не «самый крупный», а тот, кто стоит НАД сборщиками.

    Формально, три условия одновременно:

    1. иерархия: узел получает минимум от двух ПЛАТЕЛЬЩИКОВ-СБОРЩИКОВ — то есть
       от узлов, которые сами собирают деньги от in_deg >= порога сходимости, —
       либо напрямую минимум от двух seed;
    2. деньги: поступления в верхних 5% распределения in_kzt (одной иерархии
       мало: получателей от веерных рассылок много, и они не организаторы);
    3. не seed: 81 нижнее звено следствию уже известно, и входящие суммы у них
       занижены по устройству выгрузки — «кандидатом в организаторы» такой узел
       на этих данных обосновать нельзя.

    Правило намеренно узкое: оно даёт список кандидатов на проверку, а не вывод
    о роли в группе.
    """
    IN_MONEY = th["in_money_high_kzt"]["value"]
    T_IN = th["in_deg_consolidator"]["value"]
    # «сборщик» определяется структурно, по сходимости плательщиков, а не по роли:
    # так критерий не зависит от порядка присвоения ролей
    collectors = set(df.loc[df.in_deg >= T_IN, "gid"])

    n_upstream = df.payer_set.apply(lambda s: len(s & collectors)).astype(int)
    df["n_collector_payers"] = n_upstream.to_numpy()

    m = (~df.is_seed & (df.in_kzt >= IN_MONEY) &
         ((n_upstream >= C.COORDINATOR_MIN_UPSTREAM) |
          (df.n_seed_payers >= C.COORDINATOR_MIN_SEED_PAYERS)))

    out.loc[m, "role"] = "coordinator"
    out.loc[m, "role_score"] = np.clip(
        0.6 + 0.1 * np.minimum(n_upstream[m], 3) + 0.1 * (df.loc[m, "n_seed_payers"] >= 2),
        0.6, 1.0)
    out.loc[m, "rule_id"] = (
        f"R6.coordinator: >= {C.COORDINATOR_MIN_UPSTREAM} плательщиков-сборщиков "
        f"(in_deg >= {T_IN}) либо >= {C.COORDINATOR_MIN_SEED_PAYERS} seed-плательщиков, "
        f"при in_kzt в топ-5% ({_m(IN_MONEY)} KZT) и не seed")
    return out


# ------------------------------------------------------------------ evidence

def _evidence(f: pd.Series, r: pd.Series, th: dict) -> str:
    """Человекочитаемое обоснование с числами, до 200 символов."""
    role = r.role
    seed_note = f", из них seed: {int(f.n_seed_payers)}" if f.n_seed_payers else ""

    if role == "coordinator":
        s = (f"получает {_m(f.in_kzt)} KZT (топ-5% графа) от {int(f.in_deg)} "
             f"плательщиков{seed_note}; {int(f.get('n_collector_payers', 0))} из них "
             f"сами собирают от {th['in_deg_consolidator']['value']}+ плательщиков; "
             f"отдаёт дальше {_pt(f.pass_through)}")
    elif role == "consolidator":
        s = (f"сходятся {int(f.in_deg)} плательщиков{seed_note} на {int(f.out_deg)} выход(а); "
             f"получено {_m(f.in_kzt)} KZT, отдано дальше {_pt(f.pass_through)}, "
             f"осело {_m(f.retained_kzt)} KZT")
    elif role == "distributor":
        s = (f"веер на {int(f.out_deg)} получателей, {int(f.out_tx)} переводов "
             f"на {_m(f.out_kzt)} KZT")
        if f.is_seed:
            s += "; seed — входящие извне выборки не видны"
        elif f.unseen_inflow_kzt > 0:
            s += f"; отдал на {_m(f.unseen_inflow_kzt)} KZT больше, чем получил в выборке"
    elif role == "transit":
        if f.is_seed:
            s = (f"seed: отдаёт {_m(f.out_kzt)} KZT на {int(f.out_deg)} получателей; "
                 f"входящие извне выборки не видны, роль по исходящему профилю")
        else:
            hold = f.get("hold_days_median")
            hold_s = "" if pd.isna(hold) else f", деньги лежат {hold:.0f} дн."
            s = (f"пропускает {_pt(f.pass_through)} полученного: вход {_m(f.in_kzt)} KZT "
                 f"от {int(f.in_deg)}, выход {_m(f.out_kzt)} KZT на {int(f.out_deg)}{hold_s}")
    elif role == "terminal":
        if f.terminal_status == "observed_sink":
            s = (f"получил {_m(f.in_kzt)} KZT ({int(f.in_tx)} перевод(ов)) от "
                 f"{int(f.in_deg)} плательщиков{seed_note} и не отправил дальше 0 KZT; "
                 f"колено {int(f.depth)} — исходящие проверены обходом")
        else:
            s = (f"получил {_m(f.in_kzt)} KZT от {int(f.in_deg)}; обход обрезан 4-м коленом, "
                 f"вероятность что конечный {f.terminal_p:.2f} по модели на коленах 1-3")
    else:  # peripheral
        if f.in_deg == 0 and f.out_deg == 0:
            s = ("0 входящих и 0 исходящих переводов в выгрузке: seed без рёбер, "
                 "переводы либо ниже порога 5 000 KZT, либо вне банка — роль не определяется")
        elif f.terminal_status == "unknown_truncated":
            s = (f"получил {_m(f.in_kzt)} KZT от {int(f.in_deg)}; обход обрезан 4-м коленом, "
                 f"вероятность что конечный {f.terminal_p:.2f} — роль не присваиваем")
        else:
            s = (f"вход {_m(f.in_kzt)} KZT от {int(f.in_deg)}, выход {_m(f.out_kzt)} KZT "
                 f"на {int(f.out_deg)} — ниже порогов ролей "
                 f"(порог сбора {th['in_deg_consolidator']['value']} плательщиков, "
                 f"веера {th['out_deg_distributor']['value']} получателей)")
    return s[:200]
