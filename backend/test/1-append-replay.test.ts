import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EventStore } from '../src/eventstore/eventStore';
import { AccountRepository } from '../src/eventstore/accountRepository';
import { getTestPool, resetDatabase } from './helpers';

describe('事件追加与全量重放', () => {
  let pool: Pool;
  let store: EventStore;
  let repo: AccountRepository;

  before(async () => {
    pool = await getTestPool();
    await resetDatabase(pool);
    store = new EventStore(pool);
    repo = new AccountRepository(pool);
  });

  after(async () => {
    await pool.end();
  });

  it('新聚合的事件版本从 1 开始且严格连续', async () => {
    const id = 'acc-basic';
    await store.append(id, 'account', 0, [
      { eventType: 'AccountOpened', payload: { name: 'A', initialBalanceCents: 1000 } },
    ]);
    await store.append(id, 'account', 1, [
      { eventType: 'Deposited', payload: { amountCents: 500 } },
    ]);
    await store.append(id, 'account', 2, [
      { eventType: 'Withdrawn', payload: { amountCents: 200 } },
    ]);

    const events = await store.readStream(id);
    assert.deepEqual(
      events.map((e) => e.version),
      [1, 2, 3],
    );
    assert.deepEqual(
      events.map((e) => e.eventType),
      ['AccountOpened', 'Deposited', 'Withdrawn'],
    );
  });

  it('全量重放得到正确余额状态', async () => {
    const state = await repo.rebuildFromScratch('acc-basic');
    assert.equal(state.id, 'acc-basic');
    assert.equal(state.name, 'A');
    assert.equal(state.balanceCents, 1000 + 500 - 200);
    assert.equal(state.version, 3);
  });

  it('load() 返回的重建状态与 rebuildFromScratch 一致', async () => {
    const { state } = await repo.load('acc-basic');
    const scratch = await repo.rebuildFromScratch('acc-basic');
    assert.deepEqual(state, scratch);
  });

  it('全局序号严格递增，且能按全局顺序读取', async () => {
    await store.append('acc-other', 'account', 0, [
      { eventType: 'AccountOpened', payload: { name: 'B', initialBalanceCents: 0 } },
    ]);
    const batch = await store.readGlobal(0, 100);
    const seqs = batch.map((e) => e.globalSeq);
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1);
    }
  });

  it('对不存在的聚合以 expectedVersion>0 追加：明确拒绝', async () => {
    await assert.rejects(
      () =>
        store.append('acc-not-exist', 'account', 5, [
          { eventType: 'Deposited', payload: { amountCents: 1 } },
        ]),
      /VERSION_CONFLICT|并发冲突/,
    );
  });

  it('读取不存在的聚合抛 AGGREGATE_NOT_FOUND', async () => {
    await assert.rejects(
      () => repo.load('acc-missing'),
      (err: unknown) => (err as { code?: string }).code === 'AGGREGATE_NOT_FOUND',
    );
  });
});
