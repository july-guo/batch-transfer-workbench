import { createHash, randomUUID } from 'node:crypto'
import { CONFIG } from './config.js'
import { db, type BatchRow, type TxRow } from './db.js'
import { formatMinUnit } from './money.js'
import { validateCreateBody, type ValidatedCreate } from './validation.js'
import { MockChainAdapter } from './chain/mock.js'
import { AppError, type BatchDTO, type BatchStatus, type NormalizedRecipient, type Scenario, type TxDTO, type TxStatus, type TxType } from './types.js'

export const chain = new MockChainAdapter()

const now = () => new Date().toISOString()

function contentHashOf(v: ValidatedCreate): string {
  // 规范化内容参与哈希：字段顺序固定 + 地址小写 + 金额最小单位
  const canonical = JSON.stringify({
    requestId: v.requestId,
    chainId: v.chainId,
    fromAddress: v.fromAddress,
    tokenAddress: v.tokenAddress,
    recipients: v.recipients.map((r) => [r.address, r.amountMinUnit]),
    totalMinUnit: v.totalMinUnit,
    scenario: v.scenario
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function toTxDTO(row: TxRow): TxDTO {
  return {
    id: row.id,
    batchId: row.batch_id,
    type: row.type as TxType,
    txHash: row.tx_hash,
    status: row.status as TxStatus,
    recheckCount: row.recheck_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function toBatchDTO(row: BatchRow): BatchDTO {
  const txs = (db.prepare('SELECT * FROM txs WHERE batch_id = ? ORDER BY created_at ASC').all(row.id) as unknown as TxRow[]).map(toTxDTO)
  return {
    id: row.id,
    requestId: row.request_id,
    chainId: row.chain_id,
    fromAddress: row.from_address,
    tokenAddress: row.token_address,
    recipients: JSON.parse(row.recipients_json) as NormalizedRecipient[],
    totalMinUnit: row.total_min_unit,
    totalDisplay: formatMinUnit(BigInt(row.total_min_unit)),
    scenario: row.scenario as Scenario,
    status: row.status as BatchStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    txs
  }
}

function getBatchRow(id: string): BatchRow {
  const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow | undefined
  if (!row) throw new AppError(404, 'BATCH_NOT_FOUND', '批次不存在')
  return row
}

/** 创建批次：幂等 —— 同 requestId 同内容返回原批次；同 requestId 不同内容报错 */
export function createBatch(body: unknown): { batch: BatchDTO; reused: boolean } {
  const validated = validateCreateBody(body)
  if (!validated.ok) {
    throw new AppError(422, 'VALIDATION_ERROR', '输入校验未通过', validated.errors)
  }
  const v = validated.value
  const hash = contentHashOf(v)

  const existing = db.prepare('SELECT * FROM batches WHERE request_id = ?').get(v.requestId) as BatchRow | undefined
  if (existing) {
    if (existing.content_hash !== hash) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '相同 requestId 不能用于不同内容的批次')
    }
    return { batch: toBatchDTO(existing), reused: true }
  }

  const id = randomUUID()
  const ts = now()
  try {
    db.prepare(`
      INSERT INTO batches (id, request_id, content_hash, chain_id, from_address, token_address,
                           recipients_json, total_min_unit, scenario, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, v.requestId, hash, v.chainId, v.fromAddress, v.tokenAddress,
      JSON.stringify(v.recipients), v.totalMinUnit, v.scenario, 'UNSUBMITTED', ts, ts
    )
  } catch (error) {
    // 并发下唯一键冲突：回读并按幂等语义处理
    const raced = db.prepare('SELECT * FROM batches WHERE request_id = ?').get(v.requestId) as BatchRow | undefined
    if (raced) {
      if (raced.content_hash !== hash) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '相同 requestId 不能用于不同内容的批次')
      }
      return { batch: toBatchDTO(raced), reused: true }
    }
    throw error
  }
  return { batch: toBatchDTO(getBatchRow(id)), reused: false }
}

export function getBatch(id: string): BatchDTO {
  return toBatchDTO(getBatchRow(id))
}

export function listBatches(): BatchDTO[] {
  return (db.prepare('SELECT * FROM batches ORDER BY created_at DESC').all() as unknown as BatchRow[]).map(toBatchDTO)
}

/** 预检：余额、授权额度、是否需要授权、账户/网络是否变化 */
export function preflight(id: string, account: string, network: string) {
  const row = getBatchRow(id)
  const batch = toBatchDTO(row)

  if (network !== row.chain_id) {
    throw new AppError(409, 'NETWORK_CHANGED', `网络已变化：批次要求 ${row.chain_id}，当前为 ${network}`)
  }
  const currentAccount = chain.currentAccount(account, batch.scenario)
  if (currentAccount.toLowerCase() !== account.trim().toLowerCase()) {
    throw new AppError(409, 'ACCOUNT_CHANGED', '当前账户与批次付款账户不一致，请重新核对')
  }
  if (account.trim().toLowerCase() !== row.from_address.toLowerCase()) {
    throw new AppError(409, 'ACCOUNT_CHANGED', '钱包账户已变化，请重新核对批次')
  }

  const required = BigInt(row.total_min_unit)
  const balance = chain.getBalance(row.from_address)
  const allowance = chain.getAllowance(row.from_address, CONFIG.spender)
  const sufficientBalance = balance >= required
  const sufficientAllowance = allowance >= required

  return {
    balanceMinUnit: balance.toString(),
    balanceDisplay: formatMinUnit(balance),
    allowanceMinUnit: allowance.toString(),
    allowanceDisplay: formatMinUnit(allowance),
    requiredMinUnit: required.toString(),
    requiredDisplay: formatMinUnit(required),
    sufficientBalance,
    sufficientAllowance,
    needsApproval: !sufficientAllowance,
    spender: CONFIG.spender,
    token: CONFIG.token.address,
    disperseAddress: CONFIG.disperseAddress,
    scenario: batch.scenario
  }
}

function hasActiveTx(batchId: string, type: TxType): boolean {
  const row = db.prepare(
    "SELECT 1 FROM txs WHERE batch_id = ? AND type = ? AND status IN ('PENDING','UNCERTAIN') LIMIT 1"
  ).get(batchId, type)
  return Boolean(row)
}

function latestTx(batchId: string, type: TxType): TxRow | undefined {
  return db.prepare('SELECT * FROM txs WHERE batch_id = ? AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(batchId, type) as TxRow | undefined
}

function assertAccountNetwork(row: BatchRow, account: string, network: string, scenario: Scenario) {
  if (network !== row.chain_id) {
    throw new AppError(409, 'NETWORK_CHANGED', `网络已变化：批次要求 ${row.chain_id}，当前为 ${network}`)
  }
  const chainAccount = chain.currentAccount(account, scenario)
  if (chainAccount.toLowerCase() !== account.trim().toLowerCase()) {
    throw new AppError(409, 'ACCOUNT_CHANGED', '检测到钱包账户已变化，旧确认已作废，请重新核对')
  }
  if (account.trim().toLowerCase() !== row.from_address.toLowerCase()) {
    throw new AppError(409, 'ACCOUNT_CHANGED', '钱包账户与批次付款账户不一致，旧确认已作废')
  }
}

/** 提交授权：仅授权本次所需额度 */
export function submitApprove(id: string, account: string, network: string) {
  const row = getBatchRow(id)
  const scenario = row.scenario as Scenario
  assertAccountNetwork(row, account, network, scenario)

  if (hasActiveTx(id, 'APPROVE')) {
    throw new AppError(409, 'APPROVE_IN_FLIGHT', '已有授权交易待确认或结果不确定，请查询结果，勿重复发起')
  }
  const approved = chain.getAllowance(row.from_address, CONFIG.spender)
  if (approved >= BigInt(row.total_min_unit)) {
    throw new AppError(409, 'APPROVE_NOT_NEEDED', '当前授权额度已足够，无需重复授权')
  }

  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ batch: id, type: 'APPROVE', token: CONFIG.token.address, spender: CONFIG.spender, amount: row.total_min_unit }))
    .digest('hex')
  const submitted = chain.submitTransaction({ type: 'APPROVE', scenario }, payloadHash)

  const ts = now()
  db.prepare(`
    INSERT INTO txs (id, batch_id, type, tx_hash, status, scenario, recheck_count, created_at, updated_at)
    VALUES (?, ?, 'APPROVE', ?, 'PENDING', ?, 0, ?, ?)
  `).run(randomUUID(), id, submitted.txHash, scenario, ts, ts)
  db.prepare("UPDATE batches SET status = 'AWAITING_WALLET', updated_at = ? WHERE id = ?").run(ts, id)

  return { txHash: submitted.txHash, status: submitted.status, type: 'APPROVE' }
}

/** 提交转账：整批一次调用，value=0，金额用最小单位 */
export function submitTransfer(id: string, account: string, network: string) {
  const row = getBatchRow(id)
  const scenario = row.scenario as Scenario
  assertAccountNetwork(row, account, network, scenario)

  if (hasActiveTx(id, 'TRANSFER')) {
    throw new AppError(409, 'TRANSFER_IN_FLIGHT', '已有转账交易待确认或结果不确定，禁止重复发送；请查询原交易结果')
  }

  const approveTx = latestTx(id, 'APPROVE')
  if (!approveTx || approveTx.status !== 'CONFIRMED') {
    throw new AppError(409, 'APPROVE_NOT_CONFIRMED', '授权交易尚未确认成功，不能发送转账')
  }

  const allowance = chain.getAllowance(row.from_address, CONFIG.spender)
  const required = BigInt(row.total_min_unit)
  if (allowance < required) {
    throw new AppError(409, 'ALLOWANCE_INSUFFICIENT', '授权额度不足')
  }
  if (chain.getBalance(row.from_address) < required) {
    throw new AppError(409, 'BALANCE_INSUFFICIENT', '代币余额不足')
  }
  // 目标合约存在性校验（真实链下由 getCode 完成；模拟模式下配置为固定合约地址）
  if (!CONFIG.disperseAddress) {
    throw new AppError(500, 'TARGET_NOT_CONFIGURED', '批量转账目标未配置')
  }

  const recipients = JSON.parse(row.recipients_json) as NormalizedRecipient[]
  const payloadHash = createHash('sha256').update(JSON.stringify({
    batch: id,
    type: 'TRANSFER',
    token: CONFIG.token.address,
    target: CONFIG.disperseAddress,
    recipients: recipients.map((r) => [r.address, r.amountMinUnit]),
    total: row.total_min_unit,
    value: '0'
  })).digest('hex')
  const submitted = chain.submitTransaction({ type: 'TRANSFER', scenario }, payloadHash)

  const ts = now()
  db.prepare(`
    INSERT INTO txs (id, batch_id, type, tx_hash, status, scenario, recheck_count, created_at, updated_at)
    VALUES (?, ?, 'TRANSFER', ?, 'PENDING', ?, 0, ?, ?)
  `).run(randomUUID(), id, submitted.txHash, scenario, ts, ts)
  db.prepare("UPDATE batches SET status = 'SUBMITTED_PENDING', updated_at = ? WHERE id = ?").run(ts, id)

  return { txHash: submitted.txHash, status: submitted.status, type: 'TRANSFER' }
}

const TERMINAL: TxStatus[] = ['CONFIRMED', 'FAILED', 'REJECTED']

/** 重新查询原交易结果；成功状态只来自此处（链状态） */
export function recheck(id: string, type: TxType) {
  const row = getBatchRow(id)
  const scenario = row.scenario as Scenario
  const tx = latestTx(id, type)
  if (!tx) throw new AppError(404, 'TX_NOT_FOUND', `该批次尚无${type === 'APPROVE' ? '授权' : '转账'}交易`)

  if (TERMINAL.includes(tx.status as TxStatus)) {
    return { tx: toTxDTO(tx), batch: toBatchDTO(row), reason: '交易已处于终态' }
  }

  const result = chain.queryTransaction(tx.tx_hash, { type, scenario }, tx.recheck_count)
  const ts = now()
  db.prepare('UPDATE txs SET status = ?, recheck_count = recheck_count + 1, updated_at = ? WHERE id = ?')
    .run(result.status, ts, tx.id)

  let batchStatus: BatchStatus | null = null
  if (type === 'APPROVE') {
    if (result.status === 'CONFIRMED') {
      // 授权确认后写入模拟链的授权额度（仅授权本次所需）
      chain.applyAllowance(row.from_address, CONFIG.spender, BigInt(row.total_min_unit))
    }
    if (result.status === 'REJECTED') batchStatus = 'REJECTED'
    else if (result.status === 'FAILED') batchStatus = 'FAILED'
  } else {
    if (result.status === 'CONFIRMED') batchStatus = 'CONFIRMED'
    else if (result.status === 'FAILED') batchStatus = 'FAILED'
    else if (result.status === 'REJECTED') batchStatus = 'REJECTED'
    else if (result.status === 'UNCERTAIN') batchStatus = 'UNCERTAIN'
  }
  if (batchStatus) {
    db.prepare('UPDATE batches SET status = ?, updated_at = ? WHERE id = ?').run(batchStatus, ts, id)
  }

  return { tx: toTxDTO(latestTx(id, type)!), batch: toBatchDTO(getBatchRow(id)), reason: result.reason }
}

export function resetChain() {
  chain.reset()
}
