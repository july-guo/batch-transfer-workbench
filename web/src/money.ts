/** 前端金额工具：与后端一致，用 BigInt 最小单位，零浮点。 */
const SCALE = 10n ** 6n

export function parseAmount(input: string): bigint | null {
  const s = (input ?? '').trim()
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const padded = (frac + '000000').slice(0, 6)
  const value = BigInt(whole) * SCALE + BigInt(padded === '' ? '0' : padded)
  return value > 0n ? value : null
}

export function formatMinUnit(value: bigint): string {
  const whole = value / SCALE
  const frac = value % SCALE
  if (frac === 0n) return whole.toString()
  return `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`
}

export function isValidAddress(value: string): boolean {
  const s = (value ?? '').trim()
  return /^0x[a-fA-F0-9]{40}$/.test(s) && !/^0x0{40}$/i.test(s)
}
