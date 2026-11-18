/** 金额工具：全程使用 BigInt 最小单位（10^-6），零浮点。 */

export const DECIMALS = 6
const SCALE = 10n ** BigInt(DECIMALS)

/**
 * 解析用户输入的金额字符串。
 * - 必须 > 0
 * - 最多 6 位小数
 * - 不接受科学计数法、正负号、空白、空小数部分
 * 返回最小单位的 BigInt，非法输入返回 null。
 */
export function parseAmount(input: unknown): bigint | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const fracPadded = (frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS)
  const value = BigInt(whole) * SCALE + BigInt(fracPadded === '' ? '0' : fracPadded)
  return value > 0n ? value : null
}

/** 最小单位 BigInt 转回人类可读字符串（去除尾部无意义的 0） */
export function formatMinUnit(value: bigint): string {
  const whole = value / SCALE
  const frac = value % SCALE
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(DECIMALS, '0').replace(/0+$/, '')
  return `${whole}.${fracStr}`
}
