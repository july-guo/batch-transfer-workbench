"""SQLite 持久化（标准库 sqlite3），表结构与 Node 版一致。"""

import os
import sqlite3
from pathlib import Path

_db_path = os.environ.get("DB_PATH") or str(Path.cwd() / "data" / "workbench_py.db")
if _db_path != ":memory:":
    Path(_db_path).parent.mkdir(parents=True, exist_ok=True)

db = sqlite3.connect(_db_path, check_same_thread=False)
db.row_factory = sqlite3.Row

db.executescript(
    """
    CREATE TABLE IF NOT EXISTS batches (
        id              TEXT PRIMARY KEY,
        request_id      TEXT NOT NULL UNIQUE,
        content_hash    TEXT NOT NULL,
        chain_id        TEXT NOT NULL,
        from_address    TEXT NOT NULL,
        token_address   TEXT NOT NULL,
        recipients_json TEXT NOT NULL,
        total_min_unit  TEXT NOT NULL,
        scenario        TEXT NOT NULL,
        status          TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS txs (
        id            TEXT PRIMARY KEY,
        batch_id      TEXT NOT NULL,
        type          TEXT NOT NULL,
        tx_hash       TEXT NOT NULL UNIQUE,
        status        TEXT NOT NULL,
        scenario      TEXT NOT NULL,
        recheck_count INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_txs_batch ON txs(batch_id, type);
    """
)
db.commit()
