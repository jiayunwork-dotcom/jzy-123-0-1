import { useState } from 'react';
import { api, AccountRow } from '../api';
import { Notice } from '../App';
import { describe } from './AccountList';

interface Props {
  accounts: AccountRow[];
  onRebuilt: (rows: AccountRow[]) => void;
  flash: (n: Notice) => void;
}

/**
 * 读模型面板：展示当前投影结果，并允许一键全量重放（清空读模型后
 * 从第一条事件重新投影）。重放结果直接展示在页面上，与重放前对照。
 */
export function ProjectionPanel({ accounts, onRebuilt, flash }: Props) {
  const [rebuiltRows, setRebuiltRows] = useState<AccountRow[] | null>(null);
  const [meta, setMeta] = useState<{ processed: number; lastGlobalSeq: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function rebuild() {
    setBusy(true);
    try {
      const result = await api.rebuildProjection();
      setRebuiltRows(result.accounts);
      setMeta({ processed: result.processed, lastGlobalSeq: result.lastGlobalSeq });
      onRebuilt(result.accounts);
      const same =
        JSON.stringify(result.accounts) === JSON.stringify(accounts);
      flash({
        kind: same ? 'success' : 'error',
        text: same
          ? `全量重放完成：消费 ${result.processed} 条事件，结果与增量视图逐行一致 ✓`
          : '全量重放结果与增量视图不一致 ✗',
      });
    } catch (err) {
      flash({ kind: 'error', text: describe(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>读模型投影（读写分离）</h2>
      <p className="muted">
        投影视图完全派生自事件流，可以随时丢弃并从第一条事件全量重算。
      </p>
      <button onClick={rebuild} disabled={busy}>
        {busy ? '重放中…' : '对读模型执行一次全量重放'}
      </button>

      {rebuiltRows && meta && (
        <div style={{ marginTop: 14 }}>
          <h2>
            全量重放结果 <span className="muted">（消费 {meta.processed} 条，位点 #{meta.lastGlobalSeq}）</span>
          </h2>
          <table>
            <thead>
              <tr>
                <th>账户</th>
                <th>名称</th>
                <th>余额</th>
                <th>版本</th>
                <th>事件数</th>
              </tr>
            </thead>
            <tbody>
              {rebuiltRows.map((a) => (
                <tr key={a.aggregateId}>
                  <td className="muted">{a.aggregateId.slice(0, 8)}…</td>
                  <td>{a.name}</td>
                  <td>{a.balance} 元</td>
                  <td>v{a.version}</td>
                  <td>{a.eventCount}</td>
                </tr>
              ))}
              {rebuiltRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    事件流为空。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
