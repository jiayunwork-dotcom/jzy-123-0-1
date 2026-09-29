import { Pool, QueryResultRow } from 'pg';
import { AccountReadRow } from './projection';

/** 读模型查询：账户列表与详情。只做 SELECT，任何写操作都在 projector 里。 */
export class AccountView {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<AccountReadRow[]> {
    const { rows } = await this.pool.query(
      `SELECT aggregate_id, name, balance_cents, version, event_count, opened_at, updated_at
       FROM accounts_rm
       ORDER BY opened_at ASC, aggregate_id ASC`,
    );
    return rows.map(mapRow);
  }

  async get(aggregateId: string): Promise<AccountReadRow | null> {
    const { rows } = await this.pool.query(
      `SELECT aggregate_id, name, balance_cents, version, event_count, opened_at, updated_at
       FROM accounts_rm WHERE aggregate_id = $1`,
      [aggregateId],
    );
    return rows.length === 0 ? null : mapRow(rows[0]);
  }

  async checkpoint(): Promise<{ projectionName: string; lastGlobalSeq: number; updatedAt: Date }> {
    const { rows } = await this.pool.query(
      `SELECT projection_name, last_global_seq, updated_at
       FROM projection_checkpoint WHERE projection_name = 'accounts'`,
    );
    return {
      projectionName: rows[0].projection_name,
      lastGlobalSeq: Number(rows[0].last_global_seq),
      updatedAt: rows[0].updated_at,
    };
  }
}

function mapRow(row: QueryResultRow): AccountReadRow {
  return {
    aggregateId: row.aggregate_id,
    name: row.name,
    balanceCents: Number(row.balance_cents),
    version: Number(row.version),
    eventCount: Number(row.event_count),
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  };
}
