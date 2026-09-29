import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EventStore } from '../src/eventstore/eventStore';
import { ConcurrencyError, AggregateAlreadyExistsError } from '../src/errors';
import { getTestPool, resetDatabase } from './helpers';

describe('乐观并发控制', () => {
  let pool: Pool;
  let store: EventStore;

  before(async () => {
    pool = await getTestPool();
    await resetDatabase(pool);
    store = new EventStore(pool);
    await store.append('acc-conc', 'account', 0, [
      { eventType: 'AccountOpened', payload: { name: 'C', initialBalanceCents: 100 } },
    ]);
  });

  after(async () => {
    await pool.end();
  });

  it('同一聚合并发提交同一期望版本：恰好一条成功，另一条冲突', async () => {
    // 两路写都认为当前版本是 1，同时向版本 2 追加
    const attempts = await Promise.allSettled([
      store.append('acc-conc', 'account', 1, [
        { eventType: 'Deposited', payload: { amountCents: 10 } },
      ]),
      store.append('acc-conc', 'account', 1, [
        { eventType: 'Deposited', payload: { amountCents: 20 } },
      ]),
    ]);

    const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
    const rejected = attempts.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, '必须恰好一条成功');
    assert.equal(rejected.length, 1, '必须恰好一条被拒绝');

    const reason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(reason instanceof ConcurrencyError, '拒绝必须是并发冲突错误');
    assert.equal(reason.code, 'VERSION_CONFLICT');
    assert.equal(reason.details?.actualVersion, 2);
  });

  it('冲突后调用方拿最新版本重试可以成功，版本号不被写乱', async () => {
    const latest = await store.currentVersion('acc-conc');
    assert.equal(latest, 2);
    const retry = await store.append('acc-conc', 'account', latest, [
      { eventType: 'Deposited', payload: { amountCents: 30 } },
    ]);
    assert.equal(retry[0].version, 3);

    const versions = (await store.readStream('acc-conc')).map((e) => e.version);
    assert.deepEqual(versions, [1, 2, 3]);
  });

  it('两个不同聚合的并发追加互不影响，各自成功', async () => {
    const results = await Promise.all([
      store.append('acc-x', 'account', 0, [
        { eventType: 'AccountOpened', payload: { name: 'X', initialBalanceCents: 0 } },
      ]),
      store.append('acc-y', 'account', 0, [
        { eventType: 'AccountOpened', payload: { name: 'Y', initialBalanceCents: 0 } },
      ]),
    ]);
    assert.equal(results[0][0].version, 1);
    assert.equal(results[1][0].version, 1);
  });

  it('在已存在聚合上以 expectedVersion=0 追加：报 AGGREGATE_ALREADY_EXISTS', async () => {
    await assert.rejects(
      () =>
        store.append('acc-conc', 'account', 0, [
          { eventType: 'AccountOpened', payload: { name: 'dup', initialBalanceCents: 0 } },
        ]),
      (err: unknown) => err instanceof AggregateAlreadyExistsError,
    );
  });

  it('过期版本（非当前）追加：冲突并回带当前版本', async () => {
    await assert.rejects(
      () =>
        store.append('acc-conc', 'account', 1, [
          { eventType: 'Deposited', payload: { amountCents: 1 } },
        ]),
      (err: unknown) => {
        const e = err as ConcurrencyError;
        return (
          e instanceof ConcurrencyError &&
          e.details?.expectedVersion === 1 &&
          Number(e.details?.actualVersion) >= 3
        );
      },
    );
  });
});
