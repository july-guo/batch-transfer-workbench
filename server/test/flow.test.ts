import { describe, it, expect, beforeEach } from 'vitest'
import { createBatch, getBatch, preflight, submitApprove, submitTransfer, recheck, resetChain } from '../src/service.js'
import { CONFIG } from '../src/config.js'
import { AppError } from '../src/types.js'

const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NETWORK = CONFIG.chainId
const R1 = '0x1111111111111111111111111111111111111111'
const R2 = '0x2222222222222222222222222222222222222222'

let counter = 0
function make(scenario = 'SUCCESS', recipients = [{ address: R1, amount: '1.5' }, { address: R2, amount: '2.25' }]) {
  return {
    requestId: `test-${process.pid}-${counter++}`,
    chainId: NETWORK,
    fromAddress: ACCOUNT,
    tokenAddress: CONFIG.token.address,
    recipients,
    scenario
  }
}

function mustFail(fn: () => unknown, code: string) {
  try {
    fn()
    throw new Error('期望抛出异常但没有')
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    expect((e as AppError).code).toBe(code)
  }
}

/** 完整推进到授权确认 */
function approveConfirmed(batchId: string) {
  submitApprove(batchId, ACCOUNT, NETWORK)
  recheck(batchId, 'APPROVE')
}

beforeEach(() => resetChain())

describe('幂等与持久化', () => {
  it('相同 requestId 相同内容返回原批次；不同内容报错', () => {
    const body = make()
    const first = createBatch(body)
    const second = createBatch(body)
    expect(second.reused).toBe(true)
    expect(second.batch.id).toBe(first.batch.id)
    expect(getBatch(first.batch.id).id).toBe(first.batch.id)

    mustFail(() => createBatch({ ...body, scenario: 'TRANSFER_REVERT' }), 'IDEMPOTENCY_CONFLICT')
  })

  it('服务端计算并保存规范化总额', () => {
    const { batch } = createBatch(make())
    expect(batch.totalMinUnit).toBe('3750000')
    expect(batch.totalDisplay).toBe('3.75')
  })
})

describe('场景：正常完成一次批量转账', () => {
  it('授权确认后转账确认，批次才置为成功', () => {
    const { batch } = createBatch(make('SUCCESS'))
    let p = preflight(batch.id, ACCOUNT, NETWORK)
    expect(p.needsApproval).toBe(true)
    expect(p.sufficientBalance).toBe(true)

    approveConfirmed(batch.id)
    expect(getBatch(batch.id).txs.find((t) => t.type === 'APPROVE')?.status).toBe('CONFIRMED')
    expect(getBatch(batch.id).status).not.toBe('CONFIRMED') // 授权成功 ≠ 转账成功

    p = preflight(batch.id, ACCOUNT, NETWORK)
    expect(p.needsApproval).toBe(false)

    const sub = submitTransfer(batch.id, ACCOUNT, NETWORK)
    expect(sub.status).toBe('PENDING')
    expect(getBatch(batch.id).status).toBe('SUBMITTED_PENDING') // 拿到 hash 不是成功

    recheck(batch.id, 'TRANSFER')
    expect(getBatch(batch.id).status).toBe('CONFIRMED')
  })
})

describe('场景：授权被拒绝', () => {
  it('授权 REJECTED 后不能转账', () => {
    const { batch } = createBatch(make('APPROVE_REJECTED'))
    submitApprove(batch.id, ACCOUNT, NETWORK)
    const r = recheck(batch.id, 'APPROVE')
    expect(r.tx.status).toBe('REJECTED')
    expect(getBatch(batch.id).status).toBe('REJECTED')
    mustFail(() => submitTransfer(batch.id, ACCOUNT, NETWORK), 'APPROVE_NOT_CONFIRMED')
  })
})

describe('场景：转账回滚', () => {
  it('转账 FAILED，授权不受影响，批次明确失败', () => {
    const { batch } = createBatch(make('TRANSFER_REVERT'))
    approveConfirmed(batch.id)
    submitTransfer(batch.id, ACCOUNT, NETWORK)
    const r = recheck(batch.id, 'TRANSFER')
    expect(r.tx.status).toBe('FAILED')
    expect(getBatch(batch.id).status).toBe('FAILED')
    expect(getBatch(batch.id).txs.find((t) => t.type === 'APPROVE')?.status).toBe('CONFIRMED')
  })
})

describe('场景：提交后查询超时', () => {
  it('首次 UNCERTAIN 不判失败，且禁止重发；再次查询揭晓成功', () => {
    const { batch } = createBatch(make('QUERY_TIMEOUT'))
    approveConfirmed(batch.id)
    submitTransfer(batch.id, ACCOUNT, NETWORK)
    const first = recheck(batch.id, 'TRANSFER')
    expect(first.tx.status).toBe('UNCERTAIN')
    expect(getBatch(batch.id).status).toBe('UNCERTAIN')

    // 结果不确定时禁止重复提交
    mustFail(() => submitTransfer(batch.id, ACCOUNT, NETWORK), 'TRANSFER_IN_FLIGHT')

    const second = recheck(batch.id, 'TRANSFER')
    expect(second.tx.status).toBe('CONFIRMED')
    expect(getBatch(batch.id).status).toBe('CONFIRMED')
  })
})

describe('场景：连点提交与账户/网络变化', () => {
  it('重复点击提交转账被阻止（只查询原交易）', () => {
    const { batch } = createBatch(make('SUCCESS'))
    approveConfirmed(batch.id)
    submitTransfer(batch.id, ACCOUNT, NETWORK)
    mustFail(() => submitTransfer(batch.id, ACCOUNT, NETWORK), 'TRANSFER_IN_FLIGHT')
    recheck(batch.id, 'TRANSFER')
    expect(getBatch(batch.id).txs.filter((t) => t.type === 'TRANSFER')).toHaveLength(1)
  })

  it('账户变化后作废旧确认，不能沿用', () => {
    const { batch } = createBatch(make('ACCOUNT_CHANGED'))
    mustFail(() => preflight(batch.id, ACCOUNT, NETWORK), 'ACCOUNT_CHANGED')
    mustFail(() => submitApprove(batch.id, ACCOUNT, NETWORK), 'ACCOUNT_CHANGED')
  })

  it('网络变化后阻止继续', () => {
    const { batch } = createBatch(make('SUCCESS'))
    mustFail(() => preflight(batch.id, ACCOUNT, '1'), 'NETWORK_CHANGED')
  })
})

describe('场景：余额不足', () => {
  it('余额充足性检查正确（模拟链初始余额足够，超大金额不足）', () => {
    const huge = Array.from({ length: 20 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      amount: '999999'
    }))
    const { batch } = createBatch(make('INSUFFICIENT_BALANCE', huge))
    const p = preflight(batch.id, ACCOUNT, NETWORK)
    expect(p.sufficientBalance).toBe(false)
  })
})

describe('授权与转账交易分离', () => {
  it('授权与转账各自独立记录 hash 与状态', () => {
    const { batch } = createBatch(make('SUCCESS'))
    approveConfirmed(batch.id)
    submitTransfer(batch.id, ACCOUNT, NETWORK)
    const b = getBatch(batch.id)
    const approve = b.txs.find((t) => t.type === 'APPROVE')!
    const transfer = b.txs.find((t) => t.type === 'TRANSFER')!
    expect(approve.txHash).not.toBe(transfer.txHash)
    expect(approve.status).toBe('CONFIRMED')
    expect(transfer.status).toBe('PENDING')
  })
})
