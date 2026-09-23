"""Вопрос словами → ответ по графу со ссылками на узлы.

Устройство намеренно двухслойное:

1. **Поиск по графу — детерминированный.** Вопрос разбирается правилами, ответ
   считается по данным. Ни одна цифра в ответе не приходит от языковой модели,
   поэтому ответ нельзя выдумать.
2. **Языковая модель — только формулировка.** Если задан OPENAI_API_KEY, она
   переписывает готовый ответ человеческим языком. Ключа нет — отдаётся тот же
   ответ, собранный шаблоном.

Проверяющему не нужны наши ключи: без них работает всё, кроме литературности.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

ROLE_LABELS = {
    "consolidator": "точка консолидации",
    "transit": "транзит",
    "distributor": "распределитель",
    "terminal": "конечный получатель",
    "coordinator": "координатор",
    "peripheral": "периферия",
}


class Graph:
    """Граф в памяти: узлы, связи в обе стороны, кластеры, топ-лист."""

    def __init__(self, path: Path):
        doc = json.loads(path.read_text(encoding="utf8"))
        self.meta = doc["meta"]
        self.nodes = {n["gid"]: n for n in doc["nodes"]}
        self.clusters = {c["cluster_id"]: c for c in doc["clusters"]}
        self.top = doc["top_nodes"]
        self.out: dict[str, list[dict]] = {}
        self.inc: dict[str, list[dict]] = {}
        for e in doc["edges"]:
            self.out.setdefault(e["src"], []).append(e)
            self.inc.setdefault(e["dst"], []).append(e)

    def senders(self, gid: str) -> list[dict]:
        return sorted(self.inc.get(gid, []), key=lambda e: -e["sum_kzt"])

    def receivers(self, gid: str) -> list[dict]:
        return sorted(self.out.get(gid, []), key=lambda e: -e["sum_kzt"])


def money(v: float) -> str:
    if v >= 1e9:
        return f"{v / 1e9:.1f} млрд ₸"
    if v >= 1e6:
        return f"{v / 1e6:.1f} млн ₸"
    if v >= 1e3:
        return f"{v / 1e3:.0f} тыс. ₸"
    return f"{v:.0f} ₸"


def node_line(g: Graph, gid: str) -> str:
    n = g.nodes[gid]
    return (f"{gid} — {ROLE_LABELS.get(n['role'], n['role'])}, "
            f"приоритет {n['priority_score']:.2f}")


# ─────────────────────────────────────────────────────────── разбор вопроса

GID_RE = re.compile(r"\b\d{10,20}\b")


def find_gids(q: str, g: Graph) -> list[str]:
    return [x for x in GID_RE.findall(q) if x in g.nodes]


def find_role(q: str) -> str | None:
    ql = q.lower()
    for key, label in ROLE_LABELS.items():
        if key in ql or label.split()[0] in ql:
            return key
    if "собира" in ql or "консолид" in ql:
        return "consolidator"
    if "организатор" in ql or "координат" in ql:
        return "coordinator"
    if "прогон" in ql or "транзит" in ql:
        return "transit"
    if "оседа" in ql or "остают" in ql or "конечн" in ql:
        return "terminal"
    if "рассыла" in ql or "веер" in ql or "распредел" in ql:
        return "distributor"
    return None


def answer(g: Graph, q: str) -> dict[str, Any]:
    """Возвращает готовый ответ: текст, список узлов, пояснение источника."""
    ql = q.lower().strip()
    gids = find_gids(q, g)

    # 1. Общие получатели нескольких плательщиков: «кто собирает деньги с этих пятерых»
    if len(gids) >= 2 and any(w in ql for w in ("собира", "сходят", "общ", "куда", "получа")):
        counter: dict[str, dict] = {}
        for gid in gids:
            for e in g.receivers(gid):
                c = counter.setdefault(e["dst"], {"from": set(), "sum": 0.0})
                c["from"].add(gid)
                c["sum"] += e["sum_kzt"]
        common = sorted(
            ((k, v) for k, v in counter.items() if len(v["from"]) >= 2),
            key=lambda kv: (-len(kv[1]["from"]), -kv[1]["sum"]),
        )
        if not common:
            return {
                "text": f"Ни один узел не получает переводы больше чем от одного из перечисленных "
                        f"{len(gids)} клиентов. Общей точки сбора у них в этих данных нет.",
                "nodes": [], "source": "обход исходящих рёбер перечисленных узлов",
            }
        lines = []
        for gid, v in common[:5]:
            lines.append(f"{node_line(g, gid)}: получает от {len(v['from'])} из перечисленных, "
                         f"суммарно {money(v['sum'])}")
        return {
            "text": "Деньги перечисленных клиентов сходятся на этих узлах:\n" + "\n".join(lines),
            "nodes": [k for k, _ in common[:5]],
            "source": "пересечение исходящих переводов указанных узлов",
        }

    # 2. Один конкретный клиент
    if len(gids) == 1:
        gid = gids[0]
        n = g.nodes[gid]
        recv, send = g.receivers(gid), g.senders(gid)
        if "куда" in ql or "кому" in ql or "отправ" in ql:
            if not recv:
                return {"text": f"{gid} не имеет исходящих переводов в выгрузке.",
                        "nodes": [gid], "source": "исходящие рёбра узла"}
            lines = [f"{e['dst']} — {money(e['sum_kzt'])} за {e['n_tx']} перевод(ов)" for e in recv[:6]]
            return {"text": f"{gid} отправляет деньги {len(recv)} получателям:\n" + "\n".join(lines),
                    "nodes": [gid] + [e["dst"] for e in recv[:6]],
                    "source": "исходящие рёбра узла"}
        if "откуда" in ql or "кто платит" in ql or "получ" in ql:
            if not send:
                return {"text": f"У {gid} нет входящих переводов в выгрузке.",
                        "nodes": [gid], "source": "входящие рёбра узла"}
            lines = [f"{e['src']} — {money(e['sum_kzt'])} за {e['n_tx']} перевод(ов)" for e in send[:6]]
            return {"text": f"{gid} получает деньги от {len(send)} плательщиков:\n" + "\n".join(lines),
                    "nodes": [gid] + [e["src"] for e in send[:6]],
                    "source": "входящие рёбра узла"}
        return {
            "text": (f"{gid} — {ROLE_LABELS.get(n['role'], n['role'])}"
                     f"{' (исходный клиент из списка следствия)' if n.get('is_seed') else ''}. "
                     f"{n['evidence']} Приоритет проверки {n['priority_score']:.2f}, "
                     f"кластер {n['cluster_id']}, колено {n['depth']}."),
            "nodes": [gid],
            "source": f"карточка узла, правило {n.get('rule_id', '—')}",
        }

    # 3. Приоритеты
    if any(w in ql for w in ("первым", "приоритет", "с кого", "кого смотреть", "топ")):
        lines = [f"{i['rank']}. {i['gid']} — {ROLE_LABELS.get(i['role'], i['role'])}: {i['why']}"
                 for i in g.top[:5]]
        return {"text": "Первыми стоит смотреть:\n" + "\n".join(lines),
                "nodes": [i["gid"] for i in g.top[:5]],
                "source": "топ-лист приоритетов"}

    # 4. Роль: сколько и кто
    role = find_role(ql)
    if role:
        found = [n for n in g.nodes.values() if n["role"] == role]
        found.sort(key=lambda n: -n["priority_score"])
        lines = [f"{n['gid']} — {n['evidence']}" for n in found[:5]]
        return {"text": f"Роль «{ROLE_LABELS[role]}» присвоена {len(found)} узлам. "
                        f"Самые приоритетные:\n" + "\n".join(lines),
                "nodes": [n["gid"] for n in found[:5]],
                "source": "выгрузка ролей"}

    # 5. Кластеры
    if "кластер" in ql or "групп" in ql or "сообществ" in ql:
        cl = sorted(g.clusters.values(), key=lambda c: -c["n_nodes"])[:5]
        lines = [f"Кластер {c['cluster_id']}: {c['n_nodes']} узлов, seed {c['n_seed']}, "
                 f"внутренний оборот {money(c['sum_kzt_internal'])} — {c['hypothesis']}" for c in cl]
        return {"text": "Крупнейшие сообщества сети:\n" + "\n".join(lines),
                "nodes": [gid for c in cl for gid in c["top_gids"][:2]],
                "source": "выгрузка кластеров"}

    # 6. Не поняли — честно говорим и подсказываем на примерах из этого же графа
    first = g.top[0]["gid"] if g.top else next(iter(g.nodes), "")
    pair = example_payers(g)
    collect = f"«кто собирает деньги с {pair[0]} и {pair[1]}», " if pair else ""
    return {
        "text": ("Не понял вопрос. Спросите, например: «кого смотреть первым», "
                 f"{collect}«куда уходят деньги от {first}», «покажи координаторов», "
                 "«какие есть кластеры»."),
        "nodes": [], "source": None,
    }


def example_payers(g: Graph) -> tuple[str, str] | None:
    """Два плательщика с общим получателем — пример, на который есть ответ."""
    for item in g.top:
        payers = [e["src"] for e in g.senders(item["gid"])]
        if len(payers) >= 2:
            return payers[0], payers[1]
    return None


# ─────────────────────────────────────────────── необязательная формулировка

def polish(text: str, question: str) -> tuple[str, str]:
    """Переписать ответ человеческим языком. Без ключа — вернуть как есть."""
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return text, "правила"
    try:
        import urllib.request

        body = json.dumps({
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content":
                    "Ты помощник AML-аналитика. Перепиши готовый ответ связным русским языком. "
                    "НЕ добавляй фактов и не меняй ни одной цифры и ни одного идентификатора. "
                    "Формулируй как признаки для проверки, а не как утверждение о виновности. "
                    "Коротко, без вступлений."},
                {"role": "user", "content": f"Вопрос: {question}\n\nОтвет по данным:\n{text}"},
            ],
            "temperature": 0.2,
        }).encode()
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions", data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=12) as r:
            out = json.loads(r.read())["choices"][0]["message"]["content"].strip()
        return (out, "модель") if out else (text, "правила")
    except Exception:
        # Модель недоступна — ответ уже посчитан, отдаём его.
        return text, "правила"
