"""Формат чисел и слов для обоснований.

Обоснование читает человек — аналитик и жюри, поэтому «11 перевода» и
«на 1 получателей» недопустимы, как и сырые 4500000.0 вместо «4.5 млн».
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def money(x) -> str:
    """Сумма человекочитаемо: 4500000 → «4.5 млн», 53000 → «53 тыс.»."""
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "0"
    if x >= 1_000_000:
        return f"{x / 1_000_000:.1f} млн".replace(".0 млн", " млн")
    if x >= 1_000:
        return f"{x / 1_000:.0f} тыс."
    return f"{x:.0f}"


def pct(x) -> str:
    if x is None or (isinstance(x, float) and np.isnan(x)) or pd.isna(x):
        return "—"
    return f"{100 * x:.0f}%"


def plural(n: int, one: str, few: str, many: str) -> str:
    """Согласование существительного с числом по правилам русского языка."""
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def n_tx(n: int) -> str:
    return f"{int(n)} {plural(n, 'перевод', 'перевода', 'переводов')}"


def n_payers(n: int) -> str:
    """Родительный падеж: «от 1 плательщика», «от 4 плательщиков»."""
    return f"{int(n)} {plural(n, 'плательщика', 'плательщиков', 'плательщиков')}"


def n_payers_nom(n: int) -> str:
    """Именительный падеж: «сходятся 4 плательщика», «7 плательщиков в один день»."""
    return f"{int(n)} {plural(n, 'плательщик', 'плательщика', 'плательщиков')}"


def n_receivers(n: int) -> str:
    return f"{int(n)} {plural(n, 'получателя', 'получателей', 'получателей')}"


def n_inflows(n: int) -> str:
    return f"{int(n)} {plural(n, 'поступление', 'поступления', 'поступлений')}"


def n_days(x) -> str:
    if x is None or pd.isna(x):
        return "0 дн."
    return f"{x:.0f} дн."
