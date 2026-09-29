# 事件溯源 + 读写分离记账框架

一个教学性质的最小完整框架：账户聚合的所有变更都以**不可变事件**追加进事件流，
当前状态由事件回放重建；读模型是事件流投影出的余额汇总视图，可随时全量重算。
配一个朴素的 React 管理后台。

## 技术栈

- 后端：Node.js 20 + TypeScript + Fastify + `pg`
- 数据库：PostgreSQL 16
- 前端：React 18 + Vite（生产构建用 nginx 托管并反代 API）
- 测试：`node:test`，跑在真实 PostgreSQL 上（无 mock）

## 一键启动

```bash
docker compose up --build
```

- 前端页面：http://localhost:8080
- 后端接口：http://localhost:3000
- PostgreSQL：宿主端口 5433 → 容器 5432（用户/库/密码均为 ledger）

后端容器启动时自动执行 schema 迁移（`src/db/schema.sql`，幂等）。

## 模块划分

```
backend/src/
  db/                 连接池与 schema 迁移
  eventstore/
    eventStore.ts       事件存储：只追加、版本号连续、事务级 advisory lock 并发控制
    snapshotStore.ts    快照存储（同样不可变）
    accountRepository.ts聚合重建：快照 + 剩余事件回放；全量重放；打快照
  domain/
    account.ts          账户聚合：apply（纯函数回放）/ decide（命令→事件，业务校验）
    money.ts            金额：整数分，杜绝浮点误差
  readmodel/
    projection.ts       投影 fold 纯函数（增量与全量重放共用同一份逻辑）
    projector.ts        增量消费 catchUp / 全量重建 rebuild（checkpoint 事务推进）
    accountView.ts      读模型查询
  application/
    accountService.ts   命令应用服务：加载状态 → 校验生成事件 → 带版本追加 → 推进投影
  http/
    server.ts           Fastify 装配与统一错误处理
    routes.ts           HTTP 接口
  errors.ts             结构化应用错误（状态码 + code + details）
frontend/src/
  api.ts                后端接口客户端（前端不做任何业务计算）
  App.tsx               列表页 / 详情页切换
  components/
    AccountList.tsx     聚合列表 + 开户
    AccountDetail.tsx   当前状态、事件时间线（支持版本区间）、存入/支取、打快照
    ProjectionPanel.tsx 读模型状态与一键全量重放，结果直接展示对照
```

## 关键规则与设计决策

1. **事件不可变、只追加**：`event_store` 只有 INSERT 写入路径；
   PostgreSQL 触发器在数据库层面禁止 UPDATE/DELETE（有自动化测试锁死）。
2. **版本号**：每个聚合内从 1 开始严格连续；读取时校验连续性，出现空洞报
   `EVENT_VERSION_GAP`。
3. **乐观并发控制**：追加事件必须带 `expectedVersion`。
   事务内先取 per-aggregate `pg_advisory_xact_lock` 序列化两路写，再比对最新版本，
   不符则 409 `VERSION_CONFLICT`，响应体回带 `currentVersion` 供调用方重试。
4. **不存在聚合的策略**：**新建与变更分开**。
   - 新建只能走 `POST /api/accounts`（隐式 expectedVersion=0），服务端确认不存在才写；
     对已存在 id 再开户 → 409 `AGGREGATE_ALREADY_EXISTS`。
   - 对不存在的聚合发存款/取款/打快照 → 明确 404 `AGGREGATE_NOT_FOUND`
     （存储层直接以 expectedVersion>0 追加则返回 409）。
5. **快照**：快照状态由服务端重放事件算出（不接受外部传入状态）。
   无论是否走快照、快照打在哪个版本，`load()` 结果与忽略快照的
   `rebuildFromScratch()` **逐字段相等**（测试在 v1/v3/v7/v10 四个快照点验证）。
   快照版本超出最新事件版本 → 400 `SNAPSHOT_VERSION_OUT_OF_RANGE`。
6. **读写分离 / 投影一致性（最核心不变量）**：
   - 写模型：事件流；读模型：`accounts_rm` 余额汇总，由投影派生。
   - 增量 `catchUp` 与全量 `rebuild` 逐事件都走同一个纯函数 `applyProjectionEvent`，
     位点推进与行更新在同一事务提交；全量重建即 TRUNCATE 视图后从 global_seq=0 重放。
   - 测试强制以 batchSize=1/2/3 分批增量消费，再全量重算，逐行逐字段（含时间戳）比对一致。
7. **业务校验在生成事件之前**：余额不能取成负数（422 `BUSINESS_RULE_VIOLATION`），
   校验失败不产生任何事件，测试断言事件流版本与内容均无变化。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/accounts` | 开户（body: name, initialBalance, 可选 aggregateId） |
| GET  | `/api/accounts` | 读模型账户列表 + 投影位点 |
| GET  | `/api/accounts/:id` | 详情：读模型行、快照重建状态、无快照全量重放状态、快照列表 |
| POST | `/api/accounts/:id/deposit` | 存入（body: expectedVersion, amount） |
| POST | `/api/accounts/:id/withdraw` | 支取（body: expectedVersion, amount；透支 422） |
| GET  | `/api/accounts/:id/events?fromVersion=&toVersion=` | 事件时间线，区间为 `from < v <= to` |
| POST | `/api/accounts/:id/snapshots` | 打快照（body 可选 version，默认最新版本） |
| GET  | `/api/accounts/:id/snapshots` | 快照列表 |
| POST | `/api/projection/rebuild` | 读模型全量重放，返回重算结果 |
| GET  | `/api/projection/status` | 投影位点与视图 |

金额使用十进制字符串（元，最多两位小数，如 `"12.30"`），服务端内部转为整数分；
响应同时给出 `balance`（元）与 `balanceCents`（分）。

冲突响应示例：

```json
{ "error": { "code": "VERSION_CONFLICT",
  "message": "并发冲突：客户端期望版本 1，服务端最新版本 2",
  "details": { "aggregateId": "...", "expectedVersion": 1, "actualVersion": 2,
               "currentVersion": 2 } } }
```

## 本地开发

后端：

```bash
cd backend
npm install
# 需一个 PG16（docker compose up postgres -d 即可，宿主端口 5433）
DATABASE_URL=postgres://ledger:ledger@localhost:5433/ledger npm run migrate
DATABASE_URL=postgres://ledger:ledger@localhost:5433/ledger npm run dev
```

前端：

```bash
cd frontend
npm install
npm run dev   # 5173，/api 自动代理到 localhost:3000
```

## 测试

7 个测试文件、41 个用例，逐条锁死需求中的不变量：

| 文件 | 覆盖 |
| --- | --- |
| `1-append-replay` | 版本连续、全量回放、不存在聚合策略 |
| `2-concurrency` | **同版本并发仅一条成功、另一条 409**；冲突后重试；不同聚合互不影响 |
| `3-snapshots` | **多快照点重建与全量重放逐字段相等**；超界/重复/不存在错误 |
| `4-projection` | **小批量增量 vs 全量重算逐行一致**；重放幂等；与写模型余额一致 |
| `5-immutability` | **DB 层禁止 UPDATE/DELETE 事件与快照**；追加不改写历史；版本空洞检测 |
| `6-validation` | 透支/非法金额在生成事件前拒绝，事件流无变化 |
| `7-http` | 端到端：并发双写 201/409、422、快照、版本区间、投影重放 |

有 PostgreSQL 时（默认连 `localhost:5433/ledger_test`，库不存在会自动创建）：

```bash
cd backend && npm test
# 或指定：TEST_DATABASE_URL=postgres://ledger:ledger@localhost:5433/ledger_test npm test
```

本机没有数据库时，可用内置真实 PG 二进制的引导脚本（首次运行自动下载）：

```bash
cd backend && npm run test:embedded
```

## 范围边界

只做事件溯源、快照重建、读写分离这套机制本身：无鉴权/权限、无多聚合事务、
无跨聚合最终一致性之外的消息中间件。
