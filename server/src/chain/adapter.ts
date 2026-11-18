import type { Scenario, TxStatus, TxType } from '../types.js'

/**
 * 链适配层接口。模拟模式与真实链模式对上层提供一致语义：
 * - 提交交易只返回交易哈希，状态恒为 PENDING（拿到 hash ≠ 成功）
 * - 交易真实结果只能通过 queryTransaction 查询获得（成功状态来自可信查询）
 */
export interface SubmitContext {
  type: TxType
  scenario: Scenario
}

export interface SubmitResult {
  txHash: string
  status: 'PENDING'
}

export interface QueryResult {
  status: TxStatus
  /** 链上失败原因（revert / rejected 等），用于前端展示 */
  reason?: string
}

export interface ChainAdapter {
  getBalance(address: string): bigint
  getAllowance(owner: string, spender: string): bigint
  /** 提交交易（写入的是模拟链状态，不代表执行成功） */
  submitTransaction(ctx: SubmitContext, payloadHash: string): SubmitResult
  /** 查询交易结果；recheckCount 表示这是第几次查询（首次为 0） */
  queryTransaction(txHash: string, ctx: SubmitContext, recheckCount: number): QueryResult
  /** 模拟链视角的"当前账户"，用于检测账户变化；正常等于传入地址 */
  currentAccount(expected: string, scenario: Scenario): string
}
