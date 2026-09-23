"""ЛОВУШКА №1: отделение настоящих конечных получателей от узлов,
«обрезанных» четвёртым коленом обхода.

Постановка. 444 узла имеют depth = 4 и out_deg = 0. Это НЕ значит, что деньги
осели: обход просто закончился на них, их исходящие переводы никто не выгружал.
Наивное правило «out_deg == 0 ⇒ terminal» даёт 444 ложных вывода — почти
четверть графа.

Что наблюдаемо, а что нет:

| depth | исходящие переводы узла запрашивались обходом? | вывод |
|---|---|---|
| 0–3, out_deg = 0 | да, и их не нашлось | конечный получатель ПОДТВЕРЖДЁН данными |
| 0–3, out_deg ≥ 1 | да | узел передаёт дальше |
| 4, out_deg = 0 | НЕТ — обход остановлен | НЕИЗВЕСТНО, нужна оценка |

Метод. Для колен 1–3 факт «есть ли исходящие» наблюдаем, поэтому на них можно
измерить, как отсутствие исходящих связано с ВХОДЯЩИМ профилем узла — а
входящий профиль у 4-го колена виден полностью. Обучаем логистическую регрессию
(6 интерпретируемых признаков, все — про входящие) на 1723 узлах колен 1–3 и
применяем к 444 обрезанным узлам, получая `terminal_p` — вероятность того, что
узел действительно конечный.

Почему перенос с колен 1–3 на 4-е допустим: доля узлов без исходящих по коленам
1, 2, 3 держится в узком коридоре (≈0.65 / 0.58 / 0.64), то есть «терминальность»
не дрейфует с глубиной. Это проверяется прямо на прогоне: модель обучается на
коленах 1–2 и проверяется на колене 3 (out-of-depth валидация), метрики
пишутся в `out/censoring_report.json`.

Что мы НЕ делаем: не объявляем обрезанные узлы конечными и не объявляем их
транзитными. Роль `terminal` обрезанный узел получает только при
`terminal_p ≥ TERMINAL_P_MIN`, и его `role_score` равен этой вероятности —
неопределённость видна аналитику, а не спрятана.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import RANDOM_SEED

# признаки только про ВХОДЯЩИЙ профиль узла и профиль его ПЛАТЕЛЬЩИКОВ —
# и то, и другое измерено полностью даже для узлов 4-го колена
FEATURES = [
    "log_in_kzt",        # сколько получил (log1p)
    "log_in_tx",         # сколько было поступлений
    "log_in_deg",        # от скольких разных плательщиков
    "log_avg_in_tx",     # средний размер поступления
    "in_hhi",            # концентрация входящих по сумме
    "days_after_last_in",  # сколько дней до конца периода оставалось после
                           # последнего поступления (успел бы передать дальше)
    "log_payer_out_deg_max",   # насколько «веерный» самый широкий плательщик
    "log_payer_out_deg_mean",  # средняя широта рассылки плательщиков
    "fan_payer_share",   # доля денег, пришедшая от веерных плательщиков
    "n_seed_payers",     # сколько плательщиков — известные следствию клиенты
]

FEATURE_LABELS = {
    "log_in_kzt": "сумма поступлений",
    "log_in_tx": "число поступлений",
    "log_in_deg": "число плательщиков",
    "log_avg_in_tx": "средний размер поступления",
    "in_hhi": "концентрация входящих",
    "days_after_last_in": "дней до конца периода после последнего поступления",
    "log_payer_out_deg_max": "широта рассылки самого веерного плательщика",
    "log_payer_out_deg_mean": "средняя широта рассылки плательщиков",
    "fan_payer_share": "доля денег от веерных плательщиков",
    "n_seed_payers": "число плательщиков-seed",
}


def _design(df: pd.DataFrame) -> pd.DataFrame:
    x = pd.DataFrame(index=df.index)
    x["log_in_kzt"] = np.log1p(df.in_kzt.fillna(0.0))
    x["log_in_tx"] = np.log1p(df.in_tx.fillna(0))
    x["log_in_deg"] = np.log1p(df.in_deg.fillna(0))
    x["log_avg_in_tx"] = np.log1p(df.avg_in_tx_kzt.fillna(0.0))
    x["in_hhi"] = df.in_hhi.fillna(1.0)
    x["days_after_last_in"] = df.days_after_last_in.clip(lower=0).fillna(0)
    x["log_payer_out_deg_max"] = np.log1p(df.payer_out_deg_max.fillna(0.0))
    x["log_payer_out_deg_mean"] = np.log1p(df.payer_out_deg_mean.fillna(0.0))
    x["fan_payer_share"] = df.fan_payer_share.fillna(0.0)
    x["n_seed_payers"] = df.n_seed_payers.fillna(0)
    return x[FEATURES]


def _fit(X: np.ndarray, y: np.ndarray, ridge: float = 1e-3, iters: int = 60):
    """Логистическая регрессия методом Ньютона (IRLS). Детерминирована."""
    n, k = X.shape
    Xb = np.hstack([np.ones((n, 1)), X])
    w = np.zeros(k + 1)
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-Xb @ w))
        W = np.clip(p * (1 - p), 1e-6, None)
        grad = Xb.T @ (y - p) - ridge * w
        H = -(Xb.T * W) @ Xb - ridge * np.eye(k + 1)
        step = np.linalg.solve(H, grad)
        w_new = w - step
        if np.max(np.abs(w_new - w)) < 1e-8:
            w = w_new
            break
        w = w_new
    return w


def _predict(w: np.ndarray, X: np.ndarray) -> np.ndarray:
    Xb = np.hstack([np.ones((X.shape[0], 1)), X])
    return 1.0 / (1.0 + np.exp(-Xb @ w))


def _auc(y: np.ndarray, p: np.ndarray) -> float:
    if len(np.unique(y)) < 2:
        return float("nan")
    order = np.argsort(p)
    ranks = np.empty(len(p), float)
    ranks[order] = np.arange(1, len(p) + 1)
    # средние ранги для совпадающих значений
    s = pd.Series(p)
    ranks = s.rank(method="average").to_numpy()
    n1, n0 = y.sum(), (1 - y).sum()
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def estimate(feats: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Возвращает (таблица с terminal_status / terminal_p, отчёт о модели)."""
    df = feats.copy()
    X_all = _design(df)

    observed = (df.depth <= 3)          # исходящие переводы запрашивались обходом
    train_mask = observed & (df.depth >= 1)   # колена 1–3: есть входящий профиль
    trunc_mask = df.truncated_by_depth

    Xtr = X_all.loc[train_mask].to_numpy(float)
    ytr = (df.loc[train_mask, "out_deg"] == 0).to_numpy(float)

    mu, sd = Xtr.mean(0), Xtr.std(0)
    sd[sd == 0] = 1.0
    w = _fit((Xtr - mu) / sd, ytr)

    p_tr = _predict(w, (Xtr - mu) / sd)
    p_all = _predict(w, (X_all.to_numpy(float) - mu) / sd)

    # --- валидация: обучаем на коленах 1–2, проверяем на колене 3 -----------
    m12 = observed & df.depth.isin([1, 2])
    m3 = df.depth == 3
    X12 = X_all.loc[m12].to_numpy(float)
    y12 = (df.loc[m12, "out_deg"] == 0).to_numpy(float)
    mu2, sd2 = X12.mean(0), X12.std(0)
    sd2[sd2 == 0] = 1.0
    w2 = _fit((X12 - mu2) / sd2, y12)
    X3 = X_all.loc[m3].to_numpy(float)
    y3 = (df.loc[m3, "out_deg"] == 0).to_numpy(float)
    p3 = _predict(w2, (X3 - mu2) / sd2)

    # --- k-fold по узлам ----------------------------------------------------
    rng = np.random.default_rng(RANDOM_SEED)
    idx = np.arange(len(ytr))
    rng.shuffle(idx)
    folds = np.array_split(idx, 5)
    cv_auc = []
    for f in folds:
        tr = np.setdiff1d(idx, f)
        mu_f, sd_f = Xtr[tr].mean(0), Xtr[tr].std(0)
        sd_f[sd_f == 0] = 1.0
        wf = _fit((Xtr[tr] - mu_f) / sd_f, ytr[tr])
        cv_auc.append(_auc(ytr[f], _predict(wf, (Xtr[f] - mu_f) / sd_f)))

    # --- статус и вероятность для каждого узла ------------------------------
    status = pd.Series("observed_forwarder", index=df.index, dtype=object)
    term_p = pd.Series(0.0, index=df.index, dtype=float)

    sink_obs = observed & (df.out_deg == 0) & ((df.in_deg > 0) | (df.out_deg > 0))
    status[sink_obs] = "observed_sink"
    term_p[sink_obs] = 1.0

    status[trunc_mask] = "unknown_truncated"
    term_p[trunc_mask] = p_all[trunc_mask.to_numpy()]

    no_edges = (df.in_deg == 0) & (df.out_deg == 0)
    status[no_edges] = "no_edges"
    term_p[no_edges] = np.nan

    out = pd.DataFrame({"gid": df.gid, "terminal_status": status,
                        "terminal_p": term_p.round(4)})

    # калибровка на обучении: предсказано vs фактически
    cal = pd.DataFrame({"p": p_tr, "y": ytr})
    cal["bin"] = pd.cut(cal.p, [0, .2, .4, .6, .8, 1.0], include_lowest=True)
    cal_tab = (cal.groupby("bin", observed=True)
                 .agg(n=("y", "size"), predicted=("p", "mean"), actual=("y", "mean"))
                 .round(3).reset_index())

    report = {
        "задача": "отделить настоящих конечных получателей от узлов, обрезанных 4-м коленом",
        "модель": (f"логистическая регрессия (IRLS, ridge=1e-3) на {len(FEATURES)} признаках "
                   f"входящего профиля узла и его плательщиков"),
        "признаки": [FEATURE_LABELS[f] for f in FEATURES],
        "коэффициенты": {"intercept": round(float(w[0]), 4),
                         **{FEATURES[i]: round(float(w[i + 1]), 4) for i in range(len(FEATURES))}},
        "обучение": {"n": int(train_mask.sum()),
                     "доля_без_исходящих": round(float(ytr.mean()), 4),
                     "auc_insample": round(_auc(ytr, p_tr), 4),
                     "auc_cv5": round(float(np.mean(cv_auc)), 4)},
        "валидация_по_коленам": {
            "обучено_на": "колена 1–2", "проверено_на": "колено 3",
            "n_test": int(m3.sum()),
            "auc": round(_auc(y3, p3), 4),
            "факт_доля_без_исходящих": round(float(y3.mean()), 4),
            "предсказано_в_среднем": round(float(p3.mean()), 4)},
        "доля_без_исходящих_по_коленам": {
            int(d): round(float((df[(df.depth == d)].out_deg == 0).mean()), 4)
            for d in (1, 2, 3)},
        "калибровка": cal_tab.astype({"bin": str}).to_dict("records"),
        "обрезанных_узлов": int(trunc_mask.sum()),
        "ожидаемое_число_настоящих_конечных_среди_обрезанных":
            int(round(float(term_p[trunc_mask].sum()))),
        "распределение_статусов": status.value_counts().to_dict(),
        "решение": ("роль terminal обрезанному узлу присваивается только при "
                    "terminal_p >= 0.70, role_score равен этой вероятности; "
                    "остальные обрезанные узлы остаются peripheral с вероятностью в evidence"),
    }
    return out, report
