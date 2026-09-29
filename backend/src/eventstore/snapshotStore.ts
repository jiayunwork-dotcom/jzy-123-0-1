import { Pool, PoolClient, QueryResultRow } from 'pg';
import { SnapshotAlreadyExistsError } from '../errors';

export interface Snapshot {
  aggregateId: string;
  aggregateType: string;
  /** 该快照对应的聚合版本（事件已回放至此版本） */
  version: number;
  state: Record<string, unknown>;
  createdAt: Date;
}

/**
 * 快照存储。快照一经写入同样不可变（DB 触发器禁止 UPDATE/DELETE）。
 * 同一聚合同一版本只允许一张快照。
 */
export class SnapshotStore {
  constructor(private readonly pool: Pool) {}

  async save(
    aggregateId: string,
    aggregateType: string,
    version: number,
    state: Record<string, unknown>,
    client?: PoolClient,
  ): Promise<Snapshot> {
    const runner = client ?? this.pool;
    try {
      const { rows } = await runner.query(
        `INSERT INTO snapshots (aggregate_id, aggregate_type, version, state)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [aggregateId, aggregateType, version, JSON.stringify(state)],
      );
      return this.map(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new SnapshotAlreadyExistsError(aggregateId, version);
      }
      throw err;
    }
  }

  /** 取某聚合最近一张（版本最大的）快照，没有则返回 null。 */
  async latest(aggregateId: string): Promise<Snapshot | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM snapshots
       WHERE aggregate_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [aggregateId],
    );
    return rows.length === 0 ? null : this.map(rows[0]);
  }

  async list(aggregateId: string): Promise<Snapshot[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM snapshots
       WHERE aggregate_id = $1
       ORDER BY version DESC`,
      [aggregateId],
    );
    return rows.map((row) => this.map(row));
  }

  private map(row: QueryResultRow): Snapshot {
    return {
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      version: Number(row.version),
      state: row.state,
      createdAt: row.created_at,
    };
  }
}
