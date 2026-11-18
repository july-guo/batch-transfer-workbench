import { CONFIG, SCENARIOS } from './config.js'
import { parseAmount } from './money.js'
import type { NormalizedRecipient, RecipientInput, Scenario } from './types.js'

export interface FieldError {
  row: number | null
  field: string
  message: string
}

export interface ValidatedCreate {
  requestId: string
  chainId: string
  fromAddress: string
  tokenAddress: string
  recipients: NormalizedRecipient[]
  totalMinUnit: string
  scenario: Scenario
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const ZERO_ADDRESS = /^0x0{40}$/

export function isValidAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const s = value.trim()
  return ADDRESS_RE.test(s) && !ZERO_ADDRESS.test(s)
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

/**
 * 服务端独立校验，不依赖前端。
 * 返回全部错误（逐行定位），任一行错误则整体拒绝。
 */
export function validateCreateBody(body: unknown):
  | { ok: true; value: ValidatedCreate }
  | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  if (typeof body !== 'object' || body === null) {
    return { ok: false, errors: [{ row: null, field: 'body', message: '请求体必须是对象' }] }
  }
  const b = body as Record<string, unknown>

  const requestId = typeof b.requestId === 'string' ? b.requestId.trim() : ''
  if (!requestId || requestId.length > 200) {
    errors.push({ row: null, field: 'requestId', message: 'requestId 必须为 1-200 字符的非空字符串' })
  }

  const chainId = typeof b.chainId === 'string' ? b.chainId.trim() : ''
  if (chainId !== CONFIG.chainId) {
    errors.push({ row: null, field: 'chainId', message: `仅支持固定网络 ${CONFIG.chainId}` })
  }

  if (!isValidAddress(b.fromAddress)) {
    errors.push({ row: null, field: 'fromAddress', message: '付款账户不是有效 EVM 地址或为零地址' })
  }

  const tokenAddress = typeof b.tokenAddress === 'string' ? b.tokenAddress.trim().toLowerCase() : ''
  if (tokenAddress !== CONFIG.token.address.toLowerCase()) {
    errors.push({ row: null, field: 'tokenAddress', message: '代币地址与固定配置不符' })
  }

  const scenarioRaw = b.scenario === undefined || b.scenario === '' ? 'SUCCESS' : b.scenario
  if (typeof scenarioRaw !== 'string' || !(SCENARIOS as readonly string[]).includes(scenarioRaw)) {
    errors.push({ row: null, field: 'scenario', message: 'scenario 非法' })
  }
  const scenario = (typeof scenarioRaw === 'string' ? scenarioRaw : 'SUCCESS') as Scenario

  const rawRecipients = b.recipients
  if (!Array.isArray(rawRecipients)) {
    errors.push({ row: null, field: 'recipients', message: '收款列表必须是数组' })
  } else {
    if (rawRecipients.length < CONFIG.minRecipients || rawRecipients.length > CONFIG.maxRecipients) {
      errors.push({
        row: null,
        field: 'recipients',
        message: `每批收款人数量必须在 ${CONFIG.minRecipients}-${CONFIG.maxRecipients} 之间`
      })
    }
    const seen = new Set<string>()
    rawRecipients.forEach((item, index) => {
      const row = index + 1
      if (typeof item !== 'object' || item === null) {
        errors.push({ row, field: 'recipient', message: '收款行必须是对象' })
        return
      }
      const r = item as RecipientInput
      if (!isValidAddress(r.address)) {
        errors.push({ row, field: 'address', message: '地址不是有效 EVM 地址或为零地址' })
      } else {
        const norm = normalizeAddress(r.address)
        if (seen.has(norm)) {
          errors.push({ row, field: 'address', message: '同一批次中地址重复（大小写不敏感）' })
        }
        seen.add(norm)
      }
      const amount = parseAmount(r.amount)
      if (amount === null) {
        errors.push({ row, field: 'amount', message: '金额必须大于 0、最多 6 位小数，且不得为科学计数法' })
      }
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  const recipients: NormalizedRecipient[] = (rawRecipients as RecipientInput[]).map((r) => ({
    address: normalizeAddress(r.address),
    amountMinUnit: parseAmount(r.amount)!.toString()
  }))
  const totalMinUnit = recipients.reduce((sum, r) => sum + BigInt(r.amountMinUnit), 0n).toString()

  return {
    ok: true,
    value: {
      requestId,
      chainId,
      fromAddress: normalizeAddress(b.fromAddress as string),
      tokenAddress,
      recipients,
      totalMinUnit,
      scenario
    }
  }
}
