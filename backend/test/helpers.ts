import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { buildApp } from '../src/http/server';
import type { FastifyInstance } from 'fastify';

/**
 * 测试共用工具。
 *
 * 约定：
 *  - 测试库连接串由 TEST_DATABASE_URL 指定，默认 postgres://ledger:ledger@localhost:5433/ledger_test
 *    （compose 把 Postgres 映射到宿主 5433，避免和本机 5432 冲突）
 *  - 测试启动时自动 CREATE DATABASE IF NOT EXISTS 并执行 schema
 *  - 每个测试文件运行前 truncate 四张表（--test-concurrency=1 保证串行）
 */
export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://ledger:ledger@localhost:5433/ledger_test';

let cachedPool: Pool | undefined;

async function ensureDatabase(): Promise<void> {
  const url = new URL(TEST_DB_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      // 数据库名来自测试配置，不可被外部输入注入
      await admin.query(`CREATE DATABASE ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

async function runSchema(pool: Pool): Promise<void> {
  const sqlPath = path.join(__dirname, '..', 'src', 'db', 'schema.sql');
  const sql = await readFile(sqlPath, 'utf8');
  await pool.query(sql);
}

export async function getTestPool(): Promise<Pool> {
  if (cachedPool) {
    return cachedPool;
  }
  await ensureDatabase();
  cachedPool = new Pool({ connectionString: TEST_DB_URL, max: 10 });
  await runSchema(cachedPool);
  return cachedPool;
}

/** 每个测试文件开始时清空全部数据（事件流、快照、读模型、位点）。 */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE event_store;
    TRUNCATE TABLE snapshots;
    TRUNCATE TABLE accounts_rm;
    UPDATE projection_checkpoint SET last_global_seq = 0, updated_at = now()
      WHERE projection_name = 'accounts';
  `);
}

export async function buildTestApp(projectionBatchSize?: number): Promise<{
  app: FastifyInstance;
  pool: Pool;
}> {
  const pool = await getTestPool();
  await resetDatabase(pool);
  const { app } = buildApp({ pool, projectionBatchSize, logger: false });
  return { app, pool };
}

export async function openAccount(
  app: FastifyInstance,
  body: { name: string; initialBalance: string; aggregateId?: string },
): Promise<{
  statusCode: number;
  json: { aggregateId: string; currentVersion: number };
}> {
  const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: body });
  return { statusCode: res.statusCode, json: res.json() };
}

export async function command(
  app: FastifyInstance,
  aggregateId: string,
  type: 'deposit' | 'withdraw',
  payload: { expectedVersion: number; amount: string },
) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/accounts/${aggregateId}/${type}`,
    payload,
  });
  return { statusCode: res.statusCode, json: res.json() };
}

/** 取业务错误 code；非错误响应抛出断言失败。 */
export function errorCode(json: unknown): string {
  const code = (json as { error?: { code?: string } })?.error?.code;
  if (!code) {
    throw new Error(`期望错误响应，实际得到: ${JSON.stringify(json)}`);
  }
  return code;
}
