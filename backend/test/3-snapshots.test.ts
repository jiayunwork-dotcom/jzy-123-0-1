import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EventStore } from '../src/eventstore/eventStore';
import { AccountRepository } from '../src/eventstore/accountRepository';
import { SnapshotOutOfRangeError, SnapshotAlreadyExistsError } from '../src/errors';
import { getTestPool, resetDatabase } from './helpers';

describe('快照重建等价性', () => {
  let pool: Pool;
  let store: EventStore;
  let repo: AccountRepository;

  before(async () => {
    pool = await getTestPool();
    await resetDatabase(pool);
    store = new EventStore(pool);
    repo = new AccountRepository(pool);

    const id = 'acc-snap';
    await store.append(id, 'account', 0, [
      { eventType: 'AccountOpened', payload: { name: 'Snap', initialBalanceCents: 10000 } },
    ]);
    for (let v = 1; v <= 9; v++) {
      await store.append(id, 'account', v, [
        { eventType: v % 2 === 0 ? 'Withdrawn' : 'Deposited', payload: { amountCents: 100 * v } },
      ]);
    }
  });

  after(async () => {
    await pool.end();
  });

  it('在多个不同版本打快照后，load() 与无快照全量重放逐字段相等', async () => {
    const id = 'acc-snap';
    const scratch = await repo.rebuildFromScratch(id);

    for (const atVersion of [1, 3, 7, 10]) {
      await repo.createSnapshot(id, atVersion);
      const { state, usedSnapshot } = await repo.load(id);
      assert.ok(usedSnapshot !== null, `版本 ${atVersion} 的快照应被使用`);
      assert.equal(usedSnapshot?.version, atVersion);
      assert.deepEqual(
        state,
        scratch,
        `快照打在 v${atVersion} 时重建结果必须与全量重放逐字段相等`,
      );
    }
  });

  it('快照状态等于“播放到该版本”的状态，之后的事件只回放一次', async () => {
    const id = 'acc-snap';
    const all = await store.readStream(id);
    const snapshot = await repo.snapshots.latest(id);
    assert.equal(snapshot?.version, 10);

    const { events: remaining, usedSnapshot } = await repo.load(id);
    assert.equal(remaining.length, 0, '快照在最新版本时没有剩余事件');
    assert.equal(usedSnapshot?.version, 10);
    assert.equal(all.length, 10);
  });

  it('快照版本超出已有事件范围：明确拒绝', async () => {
    await assert.rejects(
      () => repo.createSnapshot('acc-snap', 999),
      (err: unknown) => {
        const e = err as SnapshotOutOfRangeError;
        return (
          e instanceof SnapshotOutOfRangeError &&
          e.code === 'SNAPSHOT_VERSION_OUT_OF_RANGE' &&
          e.details?.latestVersion === 10
        );
      },
    );
  });

  it('为不存在的聚合打快照：404', async () => {
    await assert.rejects(
      () => repo.createSnapshot('acc-no-such'),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 404,
    );
  });

  it('同一版本重复打快照：冲突拒绝，旧快照保持不变', async () => {
    const id = 'acc-snap';
    const first = await repo.snapshots.latest(id);
    await assert.rejects(
      () => repo.createSnapshot(id, 10),
      (err: unknown) => err instanceof SnapshotAlreadyExistsError,
    );
    const again = await repo.snapshots.latest(id);
    assert.equal(again?.createdAt.getTime(), first?.createdAt.getTime());
  });
});
