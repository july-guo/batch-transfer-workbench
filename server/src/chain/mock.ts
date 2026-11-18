import { createHash } from 'node:crypto'
import { CONFIG } from '../config.js'
import type { Scenario, TxStatus } from '../types.js'
import type { ChainAdapter, QueryResult, SubmitContext, SubmitResult } from './adapter.js'

/**
 * 模拟链适配器。
 * 关键点：链状态独立于 UI，成功只能来自 queryTransaction 的返回值，
 * 客户端无法自行声明成功。不同场景可独立触发。
 */
export class MockChainAdapter implements ChainAdapter {
  private balance = BigInt(CONFIG.initialBalanceMinUnit)
  private allowances = new Map<string, bigint>()
  /** 记录每笔交易的"真实"终局，供查询时揭晓；提交时不暴露 */
  private ledger = new Map<string, { outcome: 'CONFIRMED' | 'FAILED' | 'REJECTED'; reason?: string }>()

  private allowanceKey(owner: string, spender: string) {
    return `${owner.toLowerCase()}->${spender.toLowerCase()}`
  }

  getBalance(_address: string): bigint {
    return this.balance
  }

  getAllowance(owner: string, spender: string): bigint {
    return this.allowances.get(this.allowanceKey(owner, spender)) ?? 0n
  }

  /** 仅供测试重置模拟链状态 */
  reset() {
    this.balance = BigInt(CONFIG.initialBalanceMinUnit)
    this.allowances.clear()
    this.ledger.clear()
  }

  submitTransaction(ctx: SubmitContext, payloadHash: string): SubmitResult {
    const txHash = '0x' + createHash('sha256').update(`${payloadHash}:${ctx.type}:${Date.now()}:${Math.random()}`).digest('hex')
    let outcome: 'CONFIRMED' | 'FAILED' | 'REJECTED' = 'CONFIRMED'
    let reason: string | undefined

    if (ctx.scenario === 'APPROVE_REJECTED' && ctx.type === 'APPROVE') {
      outcome = 'REJECTED'
      reason = '用户在钱包中拒绝了授权'
    } else if (ctx.scenario === 'TRANSFER_REVERT' && ctx.type === 'TRANSFER') {
      outcome = 'FAILED'
      reason = '批量转账交易回滚（execution reverted）'
    }

    this.ledger.set(txHash, { outcome, reason })
    return { txHash, status: 'PENDING' }
  }

  queryTransaction(txHash: string, ctx: SubmitContext, recheckCount: number): QueryResult {
    const record = this.ledger.get(txHash)
    if (!record) return { status: 'UNCERTAIN', reason: '模拟链中未找到该交易哈希' }

    // 查询超时场景：转账交易首次查询返回"结果暂时无法确定"，不改判失败；
    // 再次查询则揭晓真实结果。授权交易不受影响。
    if (ctx.scenario === 'QUERY_TIMEOUT' && ctx.type === 'TRANSFER' && recheckCount === 0) {
      return { status: 'UNCERTAIN', reason: '查询超时：节点暂未返回回执，链上结果未知' }
    }

    const status: TxStatus = record.outcome
    return { status, reason: record.reason }
  }

  currentAccount(expected: string, scenario: Scenario): string {
    // 账户变化场景：模拟链报告一个与批次不同的账户，用于触发"账户已变化"保护
    if (scenario === 'ACCOUNT_CHANGED') {
      return '0x9999999999999999999999999999999999999999'
    }
    return expected
  }

  /** 授权确认后按 approve 语义将额度设置为本次所需（覆盖，不多授权） */
  applyAllowance(owner: string, spender: string, amount: bigint) {
    const key = this.allowanceKey(owner, spender)
    this.allowances.set(key, amount)
  }
}
