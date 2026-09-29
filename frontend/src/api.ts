// 前端只负责展示与发命令；所有状态/余额/版本都来自后端接口，前端不重算业务。

export interface EventView {
  globalSeq: number;
  version: number;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface AccountRow {
  aggregateId: string;
  name: string;
  balance: string;
  balanceCents: number;
  version: number;
  eventCount: number;
  openedAt: string;
  updatedAt: string;
}

export interface SnapshotView {
  aggregateId: string;
  version: number;
  state: {
    id: string | null;
    name: string;
    balanceCents: number;
    version: number;
  };
  createdAt: string;
}

export interface AccountDetail {
  aggregateId: string;
  readModel: AccountRow | null;
  currentState: { id: string | null; name: string; balance: string; balanceCents: number; version: number };
  fullReplayState: { id: string | null; name: string; balance: string; balanceCents: number; version: number };
  usedSnapshotVersion: number | null;
  snapshots: SnapshotView[];
}

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const apiError = body as ApiError;
    throw new ApiRequestError(
      res.status,
      apiError.error?.code ?? 'HTTP_ERROR',
      apiError.error?.message ?? `请求失败 (${res.status})`,
      apiError.error?.details,
    );
  }
  return body as T;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const api = {
  listAccounts: () =>
    request<{ accounts: AccountRow[]; projection: { lastGlobalSeq: number; updatedAt: string } }>(
      '/api/accounts',
    ),

  getAccount: (id: string) => request<AccountDetail>(`/api/accounts/${encodeURIComponent(id)}`),

  getEvents: (id: string, fromVersion?: number, toVersion?: number) => {
    const params = new URLSearchParams();
    if (fromVersion !== undefined) params.set('fromVersion', String(fromVersion));
    if (toVersion !== undefined) params.set('toVersion', String(toVersion));
    const qs = params.toString();
    return request<{ aggregateId: string; events: EventView[] }>(
      `/api/accounts/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ''}`,
    );
  },

  openAccount: (payload: { name: string; initialBalance: string; aggregateId?: string }) =>
    request<{ aggregateId: string; currentVersion: number; events: EventView[] }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deposit: (id: string, expectedVersion: number, amount: string) =>
    request<{ aggregateId: string; currentVersion: number; events: EventView[] }>(
      `/api/accounts/${encodeURIComponent(id)}/deposit`,
      { method: 'POST', body: JSON.stringify({ expectedVersion, amount }) },
    ),

  withdraw: (id: string, expectedVersion: number, amount: string) =>
    request<{ aggregateId: string; currentVersion: number; events: EventView[] }>(
      `/api/accounts/${encodeURIComponent(id)}/withdraw`,
      { method: 'POST', body: JSON.stringify({ expectedVersion, amount }) },
    ),

  createSnapshot: (id: string, version?: number) =>
    request<SnapshotView>(`/api/accounts/${encodeURIComponent(id)}/snapshots`, {
      method: 'POST',
      body: JSON.stringify(version !== undefined ? { version } : {}),
    }),

  rebuildProjection: () =>
    request<{ status: string; processed: number; lastGlobalSeq: number; accounts: AccountRow[] }>(
      '/api/projection/rebuild',
      { method: 'POST' },
    ),

  projectionStatus: () =>
    request<{ projection: string; lastGlobalSeq: number; updatedAt: string; accountCount: number; accounts: AccountRow[] }>(
      '/api/projection/status',
    ),
};
