"""核心服务层：幂等、状态机、防重放、授权/转账分离、可信链查询。

与 Node 版 service.ts 行为一致。"""
import hashlib
import json
import uuid
from datetime import datetime, timezone

from .config import CONFIG
from .db import db
from .errors import AppError
from .money import format_min_unit
from .validation import validate_create_body
from .chain.mock import MockChain

chain = MockChain()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _content_hash(v: dict) -> str:
    canonical = json.dumps(
        {
            "requestId": v["requestId"],
            "chainId": v["chainId"],
            "fromAddress": v["fromAddress"],
            "tokenAddress": v["tokenAddress"],
            "recipients": [[r["address"], r["amountMinUnit"]] for r in v["recipients"]],
            "totalMinUnit": v["totalMinUnit"],
            "scenario": v["scenario"],
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _tx_dto(row) -> dict:
    return {
        "id": row["id"],
        "batchId": row["batch_id"],
        "type": row["type"],
        "txHash": row["tx_hash"],
        "status": row["status"],
        "recheckCount": row["recheck_count"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def to_batch_dto(row) -> dict:
    txs = db.execute(
        "SELECT * FROM txs WHERE batch_id = ? ORDER BY created_at ASC", (row["id"],)
    ).fetchall()
    return {
        "id": row["id"],
        "requestId": row["request_id"],
        "chainId": row["chain_id"],
        "fromAddress": row["from_address"],
        "tokenAddress": row["token_address"],
        "recipients": json.loads(row["recipients_json"]),
        "totalMinUnit": row["total_min_unit"],
        "totalDisplay": format_min_unit(int(row["total_min_unit"])),
        "scenario": row["scenario"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "txs": [_tx_dto(t) for t in txs],
    }


def _get_batch_row(batch_id: str):
    row = db.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
    if not row:
        raise AppError(404, "BATCH_NOT_FOUND", "批次不存在")
    return row


def create_batch(body) -> dict:
    ok, result = validate_create_body(body)
    if not ok:
        raise AppError(422, "VALIDATION_ERROR", "输入校验未通过", result)
    v = result
    content_hash = _content_hash(v)

    existing = db.execute("SELECT * FROM batches WHERE request_id = ?", (v["requestId"],)).fetchone()
    if existing:
        if existing["content_hash"] != content_hash:
            raise AppError(409, "IDEMPOTENCY_CONFLICT", "相同 requestId 不能用于不同内容的批次")
        return {"batch": to_batch_dto(existing), "reused": True}

    batch_id = str(uuid.uuid4())
    ts = _now()
    try:
        db.execute(
            """INSERT INTO batches
               (id, request_id, content_hash, chain_id, from_address, token_address,
                recipients_json, total_min_unit, scenario, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                batch_id, v["requestId"], content_hash, v["chainId"], v["fromAddress"],
                v["tokenAddress"], json.dumps(v["recipients"], separators=(",", ":")),
                v["totalMinUnit"], v["scenario"], "UNSUBMITTED", ts, ts,
            ),
        )
        db.commit()
    except Exception:
        db.rollback()
        raced = db.execute("SELECT * FROM batches WHERE request_id = ?", (v["requestId"],)).fetchone()
        if raced:
            if raced["content_hash"] != content_hash:
                raise AppError(409, "IDEMPOTENCY_CONFLICT", "相同 requestId 不能用于不同内容的批次")
            return {"batch": to_batch_dto(raced), "reused": True}
        raise
    return {"batch": to_batch_dto(_get_batch_row(batch_id)), "reused": False}


def get_batch(batch_id: str) -> dict:
    return to_batch_dto(_get_batch_row(batch_id))


def list_batches() -> list:
    rows = db.execute("SELECT * FROM batches ORDER BY created_at DESC").fetchall()
    return [to_batch_dto(r) for r in rows]


def preflight(batch_id: str, account: str, network: str) -> dict:
    row = _get_batch_row(batch_id)
    batch = to_batch_dto(row)

    if network != row["chain_id"]:
        raise AppError(409, "NETWORK_CHANGED", f"网络已变化：批次要求 {row['chain_id']}，当前为 {network}")
    current_account = chain.current_account(account, batch["scenario"])
    if current_account.lower() != account.strip().lower():
        raise AppError(409, "ACCOUNT_CHANGED", "当前账户与批次付款账户不一致，请重新核对")
    if account.strip().lower() != row["from_address"].lower():
        raise AppError(409, "ACCOUNT_CHANGED", "钱包账户已变化，请重新核对批次")

    required = int(row["total_min_unit"])
    balance = chain.get_balance(row["from_address"])
    allowance = chain.get_allowance(row["from_address"], CONFIG["spender"])
    return {
        "balanceMinUnit": str(balance),
        "balanceDisplay": format_min_unit(balance),
        "allowanceMinUnit": str(allowance),
        "allowanceDisplay": format_min_unit(allowance),
        "requiredMinUnit": str(required),
        "requiredDisplay": format_min_unit(required),
        "sufficientBalance": balance >= required,
        "sufficientAllowance": allowance >= required,
        "needsApproval": allowance < required,
        "spender": CONFIG["spender"],
        "token": CONFIG["token"]["address"],
        "disperseAddress": CONFIG["disperseAddress"],
        "scenario": batch["scenario"],
    }


def _has_active_tx(batch_id: str, tx_type: str) -> bool:
    row = db.execute(
        "SELECT 1 FROM txs WHERE batch_id = ? AND type = ? AND status IN ('PENDING','UNCERTAIN') LIMIT 1",
        (batch_id, tx_type),
    ).fetchone()
    return bool(row)


def _latest_tx(batch_id: str, tx_type: str):
    return db.execute(
        "SELECT * FROM txs WHERE batch_id = ? AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        (batch_id, tx_type),
    ).fetchone()


def _assert_account_network(row, account: str, network: str, scenario: str):
    if network != row["chain_id"]:
        raise AppError(409, "NETWORK_CHANGED", f"网络已变化：批次要求 {row['chain_id']}，当前为 {network}")
    chain_account = chain.current_account(account, scenario)
    if chain_account.lower() != account.strip().lower():
        raise AppError(409, "ACCOUNT_CHANGED", "检测到钱包账户已变化，旧确认已作废，请重新核对")
    if account.strip().lower() != row["from_address"].lower():
        raise AppError(409, "ACCOUNT_CHANGED", "钱包账户与批次付款账户不一致，旧确认已作废")


def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def submit_approve(batch_id: str, account: str, network: str) -> dict:
    row = _get_batch_row(batch_id)
    scenario = row["scenario"]
    _assert_account_network(row, account, network, scenario)

    if _has_active_tx(batch_id, "APPROVE"):
        raise AppError(409, "APPROVE_IN_FLIGHT", "已有授权交易待确认或结果不确定，请查询结果，勿重复发起")
    approved = chain.get_allowance(row["from_address"], CONFIG["spender"])
    if approved >= int(row["total_min_unit"]):
        raise AppError(409, "APPROVE_NOT_NEEDED", "当前授权额度已足够，无需重复授权")

    payload = json.dumps(
        {
            "batch": batch_id, "type": "APPROVE", "token": CONFIG["token"]["address"],
            "spender": CONFIG["spender"], "amount": row["total_min_unit"],
        },
        separators=(",", ":"),
    )
    submitted = chain.submit_transaction("APPROVE", scenario, _sha256_hex(payload))
    ts = _now()
    db.execute(
        """INSERT INTO txs (id, batch_id, type, tx_hash, status, scenario, recheck_count, created_at, updated_at)
           VALUES (?, ?, 'APPROVE', ?, 'PENDING', ?, 0, ?, ?)""",
        (str(uuid.uuid4()), batch_id, submitted["txHash"], scenario, ts, ts),
    )
    db.execute("UPDATE batches SET status = 'AWAITING_WALLET', updated_at = ? WHERE id = ?", (ts, batch_id))
    db.commit()
    return {"txHash": submitted["txHash"], "status": submitted["status"], "type": "APPROVE"}


def submit_transfer(batch_id: str, account: str, network: str) -> dict:
    row = _get_batch_row(batch_id)
    scenario = row["scenario"]
    _assert_account_network(row, account, network, scenario)

    if _has_active_tx(batch_id, "TRANSFER"):
        raise AppError(409, "TRANSFER_IN_FLIGHT", "已有转账交易待确认或结果不确定，禁止重复发送；请查询原交易结果")

    approve_tx = _latest_tx(batch_id, "APPROVE")
    if not approve_tx or approve_tx["status"] != "CONFIRMED":
        raise AppError(409, "APPROVE_NOT_CONFIRMED", "授权交易尚未确认成功，不能发送转账")

    allowance = chain.get_allowance(row["from_address"], CONFIG["spender"])
    required = int(row["total_min_unit"])
    if allowance < required:
        raise AppError(409, "ALLOWANCE_INSUFFICIENT", "授权额度不足")
    if chain.get_balance(row["from_address"]) < required:
        raise AppError(409, "BALANCE_INSUFFICIENT", "代币余额不足")
    if not CONFIG["disperseAddress"]:
        raise AppError(500, "TARGET_NOT_CONFIGURED", "批量转账目标未配置")

    recipients = json.loads(row["recipients_json"])
    payload = json.dumps(
        {
            "batch": batch_id, "type": "TRANSFER", "token": CONFIG["token"]["address"],
            "target": CONFIG["disperseAddress"],
            "recipients": [[r["address"], r["amountMinUnit"]] for r in recipients],
            "total": row["total_min_unit"], "value": "0",
        },
        separators=(",", ":"),
    )
    submitted = chain.submit_transaction("TRANSFER", scenario, _sha256_hex(payload))
    ts = _now()
    db.execute(
        """INSERT INTO txs (id, batch_id, type, tx_hash, status, scenario, recheck_count, created_at, updated_at)
           VALUES (?, ?, 'TRANSFER', ?, 'PENDING', ?, 0, ?, ?)""",
        (str(uuid.uuid4()), batch_id, submitted["txHash"], scenario, ts, ts),
    )
    db.execute("UPDATE batches SET status = 'SUBMITTED_PENDING', updated_at = ? WHERE id = ?", (ts, batch_id))
    db.commit()
    return {"txHash": submitted["txHash"], "status": submitted["status"], "type": "TRANSFER"}


TERMINAL = ("CONFIRMED", "FAILED", "REJECTED")


def recheck(batch_id: str, tx_type: str) -> dict:
    row = _get_batch_row(batch_id)
    scenario = row["scenario"]
    tx = _latest_tx(batch_id, tx_type)
    if not tx:
        label = "授权" if tx_type == "APPROVE" else "转账"
        raise AppError(404, "TX_NOT_FOUND", f"该批次尚无{label}交易")

    if tx["status"] in TERMINAL:
        return {"tx": _tx_dto(tx), "batch": to_batch_dto(row), "reason": "交易已处于终态"}

    result = chain.query_transaction(tx["tx_hash"], tx_type, scenario, tx["recheck_count"])
    ts = _now()
    db.execute(
        "UPDATE txs SET status = ?, recheck_count = recheck_count + 1, updated_at = ? WHERE id = ?",
        (result["status"], ts, tx["id"]),
    )

    batch_status = None
    if tx_type == "APPROVE":
        if result["status"] == "CONFIRMED":
            chain.apply_allowance(row["from_address"], CONFIG["spender"], int(row["total_min_unit"]))
        if result["status"] == "REJECTED":
            batch_status = "REJECTED"
        elif result["status"] == "FAILED":
            batch_status = "FAILED"
    else:
        if result["status"] == "CONFIRMED":
            batch_status = "CONFIRMED"
        elif result["status"] == "FAILED":
            batch_status = "FAILED"
        elif result["status"] == "REJECTED":
            batch_status = "REJECTED"
        elif result["status"] == "UNCERTAIN":
            batch_status = "UNCERTAIN"
    if batch_status:
        db.execute("UPDATE batches SET status = ?, updated_at = ? WHERE id = ?", (batch_status, ts, batch_id))
    db.commit()

    return {
        "tx": _tx_dto(_latest_tx(batch_id, tx_type)),
        "batch": to_batch_dto(_get_batch_row(batch_id)),
        "reason": result["reason"],
    }


def reset_chain():
    chain.reset()
