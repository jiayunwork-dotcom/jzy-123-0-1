import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ConcurrencyError, AggregateAlreadyExistsError, VersionGapError } from '../errors';

export interface StoredEvent {
  globalSeq: number;
  aggregateId: string;
  aggregateType: string;
  /** 聚合内严格递增且连续的版本号，从 1 开始 */
  version: number;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

export interface NewEvent {
  eventType: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface MapRow {
  global_seq: number;
  aggregate_id: string;
  aggregate_type: string;
  version: string | number;
  event_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

function mapEvent(row: QueryResultRow): StoredEvent {
  const r = row as MapRow;
  return {
    globalSeq: Number(r.global_seq),
    aggregateId: r.aggregate_id,
    aggregateType: r.aggregate_type,
    version: Number(r.version),
    eventType: r.event_type,
    payload: r.payload,
    metadata: r.metadata ?? {},
    occurredAt: r.occurred_at,
  };
}

/**
 * 事件存储：所有聚合共享一张 event_store 表。
 * - 只追加：INSERT 是唯一写入路径（数据库触发器再禁 UPDATE/DELETE）
 * - 版本号在每个聚合内从 1 开始、严格连续
 * - append 时做事务级 per-aggregate 咨询锁 + 期望版本校验，保证并发提交只有一条成功
 */
export class EventStore {
  constructor(private readonly pool: Pool) {}

  /**
   * 向某个聚合追加事件（当前框架一次提交一条，接口保留批量能力）。
   *
   * @param expectedVersion 客户端认为的当前版本。
   *   - 新聚合：0（服务端确认不存在才允许创建）
   *   - 已有聚合：必须等于服务端最新版本，否则并发冲突
   */
  async append(
    aggregateId: string,
    aggregateType: string,
    expectedVersion: number,
    events: NewEvent[],
  ): Promise<StoredEvent[]> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error(`expectedVersion 必须是非负整数，收到: ${expectedVersion}`);
    }
    if (events.length === 0) {
      return [];
    }

    return this.withTransaction(async (client) => {
      // pg_advisory_xact_lock 在事务提交/回滚时自动释放。
      // 序列化同一聚合上的两个并发追加事务，使“读最新版本 → 比对 → 插入”不交叉。
      await client.query('SELECT pg_advisory_xact_lock($1)', [this.lockKey(aggregateId)]);

      const latest = await this.currentVersionWith(client, aggregateId);

      if (expectedVersion === 0 && latest > 0) {
        throw new AggregateAlreadyExistsError(aggregateId, latest);
      }
      if (expectedVersion > 0 && latest === 0) {
        // 对不存在的已有聚合的策略：明确拒绝（新建只能走 expectedVersion=0）
        throw new ConcurrencyError(aggregateId, expectedVersion, 0);
      }
      if (latest !== expectedVersion) {
        throw new ConcurrencyError(aggregateId, expectedVersion, latest);
      }

      const stored: StoredEvent[] = [];
      for (const [index, event] of events.entries()) {
        const version = expectedVersion + index + 1;
        const result: QueryResult = await client.query(
          `INSERT INTO event_store
             (aggregate_id, aggregate_type, version, event_type, payload, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            aggregateId,
            aggregateType,
            version,
            event.eventType,
            JSON.stringify(event.payload),
            JSON.stringify(event.metadata ?? {}),
          ],
        );
        stored.push(mapEvent(result.rows[0]));
      }
      return stored;
    });
  }

  /** 读取某聚合的完整事件流（按版本升序），并校验版本连续性。 */
  async readStream(aggregateId: string): Promise<StoredEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM event_store
       WHERE aggregate_id = $1
       ORDER BY version ASC`,
      [aggregateId],
    );
    const events = result.rows.map(mapEvent);
    this.assertContiguous(aggregateId, events);
    return events;
  }

  /** 按版本区间读取某聚合的事件：fromVersion < version <= toVersion（左开右闭）。 */
  async readRange(
    aggregateId: string,
    fromVersion: number,
    toVersion?: number,
  ): Promise<StoredEvent[]> {
    const params: unknown[] = [aggregateId, fromVersion];
    let sql = `SELECT * FROM event_store
               WHERE aggregate_id = $1 AND version > $2`;
    if (toVersion !== undefined) {
      sql += ' AND version <= $3';
      params.push(toVersion);
    }
    sql += ' ORDER BY version ASC';
    const result = await this.pool.query(sql, params);
    const events = result.rows.map(mapEvent);
    // 区间内也不允许存在空洞
    this.assertContiguous(aggregateId, events, fromVersion + 1);
    return events;
  }

  /** 按全局顺序读取事件（投影消费用）：globalSeq > afterGlobalSeq。 */
  async readGlobal(
    afterGlobalSeq: number,
    limit: number,
    client?: PoolClient,
  ): Promise<StoredEvent[]> {
    const runner = client ?? this.pool;
    const result = await runner.query(
      `SELECT * FROM event_store
       WHERE global_seq > $1
       ORDER BY global_seq ASC
       LIMIT $2`,
      [afterGlobalSeq, limit],
    );
    return result.rows.map(mapEvent);
  }

  async currentVersion(aggregateId: string, client?: PoolClient): Promise<number> {
    const runner = client ?? this.pool;
    const result = await runner.query(
      'SELECT COALESCE(MAX(version), 0) AS v FROM event_store WHERE aggregate_id = $1',
      [aggregateId],
    );
    return Number(result.rows[0].v);
  }

  private async currentVersionWith(client: PoolClient, aggregateId: string): Promise<number> {
    const result = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS v FROM event_store WHERE aggregate_id = $1',
      [aggregateId],
    );
    return Number(result.rows[0].v);
  }

  /** 校验事件序列版本是否连续，不连续直接判为存储损坏。 */
  assertContiguous(
    aggregateId: string,
    events: StoredEvent[],
    startVersion = 1,
  ): void {
    let expected = startVersion;
    for (const event of events) {
      if (event.version !== expected) {
        throw new VersionGapError(aggregateId, expected, event.version);
      }
      expected += 1;
    }
  }

  private async withTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // 兜底：唯一约束冲突（aggregate_id, version）也翻译成并发冲突
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
      ) {
        throw new ConcurrencyError(aggregateIdOf(err) ?? 'unknown', -1, -1);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 把字符串聚合 id 稳定映射到 bigint advisory lock key。
   * 取字符串 FNV-1a 64 位哈希（PostgreSQL 接受负数 bigint，不影响加锁语义）。
   */
  private lockKey(aggregateId: string): bigint {
    let hash = 0xcbf29ce484222325n;
    for (const char of aggregateId) {
      hash ^= BigInt(char.codePointAt(0) ?? 0);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    // 转为有符号 64 位
    return BigInt.asIntN(64, hash);
  }
}

function aggregateIdOf(_err: unknown): string | undefined {
  // 唯一约束兜底路径没有聚合上下文（正常已在锁内显式判定），返回 unknown 占位
  return undefined;
}
