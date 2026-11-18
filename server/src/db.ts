import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

// 通过 createRequire 动态引入 node:sqlite，避免 Vite/Vitest 在转换阶段静态解析内置模块
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'workbench.db')
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })

export const db = new DatabaseSync(dbPath)

db.exec(`
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
`)

export interface BatchRow {
  id: string
  request_id: string
  content_hash: string
  chain_id: string
  from_address: string
  token_address: string
  recipients_json: string
  total_min_unit: string
  scenario: string
  status: string
  created_at: string
  updated_at: string
}

export interface TxRow {
  id: string
  batch_id: string
  type: string
  tx_hash: string
  status: string
  scenario: string
  recheck_count: number
  created_at: string
  updated_at: string
}
