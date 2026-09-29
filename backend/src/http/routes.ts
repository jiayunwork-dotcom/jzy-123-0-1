import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { AccountService } from '../application/accountService';
import { AccountView } from '../readmodel/accountView';
import { Projector } from '../readmodel/projector';
import {
  AppError,
  InvalidVersionRangeError,
} from '../errors';
import { formatCents } from '../domain/money';
import { StoredEvent } from '../eventstore/eventStore';

const amountSchema = {
  type: 'string',
  pattern: '^\\d+(\\.\\d{1,2})?$',
} as const;

export interface Container {
  pool: Pool;
  accountService: AccountService;
  accountView: AccountView;
  projector: Projector;
}

export function registerRoutes(app: FastifyInstance, c: Container): void {
  // --- 系统 -------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok' }));

  // --- 写模型：命令 ------------------------------------------------------

  // 开户：对不存在聚合“按新建处理”的唯一入口（期望版本隐式为 0）
  app.post(
    '/api/accounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'initialBalance'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            initialBalance: amountSchema,
            aggregateId: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: { name: string; initialBalance: string; aggregateId?: string } }>, reply: FastifyReply) => {
      const result = await c.accountService.openAccount(req.body);
      return reply.code(201).send(serializeCommandResult(result));
    },
  );

  app.post(
    '/api/accounts/:id/deposit',
    {
      schema: {
        body: {
          type: 'object',
          required: ['expectedVersion', 'amount'],
          additionalProperties: false,
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            amount: amountSchema,
          },
        },
      },
    },
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { expectedVersion: number; amount: string } }>,
      reply: FastifyReply,
    ) => {
      const result = await c.accountService.deposit(req.params.id, req.body.expectedVersion, req.body.amount);
      return reply.code(201).send(serializeCommandResult(result));
    },
  );

  app.post(
    '/api/accounts/:id/withdraw',
    {
      schema: {
        body: {
          type: 'object',
          required: ['expectedVersion', 'amount'],
          additionalProperties: false,
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            amount: amountSchema,
          },
        },
      },
    },
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { expectedVersion: number; amount: string } }>,
      reply: FastifyReply,
    ) => {
      const result = await c.accountService.withdraw(req.params.id, req.body.expectedVersion, req.body.amount);
      return reply.code(201).send(serializeCommandResult(result));
    },
  );

  // 手动打快照
  app.post(
    '/api/accounts/:id/snapshots',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { version?: number } }>,
      reply: FastifyReply,
    ) => {
      const snapshot = await c.accountService.createSnapshot(req.params.id, req.body?.version);
      return reply.code(201).send(serializeSnapshot(snapshot));
    },
  );

  app.get('/api/accounts/:id/snapshots', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const snapshots = await c.accountService.repository.snapshots.list(req.params.id);
    return { snapshots: snapshots.map(serializeSnapshot) };
  });

  // --- 读模型：查询 ------------------------------------------------------

  app.get('/api/accounts', async () => {
    const accounts = await c.accountView.list();
    const checkpoint = await c.accountView.checkpoint();
    return {
      accounts: accounts.map((a) => ({
        ...serializeReadAccount(a),
      })),
      projection: {
        lastGlobalSeq: checkpoint.lastGlobalSeq,
        updatedAt: checkpoint.updatedAt.toISOString(),
      },
    };
  });

  app.get('/api/accounts/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    // 读模型行（余额汇总视图）
    const readRow = await c.accountView.get(req.params.id);
    // 从写模型事件重建出的当前状态（可能用了快照）
    const rebuilt = await c.accountService.repository.load(req.params.id);
    const scratch = await c.accountService.repository.rebuildFromScratch(req.params.id);
    const snapshots = await c.accountService.repository.snapshots.list(req.params.id);

    return {
      aggregateId: req.params.id,
      readModel: readRow ? serializeReadAccount(readRow) : null,
      currentState: {
        id: rebuilt.state.id,
        name: rebuilt.state.name,
        balanceCents: rebuilt.state.balanceCents,
        balance: formatCents(rebuilt.state.balanceCents),
        version: rebuilt.state.version,
      },
      // 全量重放结果一并给出，方便前端直接对照“快照重建 == 全量重放”
      fullReplayState: {
        id: scratch.id,
        name: scratch.name,
        balanceCents: scratch.balanceCents,
        balance: formatCents(scratch.balanceCents),
        version: scratch.version,
      },
      usedSnapshotVersion: rebuilt.usedSnapshot?.version ?? null,
      snapshots: snapshots.map(serializeSnapshot),
    };
  });

  // 事件时间线：支持版本区间（fromVersion < v <= toVersion），默认全部
  app.get(
    '/api/accounts/:id/events',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { fromVersion?: string; toVersion?: string };
      }>,
    ) => {
      const fromVersion = req.query.fromVersion !== undefined ? Number(req.query.fromVersion) : 0;
      const toVersion = req.query.toVersion !== undefined ? Number(req.query.toVersion) : undefined;

      if (!Number.isInteger(fromVersion) || fromVersion < 0) {
        throw new InvalidVersionRangeError(fromVersion, toVersion ?? -1);
      }
      if (toVersion !== undefined && (!Number.isInteger(toVersion) || toVersion <= fromVersion)) {
        throw new InvalidVersionRangeError(fromVersion, toVersion);
      }

      // 确保聚合存在，不存在给出明确 404
      await c.accountService.repository.load(req.params.id);
      const events = await c.accountService.repository.readRange(
        req.params.id,
        fromVersion,
        toVersion,
      );
      return { aggregateId: req.params.id, events: events.map(serializeEvent) };
    },
  );

  // --- 读模型全量重放 ----------------------------------------------------

  app.post('/api/projection/rebuild', async (_req, reply: FastifyReply) => {
    const result = await c.projector.rebuild();
    const accounts = await c.accountView.list();
    return reply.code(200).send({
      status: 'rebuilt',
      processed: result.processed,
      lastGlobalSeq: result.lastGlobalSeq,
      accounts: accounts.map(serializeReadAccount),
    });
  });

  app.get('/api/projection/status', async () => {
    const checkpoint = await c.accountView.checkpoint();
    const accounts = await c.accountView.list();
    return {
      projection: 'accounts',
      lastGlobalSeq: checkpoint.lastGlobalSeq,
      updatedAt: checkpoint.updatedAt.toISOString(),
      accountCount: accounts.length,
      accounts: accounts.map(serializeReadAccount),
    };
  });
}

function serializeCommandResult(result: { aggregateId: string; currentVersion: number; events: StoredEvent[] }) {
  return {
    aggregateId: result.aggregateId,
    currentVersion: result.currentVersion,
    events: result.events.map(serializeEvent),
  };
}

function serializeEvent(event: {
  globalSeq: number;
  version: number;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}) {
  return {
    globalSeq: event.globalSeq,
    version: event.version,
    eventType: event.eventType,
    payload: event.payload,
    metadata: event.metadata,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function serializeSnapshot(snapshot: {
  aggregateId: string;
  version: number;
  state: Record<string, unknown>;
  createdAt: Date;
}) {
  return {
    aggregateId: snapshot.aggregateId,
    version: snapshot.version,
    state: snapshot.state,
    createdAt: snapshot.createdAt.toISOString(),
  };
}

function serializeReadAccount(a: {
  aggregateId: string;
  name: string;
  balanceCents: number;
  version: number;
  eventCount: number;
  openedAt: Date;
  updatedAt: Date;
}) {
  return {
    aggregateId: a.aggregateId,
    name: a.name,
    balanceCents: a.balanceCents,
    balance: formatCents(a.balanceCents),
    version: a.version,
    eventCount: a.eventCount,
    openedAt: a.openedAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export { AppError };
