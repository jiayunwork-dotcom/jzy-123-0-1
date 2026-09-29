import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, errorCode } from './helpers';

describe('HTTP 接口端到端', () => {
  let app: FastifyInstance;
  let pool: Pool;

  before(async () => {
    ({ app, pool } = await buildTestApp(2));
  });

  after(async () => {
    await app.close();
    await pool.end();
  });

  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });

  it('开户 -> 列表 -> 详情，读模型在命令返回后已更新', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: '钱包', initialBalance: '10.00' },
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.equal(body.currentVersion, 1);
    const id = body.aggregateId;

    const list = await app.inject({ method: 'GET', url: '/api/accounts' });
    assert.equal(list.statusCode, 200);
    const listJson = list.json();
    assert.ok(listJson.accounts.some((a: { aggregateId: string }) => a.aggregateId === id));
    assert.ok(listJson.projection.lastGlobalSeq >= 1);

    const detail = await app.inject({ method: 'GET', url: `/api/accounts/${id}` });
    assert.equal(detail.statusCode, 200);
    const detailJson = detail.json();
    assert.equal(detailJson.currentState.balance, '10.00');
    assert.equal(detailJson.currentState.version, 1);
    assert.equal(detailJson.readModel.balance, '10.00');
    assert.equal(detailJson.usedSnapshotVersion, null);
    // 详情接口同时给出无快照全量重放结果，两者相等
    assert.deepEqual(detailJson.fullReplayState, detailJson.currentState);
  });

  it('并发同版本两路支取：HTTP 层一条 201 一条 409 VERSION_CONFLICT', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: '并发户', initialBalance: '100.00' },
    });
    const id = created.json().aggregateId;

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/accounts/${id}/withdraw`,
        payload: { expectedVersion: 1, amount: '10.00' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/accounts/${id}/withdraw`,
        payload: { expectedVersion: 1, amount: '20.00' },
      }),
    ]);

    const statuses = responses.map((r) => r.statusCode).sort();
    assert.deepEqual(statuses, [201, 409]);
    const conflict = responses.find((r) => r.statusCode === 409)!;
    assert.equal(errorCode(conflict.json()), 'VERSION_CONFLICT');
    assert.equal(conflict.json().error.details.currentVersion, 2);

    // 只有一条支取落库，余额 = 100 - 10 或 -20
    const detail = await app.inject({ method: 'GET', url: `/api/accounts/${id}` });
    const balance = detail.json().currentState.balanceCents;
    assert.ok(balance === 9000 || balance === 8000);
  });

  it('重复开户（同 id，期望版本隐式 0）：409 AGGREGATE_ALREADY_EXISTS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: '唯一', initialBalance: '0.00', aggregateId: 'fixed-id' },
    });
    assert.equal(res.statusCode, 201);
    const dup = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: '再来', initialBalance: '0.00', aggregateId: 'fixed-id' },
    });
    assert.equal(dup.statusCode, 409);
    assert.equal(errorCode(dup.json()), 'AGGREGATE_ALREADY_EXISTS');
  });

  it('透支被业务规则拒绝：422，且读模型余额不变', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: '小额', initialBalance: '1.00' },
    });
    const id = created.json().aggregateId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/withdraw`,
      payload: { expectedVersion: 1, amount: '2.00' },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(errorCode(res.json()), 'BUSINESS_RULE_VIOLATION');

    const detail = await app.inject({ method: 'GET', url: `/api/accounts/${id}` });
    assert.equal(detail.json().currentState.balanceCents, 100);
    assert.equal(detail.json().currentState.version, 1);
  });

  it('请求体不符合 schema：400 VALIDATION_ERROR', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: '' },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(errorCode(bad.json()), 'VALIDATION_ERROR');
  });

  it('打快照 -> 详情显示使用快照，且重建状态不变', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: '快照户', initialBalance: '3.00' },
    });
    const id = created.json().aggregateId;
    await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/deposit`,
      payload: { expectedVersion: 1, amount: '2.00' },
    });

    const snap = await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/snapshots`,
      payload: { version: 2 },
    });
    assert.equal(snap.statusCode, 201);
    assert.equal(snap.json().version, 2);
    assert.equal(snap.json().state.balanceCents, 500);

    const detail = await app.inject({ method: 'GET', url: `/api/accounts/${id}` });
    const d = detail.json();
    assert.equal(d.usedSnapshotVersion, 2);
    assert.deepEqual(d.currentState, d.fullReplayState);

    // 快照版本超界
    const outOfRange = await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/snapshots`,
      payload: { version: 99 },
    });
    assert.equal(outOfRange.statusCode, 400);
    assert.equal(errorCode(outOfRange.json()), 'SNAPSHOT_VERSION_OUT_OF_RANGE');
  });

  it('事件时间线支持版本区间，且默认按版本升序返回全部', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: '时间线', initialBalance: '0.00' },
    });
    const id = created.json().aggregateId;
    for (let v = 1; v <= 3; v++) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/accounts/${id}/deposit`,
        payload: { expectedVersion: v, amount: '1.00' },
      });
      assert.equal(r.statusCode, 201);
    }

    const all = await app.inject({ method: 'GET', url: `/api/accounts/${id}/events` });
    assert.equal(all.json().events.length, 4);
    assert.deepEqual(all.json().events.map((e: { version: number }) => e.version), [1, 2, 3, 4]);

    const range = await app.inject({
      method: 'GET',
      url: `/api/accounts/${id}/events?fromVersion=1&toVersion=3`,
    });
    assert.deepEqual(range.json().events.map((e: { version: number }) => e.version), [2, 3]);

    const badRange = await app.inject({
      method: 'GET',
      url: `/api/accounts/${id}/events?fromVersion=3&toVersion=1`,
    });
    assert.equal(badRange.statusCode, 400);
    assert.equal(errorCode(badRange.json()), 'INVALID_VERSION_RANGE');
  });

  it('读模型全量重放：POST /api/projection/rebuild 返回重建后的账户视图', async () => {
    const statusBefore = await app.inject({ method: 'GET', url: '/api/projection/status' });
    const before = statusBefore.json();

    const rebuilt = await app.inject({ method: 'POST', url: '/api/projection/rebuild' });
    assert.equal(rebuilt.statusCode, 200);
    const rebuiltJson = rebuilt.json();
    assert.equal(rebuiltJson.status, 'rebuilt');
    assert.ok(rebuiltJson.processed >= 1);
    assert.equal(rebuiltJson.accounts.length, before.accounts.length);

    // 重放后每个账户余额与之前（增量消费）一致
    const statusAfter = (await app.inject({ method: 'GET', url: '/api/projection/status' })).json();
    assert.deepEqual(
      statusAfter.accounts.map((a: { balanceCents: number }) => a.balanceCents).sort(),
      before.accounts.map((a: { balanceCents: number }) => a.balanceCents).sort(),
    );
  });

  it('操作不存在的聚合：详情与命令都明确拒绝（404）', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/accounts/nope-nope' });
    assert.equal(missing.statusCode, 404);
    assert.equal(errorCode(missing.json()), 'AGGREGATE_NOT_FOUND');

    const deposit = await app.inject({
      method: 'POST',
      url: '/api/accounts/nope-nope/deposit',
      payload: { expectedVersion: 1, amount: '1.00' },
    });
    // 服务层先加载聚合，不存在即明确 404（不存在聚合的唯一新建入口是 POST /api/accounts）
    assert.equal(deposit.statusCode, 404);
    assert.equal(errorCode(deposit.json()), 'AGGREGATE_NOT_FOUND');
  });
});
