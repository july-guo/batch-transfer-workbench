import { describe, it, expect } from 'vitest'
import { parseAmount, formatMinUnit } from '../src/money.js'
import { validateCreateBody } from '../src/validation.js'
import { CONFIG } from '../src/config.js'

const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN = CONFIG.token.address

describe('精确金额解析', () => {
  it('整数与最多 6 位小数精确转成最小单位', () => {
    expect(parseAmount('1')?.toString()).toBe('1000000')
    expect(parseAmount('12.5')?.toString()).toBe('12500000')
    expect(parseAmount('0.000001')?.toString()).toBe('1')
    expect(parseAmount('123.456789')?.toString()).toBe('123456789')
  })

  it('拒绝非法输入', () => {
    for (const bad of ['', '0', '-1', '1.1234567', '1e3', ' 1e3 ', 'abc', '.5', '1.', '+1', 'Infinity']) {
      expect(parseAmount(bad), bad).toBeNull()
    }
  })

  it('显示格式化无精度损失', () => {
    expect(formatMinUnit(123456789n)).toBe('123.456789')
    expect(formatMinUnit(1n)).toBe('0.000001')
    expect(formatMinUnit(1000000n)).toBe('1')
  })

  it('总额用 BigInt 相加，不受浮点影响', () => {
    const a = parseAmount('0.1')!
    const b = parseAmount('0.2')!
    expect((a + b).toString()).toBe('300000')
  })
})

describe('录入校验', () => {
  const base = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'req-1',
    chainId: CONFIG.chainId,
    fromAddress: ACCOUNT,
    tokenAddress: TOKEN,
    recipients: [{ address: '0x1111111111111111111111111111111111111111', amount: '1.5' }],
    scenario: 'SUCCESS',
    ...overrides
  })

  it('合法输入通过并规范化为最小单位', () => {
    const r = validateCreateBody(base())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.recipients[0].address).toBe('0x1111111111111111111111111111111111111111')
      expect(r.value.totalMinUnit).toBe('1500000')
    }
  })

  it('大小写不同的重复地址被识别', () => {
    const mixed = '0xABAbABAbABAbABAbABAbABAbABAbABAbABAbABAb'
    const lower = mixed.toLowerCase()
    const r = validateCreateBody(base({ recipients: [
      { address: mixed, amount: '1' },
      { address: lower, amount: '2' }
    ] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.field === 'address' && e.message.includes('重复'))).toBe(true)
  })

  it('零地址、超范围数量、逐行错误定位', () => {
    const r = validateCreateBody(base({ recipients: [
      { address: '0x0000000000000000000000000000000000000000', amount: '1' },
      { address: ACCOUNT, amount: '1.1234567' }
    ] }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.row === 1 && e.message.includes('零地址'))).toBe(true)
      expect(r.errors.some((e) => e.row === 2 && e.field === 'amount')).toBe(true)
    }
  })

  it('代币地址不接受任意指定', () => {
    const r = validateCreateBody(base({ tokenAddress: '0x3333333333333333333333333333333333333333' }))
    expect(r.ok).toBe(false)
  })
})
