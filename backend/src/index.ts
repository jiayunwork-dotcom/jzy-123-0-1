import { getPool } from './db/connection';
import { migrate } from './db/migrate';
import { buildApp } from './http/server';
import { Projector } from './readmodel/projector';

async function main(): Promise<void> {
  const pool = getPool();
  await migrate();

  const { app, container } = buildApp({ pool });

  // 启动前先把投影追到最新（保证页面一开始就有数据）
  await container.projector.catchUp();

  // 定时兜底：即使写后触发的 catchUp 因任何原因落后，也会被周期性补齐
  const projector = container.projector;
  setInterval(() => {
    projector.catchUp().catch((err) => app.log.error(err, '投影兜底消费失败'));
  }, 1000).unref();

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  app.log.info(`事件溯源记账后端已启动: http://${host}:${port}`);

  const shutdown = async () => {
    app.log.info('正在关闭服务...');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('服务启动失败:', err);
  process.exit(1);
});
