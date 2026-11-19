"""FastAPI 入口：路由与 Node 版 index.ts 一一对应。"""

import os
from pathlib import Path

from fastapi import FastAPI, Request, Body
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .config import CONFIG
from .errors import AppError
from . import service

app = FastAPI(title="批量转账工作台 Python API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(AppError)
async def app_error_handler(_request: Request, exc: AppError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
    )


@app.exception_handler(Exception)
async def generic_error_handler(_request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": str(exc)}},
    )


@app.get("/api/health")
async def health():
    return {"ok": True, "mode": "MOCK"}


@app.get("/api/config")
async def config():
    return {**CONFIG, "mode": "MOCK"}


@app.post("/api/batches")
async def create_batch(body: dict = Body(...)):
    result = service.create_batch(body)
    return JSONResponse(
        status_code=200 if result["reused"] else 201,
        content={"batch": result["batch"], "reused": result["reused"]},
    )


@app.get("/api/batches")
async def list_batches():
    return {"items": service.list_batches()}


@app.get("/api/batches/{batch_id}")
async def get_batch(batch_id: str):
    return {"batch": service.get_batch(batch_id)}


def _require_account_network(body: dict) -> tuple[str, str]:
    account = body.get("account")
    network = body.get("network")
    if not account or not network:
        raise AppError(400, "MISSING_ACCOUNT_OR_NETWORK", "缺少 account 或 network")
    return account, network


@app.post("/api/batches/{batch_id}/preflight")
async def preflight(batch_id: str, body: dict = Body(...)):
    account, network = _require_account_network(body)
    return {"preflight": service.preflight(batch_id, account, network)}


@app.post("/api/batches/{batch_id}/approve")
async def approve(batch_id: str, body: dict = Body(...)):
    account, network = _require_account_network(body)
    return {"tx": service.submit_approve(batch_id, account, network)}


@app.post("/api/batches/{batch_id}/transfer")
async def transfer(batch_id: str, body: dict = Body(...)):
    account, network = _require_account_network(body)
    return {"tx": service.submit_transfer(batch_id, account, network)}


@app.post("/api/batches/{batch_id}/recheck")
async def recheck(batch_id: str, body: dict = Body(default={})):
    tx_type = body.get("type")
    if tx_type not in ("APPROVE", "TRANSFER"):
        raise AppError(400, "INVALID_TX_TYPE", "type 必须为 APPROVE 或 TRANSFER")
    return service.recheck(batch_id, tx_type)


@app.post("/api/test/reset-chain")
async def reset_chain():
    service.reset_chain()
    return {"ok": True}


# 生产模式托管前端静态文件（若已构建）
_web_dist = Path(__file__).resolve().parent.parent.parent / "web" / "dist"
if _web_dist.exists():
    from fastapi.staticfiles import StaticFiles

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        candidate = _web_dist / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_web_dist / "index.html")

    app.mount("/", StaticFiles(directory=str(_web_dist), html=True), name="static")
