import { useCallback, useEffect, useState } from 'react';
import { api, AccountDetail as Detail, EventView, ApiRequestError } from '../api';
import { Notice } from '../App';
import { describe, shortId } from './AccountList';

interface Props {
  aggregateId: string;
  onBack: () => void;
  onChanged: () => Promise<void>;
  flash: (n: Notice) => void;
}

export function AccountDetailPage({ aggregateId, onBack, onChanged, flash }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  const reload = useCallback(async () => {
    const [d, e] = await Promise.all([
      api.getAccount(aggregateId),
      api.getEvents(aggregateId),
    ]);
    setDetail(d);
    setEvents(e.events);
  }, [aggregateId]);

  useEffect(() => {
    reload().catch((err) => flash({ kind: 'error', text: describe(err) }));
  }, [reload, flash]);

  async function runCommand(kind: 'deposit' | 'withdraw') {
    if (!detail) return;
    const expectedVersion = detail.currentState.version;
    if (!amount || Number(amount) <= 0) {
      flash({ kind: 'error', text: '请输入大于 0 的金额' });
      return;
    }
    setBusy(true);
    try {
      if (kind === 'deposit') {
        await api.deposit(aggregateId, expectedVersion, amount);
      } else {
        await api.withdraw(aggregateId, expectedVersion, amount);
      }
      flash({ kind: 'success', text: `${kind === 'deposit' ? '存入' : '支取'}成功（基于版本 ${expectedVersion} 提交）` });
      setAmount('');
      await Promise.all([reload(), onChanged()]);
    } catch (err) {
      flash({ kind: 'error', text: describe(err) });
      if (err instanceof ApiRequestError && err.code === 'VERSION_CONFLICT') {
        await reload().catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  async function takeSnapshot() {
    if (!detail) return;
    setBusy(true);
    try {
      const snap = await api.createSnapshot(detail.aggregateId, detail.currentState.version);
      flash({ kind: 'success', text: `已在版本 ${snap.version} 打快照` });
      await reload();
    } catch (err) {
      flash({ kind: 'error', text: describe(err) });
    } finally {
      setBusy(false);
    }
  }

  async function queryRange() {
    try {
      const from = rangeFrom === '' ? undefined : Number(rangeFrom);
      const to = rangeTo === '' ? undefined : Number(rangeTo);
      const e = await api.getEvents(aggregateId, from, to);
      setEvents(e.events);
    } catch (err) {
      flash({ kind: 'error', text: describe(err) });
    }
  }

  if (!detail) {
    return (
      <div className="card">
        <span className="back-link" onClick={onBack}>
          ← 返回列表
        </span>
        <p className="muted">加载中…</p>
      </div>
    );
  }

  const replayEqual =
    JSON.stringify(detail.currentState) === JSON.stringify(detail.fullReplayState);

  return (
    <div>
      <span className="back-link" onClick={onBack}>
        ← 返回列表
      </span>

      <div className="card">
        <h2>
          {detail.currentState.name} <span className="muted">({shortId(detail.aggregateId)})</span>
        </h2>
        <dl className="kv">
          <dt>当前余额</dt>
          <dd>
            <strong>{detail.currentState.balance}</strong> 元（{detail.currentState.balanceCents} 分）
          </dd>
          <dt>当前版本</dt>
          <dd>
            <span className="badge">v{detail.currentState.version}</span>
            {detail.usedSnapshotVersion !== null && (
              <span className="badge gray" style={{ marginLeft: 8 }}>
                重建使用快照 v{detail.usedSnapshotVersion}
              </span>
            )}
          </dd>
          <dt>读模型视图</dt>
          <dd>
            {detail.readModel ? (
              <>
                {detail.readModel.balance} 元 · v{detail.readModel.version} · {detail.readModel.eventCount} 条事件
              </>
            ) : (
              <span className="muted">尚未投影</span>
            )}
          </dd>
          <dt>全量重放结果</dt>
          <dd>
            {detail.fullReplayState.balance} 元 · v{detail.fullReplayState.version}{' '}
            <span className={replayEqual ? 'equal' : 'diff'}>
              {replayEqual ? '✓ 与快照重建逐字段相等' : '✗ 与快照重建不一致'}
            </span>
          </dd>
        </dl>
      </div>

      <div className="card">
        <h2>追加事件（必须带期望版本，即上面看到的当前版本）</h2>
        <div className="form-row">
          <input
            placeholder="金额（元）"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button disabled={busy} onClick={() => runCommand('deposit')}>
            存入
          </button>
          <button className="secondary" disabled={busy} onClick={() => runCommand('withdraw')}>
            支取
          </button>
          <button className="secondary" disabled={busy} onClick={takeSnapshot}>
            在 v{detail.currentState.version} 打快照
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          提交时带 expectedVersion = {detail.currentState.version}；若期间有别人先写，后端会返回 409 并回带最新版本。
        </p>
      </div>

      <div className="card">
        <h2>快照历史（{detail.snapshots.length}）</h2>
        {detail.snapshots.length === 0 ? (
          <p className="muted">还没有快照。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>版本</th>
                <th>快照中的余额</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {detail.snapshots.map((s) => (
                <tr key={s.version}>
                  <td>
                    <span className="badge">v{s.version}</span>
                  </td>
                  <td>{s.state.balanceCents} 分</td>
                  <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>完整事件时间线（{events.length} 条，按版本升序）</h2>
        <div className="form-row" style={{ marginBottom: 12 }}>
          <span className="muted">版本区间</span>
          <input
            placeholder="fromVersion"
            value={rangeFrom}
            onChange={(e) => setRangeFrom(e.target.value)}
            style={{ width: 110 }}
          />
          <span className="muted">&lt; v &lt;=</span>
          <input
            placeholder="toVersion"
            value={rangeTo}
            onChange={(e) => setRangeTo(e.target.value)}
            style={{ width: 110 }}
          />
          <button className="secondary" onClick={queryRange}>
            区间查询
          </button>
          <button
            className="secondary"
            onClick={() => {
              setRangeFrom('');
              setRangeTo('');
              api.getEvents(aggregateId).then((e) => setEvents(e.events));
            }}
          >
            全部
          </button>
        </div>

        <ol className="timeline">
          {events.map((event) => (
            <li key={event.globalSeq}>
              <div>
                <span className="event-type">{event.eventType}</span>
                <span className="badge gray">v{event.version}</span>
                <span className="badge gray" style={{ marginLeft: 6 }}>
                  globalSeq #{event.globalSeq}
                </span>
                <span className="muted" style={{ marginLeft: 8 }}>
                  {new Date(event.occurredAt).toLocaleString()}
                </span>
              </div>
              <pre className="payload">{JSON.stringify(event.payload, null, 2)}</pre>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
