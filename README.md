# 批量转账工作台（模拟模式）

一个小型全栈应用：录入收款名单 → 核对付款信息 → 检查余额与授权 → 必要时授权 → 整批转账 → 查询结果。

- **模式**：本地模拟链 + 模拟钱包（全局明确标注 MOCK），不涉及真实资金，不需要私钥/助记词。
- **范围**：单条 EVM 测试网络（chainId `31337`）、单一 ERC-20 测试代币 `MOCK`，精度固定 6 位，每批 1–20 人。
- **栈**：Vue 3 + Vite + TypeScript + Element Plus（前端）；Node.js 22 + Fastify + TypeScript + Node 内置 SQLite（后端）。

> 设计重点：金额全程 `BigInt` 最小单位、服务端独立校验、幂等创建、成功状态只来自链查询、授权/转账分账、防重放与刷新恢复。

---

## 一、启动说明

环境：**Node.js ≥ 22.5**（需要内置 `node:sqlite`）。依赖用官方源安装。

```bash
cd batch-transfer-workbench
npm install --registry=https://registry.npmjs.org

# 开发模式：前端(5173) + 后端(3001) 同时启动
npm run dev
# 浏览器打开 http://localhost:5173

# 生产模式：构建前端后由后端单端口托管
npm run build
npm start
# 浏览器打开 http://localhost:3001

# 自测
npm test
```

后端数据库默认写入 `server/data/workbench.db`（创建批次与交易状态持久化，浏览器刷新、后端重启后仍可查询）。可用环境变量 `DB_PATH=:memory:`、PORT 覆盖。

---

## 二、模拟模式与场景触发

创建批次时在请求体的 `scenario` 字段选择，前端「模拟场景」下拉可直接操作：

| 场景 | 触发行为 |
|---|---|
| `SUCCESS` | 授权与转账均确认成功 |
| `APPROVE_REJECTED` | 授权交易被拒绝 |
| `TRANSFER_REVERT` | 转账交易回滚 |
| `QUERY_TIMEOUT` | 转账首次查询返回 UNCERTAIN，再次查询揭晓成功 |
| `INSUFFICIENT_BALANCE` | 余额不足（用超大收款金额触发预检提示） |
| `ACCOUNT_CHANGED` | 模拟链报告账户变化，阻止沿用旧确认 |

不同场景可独立触发，不是固定成功演示。模拟链状态由服务端维护，成功与否**只能**通过 `recheck` 查询获得，客户端无法声明成功。

---

## 三、流程与状态

```
连接钱包 → 核对批次 → 检查余额与授权 → 必要时授权 → 提交转账 → 查询结果
```

批次状态（界面与 `GET /api/batches/:id` 均可查）：
`UNSUBMITTED` 尚未提交 / `AWAITING_WALLET` 等待钱包 / `SUBMITTED_PENDING` 已提交待确认 / `CONFIRMED` 已确认成功 / `FAILED` 明确失败 / `REJECTED` 用户拒绝 / `UNCERTAIN` 结果暂时无法确定。

关键约束实现：
- 拿到交易哈希仅置 `PENDING`，批次状态不会因此变成成功。
- 查询超时置 `UNCERTAIN`，**不判失败**。
- 存在 `PENDING`/`UNCERTAIN` 交易时，服务端拒绝再次发起转账（`TRANSFER_IN_FLIGHT`）；有哈希可重复查询原交易。
- 授权交易与转账交易分表存储，状态与哈希互不混用；授权未确认不能转账。
- 刷新页面只从本地记录恢复展示，不自动重新签名或转账。
- 代币、批量目标、spender 全部来自服务端固定配置，请求无法指定；目标地址来自配置（真实链由 `getCode` 校验，模拟模式由固定配置保证）。
- 整批一次调用，语义 `disperseToken(address token, address[] recipients, uint256[] values)`，金额用最小单位，原生币 `value = 0`，整笔成功或回滚。

---

## 四、接口文档

所有响应错误格式：`{ "error": { "code": "...", "message": "...", "details": [...] } }`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回模式 |
| GET | `/api/config` | 固定配置（chainId、代币、目标、spender） |
| POST | `/api/batches` | 创建批次（幂等）。201 新建 / 200 复用 |
| GET | `/api/batches` | 批次列表 |
| GET | `/api/batches/:id` | 查询单个批次（含交易列表） |
| POST | `/api/batches/:id/preflight` | 余额/授权预检，body: `{account, network}` |
| POST | `/api/batches/:id/approve` | 提交授权，body: `{account, network}` |
| POST | `/api/batches/:id/transfer` | 提交转账，body: `{account, network}` |
| POST | `/api/batches/:id/recheck` | 查询交易，body: `{type: "APPROVE"｜"TRANSFER"}` |
| POST | `/api/test/reset-chain` | 测试用：重置模拟链余额/授权 |

### 创建批次请求体

```json
{
  "requestId": "uuid-v4",
  "chainId": "31337",
  "fromAddress": "0xaaaa...",
  "tokenAddress": "0x1111...",
  "scenario": "SUCCESS",
  "recipients": [
    { "address": "0x1111...", "amount": "1.5" },
    { "address": "0x2222...", "amount": "2.25" }
  ]
}
```

`requestId` 由客户端生成并用于幂等：相同 ID + 相同内容返回原批次（不重复建单）；相同 ID + 不同内容返回 `409 IDEMPOTENCY_CONFLICT`。

### 批次数据结构（保存规范化结果）

```json
{
  "id": "...", "requestId": "...", "chainId": "31337",
  "fromAddress": "0x...", "tokenAddress": "0x...",
  "recipients": [{ "address": "0x...（小写）", "amountMinUnit": "1500000" }],
  "totalMinUnit": "3750000", "totalDisplay": "3.75",
  "scenario": "SUCCESS", "status": "CONFIRMED",
  "createdAt": "...", "updatedAt": "...",
  "txs": [
    { "type": "APPROVE", "txHash": "0x...", "status": "CONFIRMED", "recheckCount": 1 },
    { "type": "TRANSFER", "txHash": "0x...", "status": "CONFIRMED", "recheckCount": 1 }
  ]
}
```

---

## 五、自测（`npm test`）

Vitest 覆盖：金额精度/非法输入、逐行校验、大小写重复地址、幂等、固定目标、六个场景、账户/网络变化、授权与转账分离。

手动可复现步骤（前端选择对应场景）：

1. **正常完成**：SUCCESS → 连接 → 录入 → 确认 → 创建 → 检查 → 授权 → 自动查询 → 提交转账 → 自动查询 → 已确认成功。
2. **无效输入**：录入零地址 / 重复地址（大小写不同）/ `1.1234567` / `1e3`，对应行显示错误且无法创建。
3. **授权被拒绝**：APPROVE_REJECTED → 授权 → 查询结果 REJECTED，转账按钮不可用。
4. **转账回滚**：TRANSFER_REVERT → 授权确认 → 转账 → 结果 FAILED，授权仍为 CONFIRMED。
5. **查询超时**：QUERY_TIMEOUT → 转账 → 首次查询 UNCERTAIN（禁止重发）→ 再次查询 CONFIRMED。
6. **连点与刷新**：提交转账后连点「提交批量转账」无效（后端 `TRANSFER_IN_FLIGHT`）；刷新页面恢复记录、不自动重发，有哈希可「重新查询原交易」。
7. **余额不足**：INSUFFICIENT_BALANCE + 20 行大额 → 检查显示余额不足。
8. **账户/网络变化**：ACCOUNT_CHANGED 或切换网络 → 操作被 `ACCOUNT_CHANGED` / `NETWORK_CHANGED` 阻止。

---

## 六、AI 使用方式简述

AI 用于：根据题目拆解方案与目录结构、生成前后端模块与类型定义、编写模拟链与状态机、补齐自测用例、撰写本文档。所有代码经人工审阅与本地自测验证；未使用任何真实资金或真实链上交易。

## 七、实际耗时

约 2 小时（含方案设计、编码与自测编写；AI 辅助生成）。

## 八、已知限制

- 仅模拟链，未接入真实 EVM 网络与真实钱包（题目允许，真实链能力记为未验证）。`ChainAdapter` 接口已预留，可替换为 ethers.js/viem 实现。
- EVM 地址仅做格式与零地址校验，未做 EIP-55 checksum 校验。
- 模拟余额为单一账户的全局余额，未实现真实 ERC-20 记账与并发nonce；"`查询超时`"为按查询次数模拟，非真实节点超时。
- 单用户本地应用，无登录/多租户权限；无文件导入导出。
- 模拟链状态（余额/授权）在后端进程内存中，重启后重置；批次与交易记录持久化在 SQLite。如需余额也持久化可扩展存储。
