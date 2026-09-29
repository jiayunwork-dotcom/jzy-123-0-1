import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EventStore } from '../src/eventstore/eventStore';
import { AccountRepository } from '../src/eventstore/accountRepository';
import {
  AccountState,
  decide,
  emptyAccount,
} from '../src/domain/account';
import { BusinessRuleError } from '../src/errors';
import { getTestPool, resetDatabase } from './helpers';

describe('业务校验（事件生成之前拦截）', () => {
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

  it('余额不足的支取：抛业务错误，且不产生任何事件', async () => {
    const id = 'acc-biz';
    await store.append(id, 'account', 0, [
      { eventType: 'AccountOpened', payload: { name: 'Biz', initialBalanceCents: 100 } },
    ]);
    const { state } = await repo.load(id);

    await assert.rejects(
      async () => decide(state, { kind: 'withdraw', amount: '1.01' }),
      (err: unknown) => err instanceof BusinessRuleError && err.code === 'BUSINESS_RULE_VIOLATION',
    );

    // 关键：拒绝后事件流没有任何新增，版本停留在 1
    assert.equal(await store.currentVersion(id), 1);
    const events = await store.readStream(id);
    assert.equal(events.length, 1);
  });

  it('支取/存入金额为 0 或负数：拒绝', () => {
    const state: AccountState = { id: 'a', name: 'a', balanceCents: 100, version: 1 };
    assert.throws(() => decide(state, { kind: 'deposit', amount: '0' }), BusinessRuleError);
    assert.throws(() => decide(state, { kind: 'withdraw', amount: '0.00' }), BusinessRuleError);
    assert.throws(() => decide(state, { kind: 'deposit', amount: '-5' }), BusinessRuleError);
  });

  it('非法金额格式：拒绝且不产生事件', () => {
    const state: AccountState = { id: 'a', name: 'a', balanceCents: 100, version: 1 };
    assert.throws(() => decide(state, { kind: 'deposit', amount: 'abc' }), BusinessRuleError);
    assert.throws(() => decide(state, { kind: 'withdraw', amount: '1.234' }), BusinessRuleError);
  });

  it('开户名为空 / 初始余额为负：拒绝', () => {
    assert.throws(() => decide(emptyAccount, { kind: 'openAccount', name: '  ', initialBalance: '0' }), BusinessRuleError);
    assert.throws(() => decide(emptyAccount, { kind: 'openAccount', name: 'X', initialBalance: '-1' }), BusinessRuleError);
  });

  it('对已开户状态再次执行开户 decide：拒绝', () => {
    const state: AccountState = { id: 'a', name: 'a', balanceCents: 0, version: 1 };
    assert.throws(
      () => decide(state, { kind: 'openAccount', name: 'Y', initialBalance: '0' }),
      BusinessRuleError,
    );
  });

  it('取光余额（正好等于余额）允许；之后再取一分拒绝', async () => {
    const id = 'acc-exact';
    await store.append(id, 'account', 0, [
      { eventType: 'AccountOpened', payload: { name: 'Exact', initialBalanceCents: 500 } },
    ]);
    let { state } = await repo.load(id);
    const event = decide(state, { kind: 'withdraw', amount: '5.00' });
    assert.equal(event[0].eventType, 'Withdrawn');
    await store.append(id, 'account', 1, event);

    state = (await repo.load(id)).state;
    assert.equal(state.balanceCents, 0);
    assert.throws(() => decide(state, { kind: 'withdraw', amount: '0.01' }), /余额不足/);
  });
});
