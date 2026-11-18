<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { api, ApiError } from './api'
import type { Recipient, Scenario, ServerConfig, BatchDTO, Preflight, BatchStatus, TxType } from './types'
import { formatMinUnit } from './money'
import RecipientEditor from './components/RecipientEditor.vue'

const config = ref<ServerConfig | null>(null)
const rows = ref<Recipient[]>([
  { id: 'r1', address: '', amount: '' },
  { id: 'r2', address: '', amount: '' }
])
const editorRef = ref<InstanceType<typeof RecipientEditor> | null>(null)

// 模拟钱包
const connected = ref(false)
const account = ref('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const network = ref('31337')

const scenarios = [
  { value: 'SUCCESS', label: 'SUCCESS · 正常完成' },
  { value: 'APPROVE_REJECTED', label: 'APPROVE_REJECTED · 授权被拒绝' },
  { value: 'TRANSFER_REVERT', label: 'TRANSFER_REVERT · 转账回滚' },
  { value: 'QUERY_TIMEOUT', label: 'QUERY_TIMEOUT · 首次查询超时' },
  { value: 'INSUFFICIENT_BALANCE', label: 'INSUFFICIENT_BALANCE · 余额不足' },
  { value: 'ACCOUNT_CHANGED', label: 'ACCOUNT_CHANGED · 账户变化' }
]
const scenario = ref<Scenario>('SUCCESS')

// 批次与流程状态
const requestId = ref('')
const batch = ref<BatchDTO | null>(null)
const pre = ref<Preflight | null>(null)
const confirmed = ref(false)
const busy = ref<'create' | 'preflight' | 'approve' | 'transfer' | 'recheck' | null>(null)
const notice = ref('')
const noticeType = ref<'info' | 'warning' | 'error' | 'success'>('info')

const active = computed(() => busy.value !== null)
const batchLocked = computed(() => Boolean(batch.value))
const approveTx = computed(() => batch.value?.txs.filter((t) => t.type === 'APPROVE').slice(-1)[0])
const transferTx = computed(() => batch.value?.txs.filter((t) => t.type === 'TRANSFER').slice(-1)[0])

const statusMap: Record<BatchStatus, { label: string; type: string }> = {
  UNSUBMITTED: { label: '尚未提交', type: 'info' },
  AWAITING_WALLET: { label: '等待钱包操作', type: 'warning' },
  SUBMITTED_PENDING: { label: '已提交 · 等待确认', type: 'warning' },
  CONFIRMED: { label: '已确认成功', type: 'success' },
  FAILED: { label: '明确失败', type: 'danger' },
  REJECTED: { label: '用户拒绝', type: 'danger' },
  UNCERTAIN: { label: '结果暂时无法确定', type: 'warning' }
}
const statusInfo = computed(() => (batch.value ? statusMap[batch.value.status] : statusMap.UNSUBMITTED))
const txStatusType: Record<string, string> = {
  PENDING: 'warning', CONFIRMED: 'success', FAILED: 'danger', REJECTED: 'danger', UNCERTAIN: 'warning'
}

function genRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function setNotice(msg: string, type: 'info' | 'warning' | 'error' | 'success' = 'info') {
  notice.value = msg
  noticeType.value = type
}

function showError(err: unknown) {
  if (err instanceof ApiError) {
    const details = err.details as Array<{ row: number | null; field: string; message: string }> | undefined
    if (Array.isArray(details)) {
      setNotice(details.map((d) => `行${d.row ?? '-'} · ${d.field}: ${d.message}`).join('；'), 'error')
    } else {
      setNotice(`${err.code}: ${err.message}`, 'error')
    }
  } else {
    setNotice(String(err), 'error')
  }
}

onMounted(async () => {
  try {
    config.value = await api.config()
    network.value = config.value.chainId
  } catch (e) {
    showError(e)
  }
  // 刷新恢复：仅读取已有记录，绝不自动重新签名或转账
  const savedId = localStorage.getItem('btw:batchId')
  if (savedId) {
    try {
      const { batch: b } = await api.getBatch(savedId)
      batch.value = b
      confirmed.value = true
      setNotice('已恢复上次的批次记录。不会自动重新发起签名或转账，如需推进请手动操作。', 'warning')
    } catch {
      localStorage.removeItem('btw:batchId')
    }
  }
})

function connectWallet() {
  if (!/^0x[a-fA-F0-9]{40}$/.test(account.value.trim())) {
    setNotice('请输入有效的 EVM 账户地址', 'error')
    return
  }
  connected.value = true
  setNotice(`已连接模拟钱包：${account.value}`, 'success')
}

async function doCreate() {
  if (!editorRef.value?.allValid) {
    setNotice('收款名单存在错误，不能创建批次', 'error')
    return
  }
  if (!confirmed.value) {
    setNotice('请先勾选确认付款信息', 'error')
    return
  }
  busy.value = 'create'
  try {
    if (!requestId.value) requestId.value = genRequestId()
    const body = {
      requestId: requestId.value,
      chainId: config.value?.chainId,
      fromAddress: account.value,
      tokenAddress: config.value?.token.address,
      recipients: rows.value.map((r) => ({ address: r.address.trim(), amount: r.amount.trim() })),
      scenario: scenario.value
    }
    const res = await api.createBatch(body)
    batch.value = res.batch
    localStorage.setItem('btw:batchId', res.batch.id)
    setNotice(res.reused ? '该 requestId 已存在，返回原批次（未重复创建）' : '批次已创建，请检查余额与授权', 'success')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = null
  }
}

async function doPreflight() {
  if (!batch.value) return
  busy.value = 'preflight'
  try {
    const res = await api.preflight(batch.value.id, account.value, network.value)
    pre.value = res.preflight
    setNotice(res.preflight.needsApproval ? '授权额度不足，需要授权' : '授权额度足够，可跳过授权', 'info')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = null
  }
}

async function doApprove() {
  if (!batch.value) return
  busy.value = 'approve'
  try {
    await api.approve(batch.value.id, account.value, network.value)
    await refreshBatch()
    setNotice('授权交易已提交，正在查询链上结果（拿到哈希不等于成功）', 'warning')
    await doRecheck('APPROVE')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = null
  }
}

async function doTransfer() {
  if (!batch.value) return
  busy.value = 'transfer'
  try {
    await api.transfer(batch.value.id, account.value, network.value)
    await refreshBatch()
    setNotice('转账交易已提交，正在查询链上结果', 'warning')
    await doRecheck('TRANSFER')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = null
  }
}

async function doRecheck(type: TxType) {
  if (!batch.value) return
  busy.value = 'recheck'
  try {
    const res = await api.recheck(batch.value.id, type)
    batch.value = res.batch
    const label = res.tx.status
    setNotice(
      res.reason ? `查询结果：${label} —— ${res.reason}` : `查询结果：${label}`,
      res.tx.status === 'CONFIRMED' ? 'success' : res.tx.status === 'UNCERTAIN' ? 'warning' : 'error'
    )
  } catch (e) {
    showError(e)
  } finally {
    busy.value = null
  }
}

async function refreshBatch() {
  if (!batch.value) return
  const { batch: b } = await api.getBatch(batch.value.id)
  batch.value = b
}

function resetAll() {
  localStorage.removeItem('btw:batchId')
  batch.value = null
  pre.value = null
  confirmed.value = false
  requestId.value = ''
  rows.value = [{ id: `r${Date.now()}`, address: '', amount: '' }, { id: `r${Date.now() + 1}`, address: '', amount: '' }]
  setNotice('已开启新批次', 'info')
}

const canTransfer = computed(() => {
  if (!batch.value || !pre.value) return false
  if (!approveTx.value || approveTx.value.status !== 'CONFIRMED') return false
  const s = batch.value.status
  return s === 'UNSUBMITTED' || s === 'AWAITING_WALLET'
})
const txInFlight = computed(() => {
  const check = (t?: { status: string }) => t && (t.status === 'PENDING' || t.status === 'UNCERTAIN')
  return check(transferTx.value) || check(approveTx.value)
})

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择')
  }
}
</script>

<template>
  <div class="app-shell">
    <div class="page-header">
      <div>
        <h1>批量转账工作台</h1>
        <p class="subtitle">录入名单 → 核对 → 检查余额与授权 → 授权 → 批量转账 → 查询结果</p>
      </div>
      <div class="row-actions">
        <el-tag type="warning" effect="dark" size="large">模拟模式 · MOCK</el-tag>
        <el-tag :type="connected ? 'success' : 'info'" size="large">{{ connected ? '钱包已连接' : '钱包未连接' }}</el-tag>
      </div>
    </div>

    <div class="hint-box" style="margin-bottom: 18px">
      本应用为<strong>本地模拟模式</strong>，不涉及真实资金，无需私钥。提交交易只会得到交易哈希，<strong>成功状态只来自独立的模拟链查询结果</strong>；
      在「场景」中选择不同选项可独立触发授权拒绝、转账回滚、查询超时、余额不足、账户变化等情况。
    </div>

    <el-alert v-if="notice" :title="notice" :type="noticeType" show-icon :closable="false" style="margin-bottom: 18px" />

    <div class="grid-2">
      <!-- 左列：钱包 + 录入 -->
      <div>
        <div class="card">
          <h3 class="card-title">1 · 模拟钱包</h3>
          <div class="form-row">
            <label>付款账户</label>
            <el-input v-model="account" class="mono" :disabled="connected" placeholder="0x..." />
          </div>
          <div class="form-row">
            <label>网络</label>
            <el-select v-model="network" :disabled="connected || !config" style="width: 100%">
              <el-option :label="config ? `${config.chainId} · ${config.networkName}` : '加载中'" :value="config?.chainId ?? '31337'" />
              <el-option label="1 · Ethereum Mainnet（故意选错以验证网络校验）" value="1" />
            </el-select>
          </div>
          <div class="row-actions" style="margin-top: 12px">
            <el-button v-if="!connected" type="primary" @click="connectWallet">连接钱包</el-button>
            <el-button v-else @click="connected = false">断开钱包</el-button>
            <span class="muted">固定代币：{{ config?.token.symbol ?? 'MOCK' }}（精度 {{ config?.token.decimals ?? 6 }}）</span>
          </div>
        </div>

        <div class="card">
          <RecipientEditor ref="editorRef" v-model:rows="rows" :disabled="batchLocked" />
          <div class="form-row" style="margin-top: 14px">
            <label>模拟场景</label>
            <el-select v-model="scenario" :disabled="batchLocked" style="width: 100%">
              <el-option v-for="s in scenarios" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </div>
        </div>
      </div>

      <!-- 右列：核对 + 执行 -->
      <div>
        <div class="card">
          <h3 class="card-title">2 · 核对付款信息</h3>
          <div class="kv">
            <div class="k">付款账户</div><div class="v mono">{{ account }}</div>
            <div class="k">网络</div><div class="v">{{ network }}</div>
            <div class="k">代币</div><div class="v">{{ config?.token.name }} ({{ config?.token.symbol }}) · {{ config?.token.address }}</div>
            <div class="k">批量目标</div><div class="v mono">{{ config?.disperseAddress }}</div>
          </div>
          <table class="confirm-table" style="margin-top: 12px">
            <thead><tr><th>#</th><th>收款地址</th><th style="text-align: right">金额</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in rows" :key="r.id">
                <td>{{ i + 1 }}</td>
                <td class="mono">{{ r.address || '—' }}</td>
                <td style="text-align: right">{{ r.amount || '—' }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="total-row"><td colspan="2">总额</td><td style="text-align: right">{{ editorRef?.totalDisplay ?? '0' }} MOCK</td></tr>
            </tfoot>
          </table>
          <div class="confirm-lock">
            <el-checkbox v-model="confirmed" :disabled="batchLocked || !connected || !editorRef?.allValid">
              我已核对以上账户、网络、收款列表与总额，确认无误
            </el-checkbox>
            <div v-if="connected && !editorRef?.allValid" class="danger" style="font-size: 12px; margin-top: 6px">
              存在无效行，勾选已禁用。修改付款信息后需要重新核对确认。
            </div>
          </div>
          <div class="row-actions" style="margin-top: 16px">
            <el-button type="primary" :disabled="!confirmed || !connected || active || batchLocked" :loading="busy === 'create'" @click="doCreate">
              创建批次
            </el-button>
            <el-button v-if="batchLocked" @click="resetAll">开启新批次</el-button>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">3 · 执行状态</h3>
          <div v-if="!batch" class="muted">尚未创建批次。</div>
          <template v-else>
            <div class="status-line">
              <span>批次状态：</span>
              <el-tag :type="statusInfo.type" effect="dark">{{ statusInfo.label }}</el-tag>
              <span class="muted">requestId: {{ batch.requestId }}</span>
            </div>

            <div class="step-block">
              <div class="row-actions">
                <strong>检查余额与授权</strong>
                <el-button size="small" :disabled="active" :loading="busy === 'preflight'" @click="doPreflight">检查</el-button>
              </div>
              <div v-if="pre" class="kv" style="margin-top: 8px">
                <div class="k">代币余额</div><div class="v">{{ pre.balanceDisplay }} MOCK</div>
                <div class="k">已授权额度</div><div class="v">{{ pre.allowanceDisplay }} MOCK</div>
                <div class="k">本次所需</div><div class="v">{{ pre.requiredDisplay }} MOCK</div>
                <div class="k">余额检查</div><div class="v" :class="pre.sufficientBalance ? '' : 'danger'">{{ pre.sufficientBalance ? '充足' : '不足' }}</div>
                <div class="k">授权检查</div><div class="v">{{ pre.needsApproval ? '不足，需要授权本次额度' : '足够，跳过授权' }}</div>
              </div>
            </div>

            <div class="step-block">
              <div class="row-actions">
                <strong>授权交易</strong>
                <el-tag v-if="approveTx" :type="txStatusType[approveTx.status]" size="small">{{ approveTx.status }}</el-tag>
                <span class="spacer"></span>
                <el-button v-if="pre?.needsApproval && !approveTx" type="warning" size="small" :disabled="active" :loading="busy === 'approve'" @click="doApprove">
                  授权本次额度
                </el-button>
                <el-button v-if="approveTx && !['CONFIRMED','FAILED','REJECTED'].includes(approveTx.status)" size="small" :disabled="active" :loading="busy === 'recheck'" @click="doRecheck('APPROVE')">
                  查询授权结果
                </el-button>
              </div>
              <div v-if="approveTx" class="tx-hash mono" @click="copy(approveTx.txHash)">
                hash: {{ approveTx.txHash }} <span class="muted">（点击复制）</span>
              </div>
            </div>

            <div class="step-block">
              <div class="row-actions">
                <strong>转账交易</strong>
                <el-tag v-if="transferTx" :type="txStatusType[transferTx.status]" size="small">{{ transferTx.status }}</el-tag>
                <span class="spacer"></span>
                <el-button type="primary" size="small" :disabled="!canTransfer || txInFlight || active" :loading="busy === 'transfer'" @click="doTransfer">
                  提交批量转账
                </el-button>
                <el-button v-if="transferTx && !['CONFIRMED','FAILED','REJECTED'].includes(transferTx.status)" size="small" :disabled="active" :loading="busy === 'recheck'" @click="doRecheck('TRANSFER')">
                  重新查询原交易
                </el-button>
              </div>
              <div v-if="transferTx" class="tx-hash mono" @click="copy(transferTx.txHash)">
                hash: {{ transferTx.txHash }} <span class="muted">（点击复制）</span>
              </div>
              <div v-if="txInFlight" class="hint-box" style="margin-top: 8px">
                存在待确认或结果不确定的交易：已禁止通过重复点击/刷新重发；有哈希时可「重新查询原交易」。查询超时不代表链上失败。
              </div>
            </div>

            <div class="tx-timeline">
              <div v-for="t in batch.txs" :key="t.id" class="timeline-item">
                <el-tag size="small" :type="t.type === 'APPROVE' ? '' : 'success'">{{ t.type }}</el-tag>
                <span>{{ t.status }}</span>
                <span class="muted">查询 {{ t.recheckCount }} 次</span>
                <span class="mono muted">{{ t.txHash.slice(0, 14) }}…</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form-row { margin-bottom: 12px; }
.form-row label { display: block; font-size: 12px; color: #8492a6; margin-bottom: 6px; }
.confirm-lock { margin-top: 12px; padding: 10px 12px; background: #f7f9fc; border-radius: 6px; }
.step-block { border-top: 1px solid #eef0f5; padding: 12px 0; }
.step-block:first-of-type { border-top: none; }
.tx-hash { margin-top: 8px; color: #4c678f; background: #f4f7ff; padding: 6px 8px; border-radius: 4px; cursor: pointer; word-break: break-all; }
.tx-timeline { border-top: 1px solid #eef0f5; padding-top: 10px; }
.timeline-item { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; }
</style>
