/** 模拟场景：创建批次时可注入，用于独立触发不同交易结果 */
export type Scenario =
  | 'SUCCESS'
  | 'APPROVE_REJECTED'
  | 'TRANSFER_REVERT'
  | 'QUERY_TIMEOUT'
  | 'INSUFFICIENT_BALANCE'
  | 'ACCOUNT_CHANGED'

/** 批次状态（题目第六节要求的六种可区分状态） */
export type BatchStatus =
  | 'UNSUBMITTED'        // 尚未提交
  | 'AWAITING_WALLET'    // 等待钱包操作
  | 'SUBMITTED_PENDING'  // 已提交、等待确认
  | 'CONFIRMED'          // 已确认成功
  | 'FAILED'             // 明确失败（含回滚）
  | 'REJECTED'           // 用户拒绝
  | 'UNCERTAIN'          // 结果暂时无法确定

export type TxStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REJECTED' | 'UNCERTAIN'
export type TxType = 'APPROVE' | 'TRANSFER'

export interface RecipientInput {
  address: string
  amount: string
}

export interface NormalizedRecipient {
  address: string        // 规范化为小写
  amountMinUnit: string  // 最小单位（10^-6）字符串，BigInt
}

export interface BatchDTO {
  id: string
  requestId: string
  chainId: string
  fromAddress: string
  tokenAddress: string
  recipients: NormalizedRecipient[]
  totalMinUnit: string
  totalDisplay: string
  scenario: Scenario
  status: BatchStatus
  createdAt: string
  updatedAt: string
  txs: TxDTO[]
}

export interface TxDTO {
  id: string
  batchId: string
  type: TxType
  txHash: string
  status: TxStatus
  recheckCount: number
  createdAt: string
  updatedAt: string
}

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message)
  }
}
