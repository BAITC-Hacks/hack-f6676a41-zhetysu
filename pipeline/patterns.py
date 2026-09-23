"""Временные паттерны: сквозной транзит, синхронный сбор, дробление сумм.

Это опциональная часть ТЗ (п. 8), и она даёт то, чего структура графа не видит:
два узла с одинаковыми суммами и степенями ведут себя по-разному, если у одного
деньги лежали две недели, а у другого ушли в тот же день.

Три признака, все — с порогом из распределения или прямо из ТЗ:

* `flag_fast_transit` — сквозной транзит: медианное время удержания не больше
  двух суток (формулировка ТЗ «пришло и ушло в течение 1–2 дней») И не менее
  60% исходящей суммы ушло в этом окне. Одного медианного значения мало:
  узел может быстро отдать мелочь и придержать основную сумму.

* `flag_sync_collection` — синхронный сбор: в один день на узел заплатили
  `max_same_day_payers >= порог` разных плательщиков. Порог — квантиль 0.95
  распределения этой величины среди узлов с двумя и более плательщиками.
  Случайные бытовые переводы так не совпадают по дате.

* `flag_structuring` — дробление: один плательщик сделал за один день
  `max_same_day_one_payer_tx >= порог` переводов (квантиль 0.99 — верхний 1%
  графа), либо число поступлений в верхних 5% при среднем размере перевода в
  нижней четверти распределения. Второй вариант ловит дробление, растянутое
  по дням, а не собранное в один.

Признаки не создают новых ролей: они входят в `evidence`, в компоненту
`timing` приоритета и выгружаются отдельными полями, чтобы аналитик мог
отфильтровать узлы по поведению во времени.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C
from .fmt import n_days, n_inflows, n_payers_nom, n_tx


def thresholds(df: pd.DataFrame) -> dict:
    multi = df.loc[df.in_deg >= 2, "max_same_day_payers"]
    sync_t = int(np.ceil(multi.quantile(0.95))) if len(multi) else 3
    split_t = int(np.ceil(df.max_same_day_one_payer_tx.quantile(0.99)))
    in_tx_t = int(np.ceil(df.in_tx.quantile(0.95)))
    small_t = float(df.avg_in_tx_kzt.quantile(0.25))
    return {
        "sync_same_day_payers": {
            "value": max(sync_t, 3),
            "правило": "max_same_day_payers >= квантиль 0.95 (узлы с 2+ плательщиками)",
            "смысл": "в один день заплатили несколько разных плательщиков — синхронный сбор",
        },
        "structuring_same_day_tx": {
            "value": max(split_t, 3),
            "правило": "max_same_day_one_payer_tx >= квантиль 0.99 распределения",
            "смысл": "один плательщик дробит сумму на несколько переводов за день",
        },
        "structuring_in_tx": {
            "value": max(in_tx_t, 5),
            "правило": "in_tx >= квантиль 0.95 при avg_in_tx_kzt <= квантиль 0.25",
            "смысл": "много мелких поступлений — дробление, растянутое по дням",
        },
        "structuring_avg_kzt": {
            "value": round(small_t, 2),
            "правило": "квантиль 0.25 распределения среднего размера поступления",
            "смысл": "«мелкий перевод» относительно графа",
        },
        "fast_transit_days": {
            "value": C.FAST_TRANSIT_DAYS,
            "правило": f"hold_days_median <= {C.FAST_TRANSIT_DAYS} и fast_out_share >= 0.6",
            "смысл": "сквозной транзит: пришло и ушло в пределах двух суток (ТЗ, п. 8)",
        },
    }


def flags(df: pd.DataFrame, th: dict) -> pd.DataFrame:
    hold = df.hold_days_median
    fast = df.fast_out_share.fillna(0.0)

    f_fast = (hold <= th["fast_transit_days"]["value"]) & (fast >= 0.6)
    f_sync = df.max_same_day_payers >= th["sync_same_day_payers"]["value"]
    f_split = ((df.max_same_day_one_payer_tx >= th["structuring_same_day_tx"]["value"]) |
               ((df.in_tx >= th["structuring_in_tx"]["value"]) &
                (df.avg_in_tx_kzt <= th["structuring_avg_kzt"]["value"])))

    out = pd.DataFrame({
        "gid": df.gid,
        "flag_fast_transit": f_fast.fillna(False).astype(bool),
        "flag_sync_collection": f_sync.fillna(False).astype(bool),
        "flag_structuring": f_split.fillna(False).astype(bool),
    })

    # непрерывные оценки каждого признака в [0,1] — для компоненты timing
    sync_t = th["sync_same_day_payers"]["value"]
    split_t = th["structuring_same_day_tx"]["value"]
    out["sync_score"] = np.clip(
        (df.max_same_day_payers - 1) / max(sync_t - 1, 1), 0, 1).fillna(0.0)
    out["fast_score"] = np.where(f_fast.fillna(False), fast, 0.0)
    out["split_score"] = np.clip(
        (df.max_same_day_one_payer_tx - 1) / max(split_t - 1, 1), 0, 1).fillna(0.0)
    out["timing_score"] = out[["sync_score", "fast_score", "split_score"]].max(axis=1)
    return out


def note(f: pd.Series) -> str:
    """Короткая приписка к evidence — только по сработавшим признакам."""
    bits = []
    if f.get("flag_sync_collection"):
        bits.append(f"{n_payers_nom(f.max_same_day_payers)} в один день")
    if f.get("flag_fast_transit"):
        bits.append(f"сквозной транзит за {n_days(f.get('hold_days_median'))} "
                    f"({100 * f.fast_out_share:.0f}% суммы)")
    if f.get("flag_structuring"):
        if f.max_same_day_one_payer_tx >= 3:
            bits.append(f"дробление: {n_tx(f.max_same_day_one_payer_tx)} "
                        f"от одного плательщика за день")
        else:
            bits.append(f"дробление: {n_inflows(f.in_tx)} по "
                        f"{f.avg_in_tx_kzt / 1000:.0f} тыс. в среднем")
    return "; ".join(bits)
