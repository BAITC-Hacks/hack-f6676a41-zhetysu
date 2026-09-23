#!/usr/bin/env python3
"""Сервер демонстрации: отдаёт интерфейс и выгрузки пайплайна.

    .venv/bin/python server.py [--host 127.0.0.1] [--port 3300]

Отдаёт:
    /              — интерфейс из web/
    /out/...       — выгрузки пайплайна, в том числе graph.json
    /api/health    — состояние: есть ли выгрузки, заглушка или настоящий расчёт
"""

import argparse
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
OUT = ROOT / "out"

app = FastAPI(title="Граф денег", docs_url=None, redoc_url=None)


_graph_cache: dict = {"mtime": None, "graph": None}


def _graph():
    """Граф в памяти, перечитывается при изменении файла."""
    import ask as ask_mod

    path = OUT / "graph.json"
    if not path.exists():
        return None
    mtime = path.stat().st_mtime
    if _graph_cache["mtime"] != mtime:
        _graph_cache["graph"] = ask_mod.Graph(path)
        _graph_cache["mtime"] = mtime
    return _graph_cache["graph"]


@app.post("/api/ask")
async def api_ask(payload: dict):
    """Вопрос словами → ответ по графу. Цифры считаются по данным, не моделью."""
    import ask as ask_mod

    question = (payload or {}).get("q", "").strip()
    if not question:
        return JSONResponse({"error": "пустой вопрос"}, status_code=400)
    g = _graph()
    if g is None:
        return JSONResponse({"error": "выгрузки ещё не посчитаны"}, status_code=503)

    found = ask_mod.answer(g, question)
    text, origin = ask_mod.polish(found["text"], question)
    return JSONResponse({
        "question": question,
        "answer": text,
        "raw": found["text"],
        "nodes": found["nodes"],
        "source": found["source"],
        "phrasing": origin,
    })


@app.get("/api/health")
def health():
    """Что сейчас готово — чтобы не гадать по пустому экрану."""
    graph = OUT / "graph.json"
    state = {
        "graph_json": graph.exists(),
        "size_kb": graph.stat().st_size // 1024 if graph.exists() else 0,
        "stub": None,
        "nodes_roles_csv": (OUT / "nodes_roles.csv").exists(),
        "clusters_csv": (OUT / "clusters.csv").exists(),
        "top_nodes_csv": (OUT / "top_nodes.csv").exists(),
    }
    if graph.exists():
        try:
            state["stub"] = json.loads(graph.read_text(encoding="utf8"))["meta"].get("stub")
        except Exception as exc:  # битый или недописанный файл
            state["error"] = f"graph.json не читается: {exc}"
    return JSONResponse(state)


if OUT.exists():
    app.mount("/out", StaticFiles(directory=OUT), name="out")

if WEB.exists() and (WEB / "index.html").exists():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
else:
    @app.get("/")
    def placeholder():
        return PlainTextResponse(
            "Интерфейс ещё собирается. Выгрузки доступны по /out/, состояние — /api/health.",
            status_code=503,
        )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3300)
    a = ap.parse_args()

    import uvicorn

    uvicorn.run(app, host=a.host, port=a.port, log_level="info")
