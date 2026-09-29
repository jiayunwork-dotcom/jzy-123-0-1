import { useState } from 'react';
import { api, ApiRequestError, AccountRow } from '../api';
import { Notice } from '../App';

interface Props {
  accounts: AccountRow[];
  loading: boolean;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  flash: (n: Notice) => void;
}

export function AccountList({ accounts, loading, onOpen, onChanged, flash }: Props) {
  const [name, setName] = useState('');
  const [initialBalance, setInitialBalance] = useState('0.00');
  const [submitting, setSubmitting] = useState(false);

  async function submitOpen() {
    if (!name.trim()) {
      flash({ kind: 'error', text: '请填写账户名称' });
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.openAccount({ name: name.trim(), initialBalance });
      flash({ kind: 'success', text: `开户成功：${result.aggregateId}（版本 ${result.currentVersion}）` });
      setName('');
      setInitialBalance('0.00');
      await onChanged();
    } catch (err) {
      flash({ kind: 'error', text: describe(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>聚合列表（读模型：账户余额汇总）</h2>
      <table>
        <thead>
          <tr>
            <th>账户</th>
            <th>名称</th>
            <th>当前余额</th>
            <th>版本</th>
            <th>事件数</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.aggregateId} className="clickable" onClick={() => onOpen(a.aggregateId)}>
              <td className="muted">{shortId(a.aggregateId)}</td>
              <td>{a.name}</td>
              <td>{a.balance} 元</td>
              <td>
                <span className="badge">v{a.version}</span>
              </td>
              <td>{a.eventCount}</td>
            </tr>
          ))}
          {!loading && accounts.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                还没有账户，先在下面开户。
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 style={{ marginTop: 22 }}>新建账户（命令：openAccount，期望版本 0）</h2>
      <div className="form-row">
        <input
          className="wide"
          placeholder="账户名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="初始余额（元）"
          value={initialBalance}
          onChange={(e) => setInitialBalance(e.target.value)}
        />
        <button onClick={submitOpen} disabled={submitting}>
          开户
        </button>
      </div>
    </div>
  );
}

export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function describe(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const detail = err.details?.currentVersion
      ? `（服务端当前版本：${String(err.details.currentVersion)}，请刷新后用新版本重试）`
      : '';
    return `[${err.code}] ${err.message}${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}
