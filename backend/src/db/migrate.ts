import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { getPool } from './connection';

/**
 * 执行 schema.sql。幂等，可重复运行。
 * 优先从已编译产物旁读取，其次从 src 读取（tsx 开发/测试场景）。
 */
export async function migrate(): Promise<void> {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', 'src', 'db', 'schema.sql'),
  ];
  let sql: string | undefined;
  for (const candidate of candidates) {
    try {
      sql = await readFile(candidate, 'utf8');
      break;
    } catch {
      // 尝试下一个候选路径
    }
  }
  if (!sql) {
    throw new Error('找不到 schema.sql');
  }
  const client = await getPool().connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

// 允许直接 `tsx src/db/migrate.ts` 执行
if (require.main === module) {
  migrate()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('数据库迁移完成');
      return getPool().end();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('数据库迁移失败:', err);
      process.exit(1);
    });
}
