<script setup lang="ts">
import { computed } from 'vue'
import type { Recipient } from '../types'
import { isValidAddress, parseAmount, formatMinUnit } from '../money'

const props = defineProps<{
  rows: Recipient[]
  disabled: boolean
}>()
const emit = defineEmits<{
  (e: 'update:rows', rows: Recipient[]): void
}>()

let seq = 100
function newRow(): Recipient {
  return { id: `r${seq++}`, address: '', amount: '' }
}

function addRow() {
  if (props.rows.length >= 20) return
  emit('update:rows', [...props.rows, newRow()])
}
function removeRow(id: string) {
  emit('update:rows', props.rows.filter((r) => r.id !== id))
}
function patch(id: string, key: 'address' | 'amount', value: string) {
  emit('update:rows', props.rows.map((r) => (r.id === id ? { ...r, [key]: value } : r)))
}

/** 逐行校验：与后端同规则。返回 key=行ID 的错误信息 */
const rowErrors = computed<Record<string, { address?: string; amount?: string }>>(() => {
  const errs: Record<string, { address?: string; amount?: string }> = {}
  const seen = new Map<string, number>()
  props.rows.forEach((r, i) => {
    const e: { address?: string; amount?: string } = {}
    if (!isValidAddress(r.address)) e.address = '不是有效 EVM 地址或为零地址'
    else {
      const norm = r.address.trim().toLowerCase()
      if (seen.has(norm)) {
        e.address = `与第 ${seen.get(norm)! + 1} 行地址重复`
      } else seen.set(norm, i)
    }
    if (parseAmount(r.amount) === null) e.amount = '金额须 >0、最多 6 位小数，不接受科学计数法'
    if (e.address || e.amount) errs[r.id] = e
  })
  return errs
})

const errorCount = computed(() => Object.keys(rowErrors.value).length)
const totalMinUnit = computed(() =>
  props.rows.reduce((sum, r) => {
    const v = parseAmount(r.amount)
    return sum + (v ?? 0n)
  }, 0n)
)
const totalDisplay = computed(() => formatMinUnit(totalMinUnit.value))
const allValid = computed(() => props.rows.length >= 1 && props.rows.length <= 20 && errorCount.value === 0)

defineExpose({ allValid, totalMinUnit, totalDisplay, errorCount })
</script>

<template>
  <div>
    <div class="editor-head">
      <span class="card-title" style="margin: 0">收款名单</span>
      <span class="muted">每行包含地址与金额，精度 6 位</span>
      <span class="spacer"></span>
      <el-button size="small" :disabled="disabled || rows.length >= 20" @click="addRow">+ 添加收款人</el-button>
    </div>

    <div class="table-wrap">
      <table class="editor-table">
        <thead>
          <tr>
            <th style="width: 46px">#</th>
            <th>收款地址</th>
            <th style="width: 190px">金额 (MOCK)</th>
            <th style="width: 56px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="row.id">
            <td class="idx">{{ i + 1 }}</td>
            <td>
              <el-input
                v-model="row.address"
                :disabled="disabled"
                size="default"
                placeholder="0x..."
                class="mono"
                :class="{ 'input-error': rowErrors[row.id]?.address }"
              />
              <div v-if="rowErrors[row.id]?.address" class="row-error">{{ rowErrors[row.id].address }}</div>
            </td>
            <td>
              <el-input
                v-model="row.amount"
                :disabled="disabled"
                size="default"
                placeholder="例如 12.500000"
                :class="{ 'input-error': rowErrors[row.id]?.amount }"
              />
              <div v-if="rowErrors[row.id]?.amount" class="row-error">{{ rowErrors[row.id].amount }}</div>
            </td>
            <td>
              <el-button text type="danger" :disabled="disabled || rows.length <= 1" @click="removeRow(row.id)">删除</el-button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="editor-foot">
      <span :class="errorCount ? 'danger' : 'muted'">
        {{ errorCount ? `${errorCount} 行存在错误，修正后方可提交` : '全部行校验通过' }}
      </span>
      <span class="spacer"></span>
      <span>合计：<strong>{{ totalDisplay }}</strong> MOCK</span>
      <span class="muted">（最小单位 {{ totalMinUnit.toString() }}）</span>
    </div>
  </div>
</template>

<style scoped>
.editor-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.table-wrap { overflow-x: auto; }
.editor-table { width: 100%; border-collapse: collapse; }
.editor-table th { text-align: left; font-size: 12px; color: #8492a6; font-weight: 500; padding: 0 8px 8px 0; }
.editor-table td { padding: 4px 8px 6px 0; vertical-align: top; }
.editor-table .idx { color: #97a3b6; font-size: 13px; padding-top: 12px; width: 46px; }
.input-error :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px #d03050 inset; }
.row-error { color: #d03050; font-size: 11px; margin-top: 3px; }
.editor-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding-top: 12px; border-top: 1px dashed #e6ebf2; font-size: 13px; flex-wrap: wrap; }
</style>
