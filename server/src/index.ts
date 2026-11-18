import Fastify, { type FastifyError } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONFIG } from './config.js'
import { AppError } from './types.js'
import { createBatch, getBatch, listBatches, preflight, submitApprove, submitTransfer, recheck, resetChain } from './service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = Fastify({ logger: { level: 'info' } })

await app.register(cors, { origin: true })

app.get('/api/health', async () => ({ ok: true, mode: 'MOCK' }))
app.get('/api/config', async () => ({ ...CONFIG, mode: 'MOCK' }))

app.post('/api/batches', async (request, reply) => {
  const result = createBatch(request.body)
  reply.code(result.reused ? 200 : 201)
  return { batch: result.batch, reused: result.reused }
})

app.get('/api/batches', async () => ({ items: listBatches() }))

app.get('/api/batches/:id', async (request) => {
  const { id } = request.params as { id: string }
  return { batch: getBatch(id) }
})

app.post('/api/batches/:id/preflight', async (request) => {
  const { id } = request.params as { id: string }
  const { account, network } = request.body as { account?: string; network?: string }
  if (!account || !network) throw new AppError(400, 'MISSING_ACCOUNT_OR_NETWORK', '缺少 account 或 network')
  return { preflight: preflight(id, account, network) }
})

app.post('/api/batches/:id/approve', async (request) => {
  const { id } = request.params as { id: string }
  const { account, network } = request.body as { account?: string; network?: string }
  if (!account || !network) throw new AppError(400, 'MISSING_ACCOUNT_OR_NETWORK', '缺少 account 或 network')
  return { tx: submitApprove(id, account, network) }
})

app.post('/api/batches/:id/transfer', async (request) => {
  const { id } = request.params as { id: string }
  const { account, network } = request.body as { account?: string; network?: string }
  if (!account || !network) throw new AppError(400, 'MISSING_ACCOUNT_OR_NETWORK', '缺少 account 或 network')
  return { tx: submitTransfer(id, account, network) }
})

app.post('/api/batches/:id/recheck', async (request) => {
  const { id } = request.params as { id: string }
  const { type } = (request.body ?? {}) as { type?: string }
  if (type !== 'APPROVE' && type !== 'TRANSFER') throw new AppError(400, 'INVALID_TX_TYPE', 'type 必须为 APPROVE 或 TRANSFER')
  return recheck(id, type)
})

/** 测试辅助：重置模拟链状态（余额/授权），仅用于可复现自测 */
app.post('/api/test/reset-chain', async () => {
  resetChain()
  return { ok: true }
})

app.setErrorHandler((error: FastifyError, request, reply) => {
  if (error instanceof AppError) {
    reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details }
    })
    return
  }
  // Fastify schema/JSON 解析等错误
  const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500
  reply.code(status).send({
    error: { code: 'INTERNAL_ERROR', message: error.message }
  })
})

// 生产模式托管前端静态文件（若已构建）
const webDist = path.resolve(__dirname, '../../web/dist')
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false })
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } })
    }
    return reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html'), 'utf-8'))
  })
}

const port = Number(process.env.PORT ?? 3001)
await app.listen({ port, host: '0.0.0.0' })
console.log(`[batch-transfer-workbench] API 已启动: http://localhost:${port}  mode=MOCK`)
