import { useCallback, useEffect, useState } from 'react';
import { api, AccountRow } from './api';
import { AccountList } from './components/AccountList';
import { AccountDetailPage } from './components/AccountDetail';
import { ProjectionPanel } from './components/ProjectionPanel';

export type Notice = { kind: 'success' | 'error'; text: string } | null;

export function App() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [checkpointSeq, setCheckpointSeq] = useState<number>(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);

  const refreshList = useCallback(async () => {
    const data = await api.listAccounts();
    setAccounts(data.accounts);
    setCheckpointSeq(data.projection.lastGlobalSeq);
  }, []);

  useEffect(() => {
    refreshList()
      .catch((err) => setNotice({ kind: 'error', text: err.message }))
      .finally(() => setLoading(false));
  }, [refreshList]);

  const flash = useCallback((n: Notice) => {
    setNotice(n);
    if (n?.kind === 'success') {
      setTimeout(() => setNotice(null), 4000);
    }
  }, []);

  return (
    <div className="layout">
      <header className="topbar">
        <h1>事件溯源记账后台</h1>
        <span className="muted">写模型 = 只追加事件流 · 读模型 = 投影视图 · 位点 #{checkpointSeq}</span>
      </header>

      {notice && <div className={`message ${notice.kind}`}>{notice.text}</div>}

      {!selectedId ? (
        <>
          <AccountList
            accounts={accounts}
            loading={loading}
            onOpen={setSelectedId}
            onChanged={refreshList}
            flash={flash}
          />
          <ProjectionPanel
            accounts={accounts}
            onRebuilt={async (rows) => {
              setAccounts(rows);
            }}
            flash={flash}
          />
        </>
      ) : (
        <AccountDetailPage
          aggregateId={selectedId}
          onBack={() => {
            setSelectedId(null);
            refreshList().catch((err) => flash({ kind: 'error', text: err.message }));
          }}
          onChanged={async () => {
            await refreshList();
          }}
          flash={flash}
        />
      )}
    </div>
  );
}
