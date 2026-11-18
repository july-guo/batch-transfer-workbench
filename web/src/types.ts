export type Scenario =
  | 'SUCCESS'
  | 'APPROVE_REJECTED'
  | 'TRANSFER_REVERT'
  | 'QUERY_TIMEOUT'
  | 'INSUFFICIENT_BALANCE'
  | 'ACCOUNT_CHANGED'

export type BatchStatus =
  | 'UNSUBMITTED'
  | 'AWAITING_WALLET'
  | 'SUBMITTED_PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REJECTED'
  | 'UNCERTAIN'

export type TxStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REJECTED' | 'UNCERTAIN'
export type TxType = 'APPROVE' | 'TRANSFER'

export interface Recipient {
  id: string
  address: string
  amount: string
}

export interface NormalizedRecipient {
  address: string
  amountMinUnit: string
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

export interface Preflight {
  balanceMinUnit: string
  balanceDisplay: string
  allowanceMinUnit: string
  allowanceDisplay: string
  requiredMinUnit: string
  requiredDisplay: string
  sufficientBalance: boolean
  sufficientAllowance: boolean
  needsApproval: boolean
  spender: string
  token: string
  disperseAddress: string
  scenario: Scenario
}

export interface ServerConfig {
  chainId: string
  networkName: string
  token: { address: string; symbol: string; name: string; decimals: number }
  disperseAddress: string
  spender: string
  mode: string
}
