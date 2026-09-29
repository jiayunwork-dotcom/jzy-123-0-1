import { Pool, PoolClient } from 'pg';
import { EventStore, StoredEvent } from '../eventstore/eventStore';
import { AccountReadRow, applyProjectionEvent } from './projection';

const PROJECTION_NAME = 'accounts';

export interface CatchUpResult {
  processed: number;
  lastGlobalSeq: number;
}

/**
 * 账户投影器：把 event_store 消费成 accounts_rm 读模型。
 *
 * 两条消费路径：
 *  - catchUp()：从 checkpoint 位点之后增量消费（每次写命令成功后触发，外加定时兜底）
 *  - rebuild()：TRUNCATE 读模型并从 global_seq=0 全量重放整条事件流
 *
 * 两条路径逐事件都走 applyProjectionEvent 这个纯函数，且位点推进与行更新
 * 在同一个事务里提交，因此重放结果与增量结果必然逐行一致。
 */
export class Projector {
  constructor(
    private readonly pool: Pool,
    private readonly eventStore: EventStore = new EventStore(pool),
    private readonly batchSize = 500,
  ) {}

  /** 增量消费到事件流末尾。幂等：无新事件时 processed=0。 */
  async catchUp(): Promise<CatchUpResult> {
    const client = await this.pool.connect();
    let processed = 0;
    try {
      for (;;) {
        await client.query('BEGIN');
        const checkpoint = await this.readCheckpoint(client);
        const events = await this.eventStore.readGlobal(
          checkpoint,
          this.batchSize,
          client,
        );
        if (events.length === 0) {
          await client.query('ROLLBACK');
          return { processed, lastGlobalSeq: checkpoint };
        }
        for (const event of events) {
          await this.projectOne(client, event);
        }
        const lastGlobalSeq = events[events.length - 1].globalSeq;
        await this.writeCheckpoint(client, lastGlobalSeq);
        await client.query('COMMIT');
        processed += events.length;
        if (events.length < this.batchSize) {
          return { processed, lastGlobalSeq };
        }
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 全量重建：清空读模型、位点归零，从第一条事件依次播放。
   * 事件流本身一行都不会动。
   */
  async rebuild(): Promise<CatchUpResult> {
    const client = await this.pool.connect();
    let processed = 0;
    try {
      for (;;) {
        await client.query('BEGIN');
        if (processed === 0) {
          // 第一批：清空旧视图与位点（TRUNCATE 不受不可变触发器限制，accounts_rm 是派生表）
          await client.query('TRUNCATE TABLE accounts_rm');
          await this.writeCheckpoint(client, 0);
        }
        const checkpoint = processed === 0 ? 0 : await this.readCheckpoint(client);
        const events = await this.eventStore.readGlobal(
          checkpoint,
          this.batchSize,
          client,
        );
        if (events.length === 0) {
          await client.query('COMMIT');
          return { processed, lastGlobalSeq: checkpoint };
        }
        for (const event of events) {
          await this.projectOne(client, event);
        }
        const lastGlobalSeq = events[events.length - 1].globalSeq;
        await this.writeCheckpoint(client, lastGlobalSeq);
        await client.query('COMMIT');
        processed += events.length;
        if (events.length < this.batchSize) {
          return { processed, lastGlobalSeq };
        }
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async projectOne(client: PoolClient, event: StoredEvent): Promise<void> {
    const { rows } = await client.query(
      `SELECT aggregate_id, name, balance_cents, version, event_count, opened_at, updated_at
       FROM accounts_rm WHERE aggregate_id = $1 FOR UPDATE`,
      [event.aggregateId],
    );
    const prev: AccountReadRow | null = rows.length === 0 ? null : {
      aggregateId: rows[0].aggregate_id,
      name: rows[0].name,
      balanceCents: Number(rows[0].balance_cents),
      version: Number(rows[0].version),
      eventCount: Number(rows[0].event_count),
      openedAt: rows[0].opened_at,
      updatedAt: rows[0].updated_at,
    };

    const next = applyProjectionEvent(prev, event);

    if (prev === null) {
      await client.query(
        `INSERT INTO accounts_rm
           (aggregate_id, name, balance_cents, version, event_count, opened_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          next.aggregateId,
          next.name,
          next.balanceCents,
          next.version,
          next.eventCount,
          next.openedAt,
          next.updatedAt,
        ],
      );
    } else {
      // 版本守卫：只有行仍停留在 event.version-1 时才允许推进
      const result = await client.query(
        `UPDATE accounts_rm
         SET name = $2, balance_cents = $3, version = $4,
             event_count = $5, opened_at = $6, updated_at = $7
         WHERE aggregate_id = $1 AND version = $8`,
        [
          next.aggregateId,
          next.name,
          next.balanceCents,
          next.version,
          next.eventCount,
          next.openedAt,
          next.updatedAt,
          prev.version,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error(
          `投影更新失败：账户 ${event.aggregateId} 版本 ${event.version} 行未推进`,
        );
      }
    }
  }

  private async readCheckpoint(client: PoolClient): Promise<number> {
    const { rows } = await client.query(
      `SELECT last_global_seq FROM projection_checkpoint
       WHERE projection_name = $1 FOR UPDATE`,
      [PROJECTION_NAME],
    );
    return Number(rows[0].last_global_seq);
  }

  private async writeCheckpoint(client: PoolClient, seq: number): Promise<void> {
    await client.query(
      `INSERT INTO projection_checkpoint (projection_name, last_global_seq, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (projection_name) DO UPDATE
         SET last_global_seq = EXCLUDED.last_global_seq,
             updated_at = now()`,
      [PROJECTION_NAME, seq],
    );
  }
}
