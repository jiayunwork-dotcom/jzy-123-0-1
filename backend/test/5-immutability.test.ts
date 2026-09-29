import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EventStore } from '../src/eventstore/eventStore';
import { AccountRepository } from '../src/eventstore/accountRepository';
import { VersionGapError } from '../src/errors';
import { getTestPool, resetDatabase } from './helpers';

describe('事件流不可变与版本连续性', () => {
  let pool: Pool;
  let store: EventStore;

  before(async () => {
    pool = await getTestPool();
    await resetDatabase(pool);
    store = new EventStore(pool);
    await store.append('acc-imm', 'account', 0, [
      { eventType: 'AccountOpened', payload: { name: 'Imm', initialBalanceCents: 100 } },
    ]);
    await store.append('acc-imm', 'account', 1, [
      { eventType: 'Deposited', payload: { amountCents: 100 } },
    ]);
  });

  after(async () => {
    await pool.end();
  });

  it('数据库层面禁止 UPDATE 事件（任何改写历史的尝试都失败）', async () => {
    await assert.rejects(
      () =>
        pool.query(
          "UPDATE event_store SET payload = '{\"amountCents\":999999}' WHERE aggregate_id = 'acc-imm'",
        ),
      /只追加存储|insufficient_privilege/,
    );
  });

  it('数据库层面禁止 DELETE 事件（历史不可删除）', async () => {
    await assert.rejects(
      () => pool.query("DELETE FROM event_store WHERE aggregate_id = 'acc-imm'"),
      /只追加存储|insufficient_privilege/,
    );
  });

  it('快照同样禁止 UPDATE / DELETE', async () => {
    const repo = new AccountRepository(pool);
    await repo.createSnapshot('acc-imm', 2);
    await assert.rejects(
      () => pool.query("UPDATE snapshots SET version = 1 WHERE aggregate_id = 'acc-imm'"),
      /只追加存储/,
    );
    await assert.rejects(
      () => pool.query("DELETE FROM snapshots WHERE aggregate_id = 'acc-imm'"),
      /只追加存储/,
    );
  });

  it('后续追加新事件后，已有事件的内容与顺序不变', async () => {
    const before = (await store.readStream('acc-imm')).map(stripDate);
    await store.append('acc-imm', 'account', 2, [
      { eventType: 'Deposited', payload: { amountCents: 5 } },
    ]);
    const after = (await store.readStream('acc-imm')).map(stripDate);
    assert.deepEqual(after.slice(0, before.length), before, '老事件必须逐字段不变');
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.map((e) => e.version), [1, 2, 3], '顺序不变');
  });

  it('事件流出现版本空洞时重建明确报 EVENT_VERSION_GAP（人工损坏检测）', async () => {
    // 触发器允许 TRUNCATE 但不允许行级改/删；构造空洞只能临时关闭触发器后插入错误版本
    await pool.query('ALTER TABLE event_store DISABLE TRIGGER trg_event_store_immutable');
    try {
      await pool.query(
        `INSERT INTO event_store (aggregate_id, aggregate_type, version, event_type, payload)
         VALUES ('acc-gap', 'account', 1, 'AccountOpened', '{"name":"G","initialBalanceCents":0}'),
                ('acc-gap', 'account', 3, 'Deposited', '{"amountCents":1}')`,
      );
      const repo = new AccountRepository(pool);
      await assert.rejects(
        () => repo.rebuildFromScratch('acc-gap'),
        (err: unknown) => err instanceof VersionGapError && err.code === 'EVENT_VERSION_GAP',
      );
      // 清理损坏数据（触发器已关），避免影响本文件后续断言
      await pool.query("DELETE FROM event_store WHERE aggregate_id = 'acc-gap'");
    } finally {
      await pool.query('ALTER TABLE event_store ENABLE TRIGGER trg_event_store_immutable');
    }
  });
});

function stripDate(e: {
  globalSeq: number;
  aggregateId: string;
  aggregateType: string;
  version: number;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}) {
  return {
    globalSeq: e.globalSeq,
    aggregateId: e.aggregateId,
    aggregateType: e.aggregateType,
    version: e.version,
    eventType: e.eventType,
    payload: e.payload,
    metadata: e.metadata,
  };
}
