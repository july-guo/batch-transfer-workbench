# 批量转账工作台（模拟模式）

一个小型全栈应用：录入收款名单 → 核对付款信息 → 检查余额与授权 → 必要时授权 → 整批转账 → 查询结果。

- **模式**：本地模拟链 + 模拟钱包（全局明确标注 MOCK），不涉及真实资金，不需要私钥/助记词。
- **范围**：单条 EVM 测试网络（chainId `31337`）、单一 ERC-20 测试代币 `MOCK`，精度固定 6 位，每批 1–20 人。
- **栈**：Vue 3 + Vite + TypeScript + Element Plus（前端）；提供**两套接口完全兼容的后端**，可任选其一：
  - **Node.js 版**：Node.js 22 + Fastify + TypeScript + Node 内置 `node:sqlite`（目录 `server/`）
  - **Python 版**：Python 3.11+ + FastAPI + 标准库 `sqlite3`（目录 `server-python/`）
- 两套后端共用同一前端与同一套 REST 接口契约，行为、状态码、错误码与数据结构一致，切换无需改动前端。

> 设计重点：金额全程用整数最小单位（Node 用 `BigInt`、Python 用原生大整数 `int`）、服务端独立校验、幂等创建、成功状态只来自链查询、授权/转账分账、防重放与刷新恢复。

---

## 一、启动说明

前端只启动一次，后端在 Node.js 版与 Python 版之间**二选一**即可（都监听 `3001`，接口一致）。

### 1. 安装前端依赖（两种方案通用）

```bash
cd batch-transfer-workbench
npm install --registry=https://registry.npmjs.org
```

### 2A. 方案 A：Node.js 后端（默认）

环境：**Node.js ≥ 22.5**（需要内置 `node:sqlite`）。

```bash
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

数据库默认写入 `server/data/workbench.db`。

### 2B. 方案 B：Python 后端（接口等价）

环境：**Python ≥ 3.11**（本项目用 3.13 验证；仅用标准库 `sqlite3`，无需数据库服务）。

```bash
cd server-python
pip install -r requirements.txt          # fastapi / uvicorn / pydantic / pytest / httpx

# 启动后端（监听 3001，与前端代理一致）
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 3001
# 或： DB_PATH=:memory: python3 -m uvicorn app.main:app --port 3001
```

前端仍在项目根目录用 `npm run dev:web` 单独启动（前端 5173 会代理 `/api` 到 3001）：

```bash
cd .. && npm run dev:web
# 浏览器打开 http://localhost:5173
```

生产模式下，Python 后端在检测到 `web/dist` 存在时也会单端口托管前端，直接访问 `http://localhost:3001` 即可。

数据库默认写入 `server-python/data/workbench_py.db`（与 Node 版各自独立）。

> 说明：根目录 `npm run dev` 默认拉起 Node 后端。若要用 Python 后端，请按 2B 单独启动 Python 进程，并用 `npm run dev:web` 只启前端；两套后端不要同时监听 3001。

两套后端均支持用环境变量 `DB_PATH=:memory:` 使用内存数据库，Node 版另支持 `PORT` 覆盖端口。

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

## 五、自测

两套后端各自提供自动化测试，覆盖相同场景：

```bash
# Node.js 版（Vitest，19 项）
npm test

# Python 版（pytest，15 项）
cd server-python && DB_PATH=:memory: python3 -m pytest -q
```

覆盖范围：金额精度/非法输入、逐行校验、大小写重复地址、幂等、固定目标、六个场景、账户/网络变化、授权与转账分离、防重放。

手动可复现步骤（前端选择对应场景，对两套后端均适用）：

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

AI 用于：根据题目拆解方案与目录结构、生成前后端模块与类型定义、编写模拟链与状态机、补齐自测用例、实现与 Node 版接口等价的 Python 后端、撰写本文档。所有代码经人工审阅与本地自测验证；未使用任何真实资金或真实链上交易。

## 七、实际耗时

约 2 小时（含方案设计、编码与自测编写；AI 辅助生成）。

## 八、已知限制

- 仅模拟链，未接入真实 EVM 网络与真实钱包（题目允许，真实链能力记为未验证）。Node 版 `ChainAdapter` 接口、Python 版 `MockChain` 类均已预留替换点，可接入 ethers.js/viem（Node）或 web3.py（Python）。
- EVM 地址仅做格式与零地址校验，未做 EIP-55 checksum 校验。
- 模拟余额为单一账户的全局余额，未实现真实 ERC-20 记账与并发 nonce；"`查询超时`"为按查询次数模拟，非真实节点超时。
- 单用户本地应用，无登录/多租户权限；无文件导入导出。
- 模拟链状态（余额/授权）在后端进程内存中，重启后重置；批次与交易记录持久化在 SQLite。如需余额也持久化可扩展存储。
- 两套后端的数据库文件相互独立（Node `server/data/workbench.db`、Python `server-python/data/workbench_py.db`），切换后端不会共享已有批次数据；同一时刻只需运行其中一个。

---

## 九、目录结构

```
batch-transfer-workbench/
├── web/                    # 前端：Vue 3 + Vite + Element Plus（两套后端共用）
│   └── src/
├── server/                 # 后端 A：Node.js + Fastify + TypeScript
│   ├── src/
│   │   ├── index.ts        # HTTP 路由
│   │   ├── service.ts      # 幂等/状态机/防重放/授权转账
│   │   ├── validation.ts   # 服务端校验
│   │   ├── money.ts        # BigInt 精确金额
│   │   ├── db.ts           # node:sqlite 持久化
│   │   └── chain/          # 链适配接口 + 模拟链
│   └── test/               # Vitest 测试
└── server-python/          # 后端 B：Python + FastAPI（接口与 A 完全一致）
    ├── requirements.txt
    ├── app/
    │   ├── main.py         # FastAPI 路由
    │   ├── service.py      # 幂等/状态机/防重放/授权转账
    │   ├── validation.py   # 服务端校验
    │   ├── money.py        # 原生 int 精确金额
    │   ├── db.py           # sqlite3 持久化
    │   ├── errors.py       # 统一错误
    │   └── chain/mock.py   # 模拟链
    └── tests/              # pytest 测试
```
