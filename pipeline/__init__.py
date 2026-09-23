"""Ядро анализа кейса «Граф денег».

Пакет считает роли, кластеры и приоритеты по транзакционному графу
и пишет выгрузки в `out/`. Единая точка входа:

    python -m pipeline.run --data case/data --out out
"""

__all__ = ["config", "data", "graphbuild", "features", "censoring",
           "roles", "clusters", "priority", "export", "run"]
