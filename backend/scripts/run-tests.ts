/**
 * 本地无 Docker 环境下的测试引导：
 * 启动一个真实的嵌入式 PostgreSQL 16（端口 5433），创建测试库后运行 node --test。
 * CI / docker 环境中若已有 Postgres，可直接：
 *   TEST_DATABASE_URL=postgres://... npm test
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 5433;
const DB_NAME = 'ledger_test';
const DATA_DIR = '/tmp/es-ledger-test-pgdata';

async function main(): Promise<void> {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'ledger',
    password: 'ledger',
    port: PORT,
    persistent: true,
    // @ts-expect-error initdbFlags 透传给 initdb
    initdbFlags: [],
  });

  const exit = async (code: number): Promise<never> => {
    await pg.stop().catch(() => undefined);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(code);
  };

  process.on('SIGINT', () => void exit(130));
  process.on('SIGTERM', () => void exit(143));

  // eslint-disable-next-line no-console
  console.log('初始化嵌入式 PostgreSQL 16（首次运行需下载二进制，请稍候）...');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME).catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log(`PostgreSQL 已在 :${PORT} 启动，开始运行测试...`);

  const testFiles = fs
    .readdirSync(path.join(__dirname, '..', 'test'))
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => path.join('test', f));

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', ...testFiles],
    {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgres://ledger:ledger@localhost:${PORT}/${DB_NAME}`,
      },
    },
  );

  child.on('exit', (code) => {
    void exit(code ?? 1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
