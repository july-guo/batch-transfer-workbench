/**
 * 固定配置：代币、批量转账目标、spender 全部在服务端写死，
 * 客户端请求无法指定或覆盖（题目第五节要求）。
 */
export const CONFIG = {
  chainId: '31337',
  networkName: 'Local Mock Chain (EVM)',
  token: {
    address: '0x1111111111111111111111111111111111111111',
    symbol: 'MOCK',
    name: 'Mock Test Token',
    decimals: 6
  },
  // 批量转账合约（disperseToken 目标），同时也是 ERC-20 授权的 spender
  disperseAddress: '0x2222222222222222222222222222222222222222',
  get spender() {
    return this.disperseAddress
  },
  // 模拟账户初始余额：1,000,000 MOCK，以最小单位表示
  initialBalanceMinUnit: '1000000000000',
  maxRecipients: 20,
  minRecipients: 1
} as const

export const SCENARIOS = [
  'SUCCESS',
  'APPROVE_REJECTED',
  'TRANSFER_REVERT',
  'QUERY_TIMEOUT',
  'INSUFFICIENT_BALANCE',
  'ACCOUNT_CHANGED'
] as const
