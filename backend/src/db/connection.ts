import { Pool, PoolConfig } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

export function createPool(connectionString?: string): Pool {
  const config: PoolConfig = {
    connectionString:
      connectionString ??
      process.env.DATABASE_URL ??
      'postgres://ledger:ledger@localhost:5432/ledger',
    max: Number(process.env.DB_POOL_MAX ?? 10),
  };
  return new Pool(config);
}

/** 给测试使用：替换进程级单例。 */
export function setPool(next: Pool): void {
  pool = next;
}
