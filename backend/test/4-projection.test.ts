import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EventStore } from '../src/eventstore/eventStore';
import { Projector } from '../src/readmodel/projector';
import { AccountView } from '../src/readmodel/accountView';
import { AccountRepository } from '../src/eventstore/accountRepository';
import { getTestPool, resetDatabase } from './helpers';

/**
 * 投影一致性（最要命的不变量）：
 *  1) 小批量增量消费得到的视图 == 单轮全量重放得到的视图（逐行、逐字段）
 *  2) 全量重放幂等：连续 rebuild 两次结果一致
 *  3) 视图内容与写模型事件重算出的余额一致
 */
describe('读模型投影一致性', () => {
  let pool: Pool;
  let store: EventStore;
  let view: AccountView;

  before(async () => {
    pool = await getTestPool();
    await resetDatabase(pool);
    store = new EventStore(pool);
    view = new AccountView(pool);

    // 造 3 个聚合、交错的事件流，余额变化覆盖存取
    for (const [id, name, init] of [
      ['p1', 'P1', 5000],
      ['p2', 'P2', 0],
      ['p3', 'P3', 123],
    ] as const) {
      await store.append(id, 'account', 0, [
        { eventType: 'AccountOpened', payload: { name, initialBalanceCents: init } },
      ]);
    }
    let v1 = 1, v2 = 1, v3 = 1;
    const ops: Array<[string, number, 'Deposited' | 'Withdrawn', number]> = [
      ['p1', v1++, 'Deposited', 100],
      ['p2', v2++, 'Deposited', 200],
      ['p1', v1++, 'Withdrawn', 300],
      ['p3', v3++, 'Deposited', 7],
      ['p2', v2++, 'Withdrawn', 50],
      ['p1', v1++, 'Deposited', 400],
    ];
    for (const [id, v, type, amountCents] of ops) {
      await store.append(id, 'account', v, [
        { eventType: type, payload: { amountCents } },
      ]);
    }
  });

  after(async () => {
    await pool.end();
  });

  it('小批量增量消费（batch=2，强制多批）后视图正确，且 checkpoint 到末尾', async () => {
    const projector = new Projector(pool, new EventStore(pool), 2);
    const first = await projector.catchUp();
    assert.equal(first.processed, 9, '共 3 个开户 + 6 个变动 = 9 条事件');
    const second = await projector.catchUp();
    assert.equal(second.processed, 0, '再次 catchUp 必须幂等');

    const rows = await view.list();
    assert.equal(rows.length, 3);
    const byId = new Map(rows.map((r) => [r.aggregateId, r]));
    assert.equal(byId.get('p1')?.balanceCents, 5000 + 100 - 300 + 400);
    assert.equal(byId.get('p1')?.version, 4);
    assert.equal(byId.get('p1')?.eventCount, 4);
    assert.equal(byId.get('p2')?.balanceCents, 200 - 50);
    assert.equal(byId.get('p3')?.balanceCents, 123 + 7);

    const cp = await view.checkpoint();
    const latestSeq = await pool.query('SELECT MAX(global_seq) AS m FROM event_store');
    assert.equal(cp.lastGlobalSeq, Number(latestSeq.rows[0].m));
  });

  it('全量重算结果与增量消费结果逐行逐字段相等（含时间戳字段）', async () => {
    const incremental = await view.list();
    const incrementalCp = await view.checkpoint();

    const projector = new Projector(pool, new EventStore(pool), 3);
    await projector.rebuild();
    const rebuilt = await view.list();
    const rebuiltCp = await view.checkpoint();

    assert.equal(rebuilt.length, incremental.length);
    assert.deepEqual(
      rebuilt.map(normalize),
      incremental.map(normalize),
      '投影全量重算必须与增量消费完全一致',
    );
    assert.equal(rebuiltCp.lastGlobalSeq, incrementalCp.lastGlobalSeq);
  });

  it('全量重放幂等：再 rebuild 一次仍然一致', async () => {
    const before = (await view.list()).map(normalize);
    await new Projector(pool, new EventStore(pool), 1).rebuild();
    const after = (await view.list()).map(normalize);
    assert.deepEqual(after, before);
  });

  it('投影行的版本/余额与写模型事件直接重算结果一致', async () => {
    const repo = new AccountRepository(pool);
    for (const id of ['p1', 'p2', 'p3']) {
      const state = await repo.rebuildFromScratch(id);
      const row = await view.get(id);
      assert.equal(row?.balanceCents, state.balanceCents);
      assert.equal(row?.version, state.version);
      assert.equal(row?.name, state.name);
    }
  });
});

function normalize(row: {
  aggregateId: string;
  name: string;
  balanceCents: number;
  version: number;
  eventCount: number;
  openedAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    openedAt: row.openedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
