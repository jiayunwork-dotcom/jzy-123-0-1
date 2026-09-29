import { Pool } from 'pg';
import { EventStore, StoredEvent } from './eventStore';
import { SnapshotStore, Snapshot } from './snapshotStore';
import {
  AccountState,
  emptyAccount,
  apply as applyAccountEvent,
} from '../domain/account';
import {
  AggregateNotFoundError,
  SnapshotOutOfRangeError,
} from '../errors';

const AGGREGATE_TYPE = 'account';

export interface RebuiltAccount {
  state: AccountState;
  events: StoredEvent[];
  /** 本次重建是否使用了快照（测试/接口展示用） */
  usedSnapshot: Snapshot | null;
}

/**
 * 账户仓储：负责把事件流重建成聚合状态、以及在版本校验通过后追加事件。
 * 重建永远从初始状态出发：
 *   - 无快照：从第 1 条事件放到最后
 *   - 有快照：从最近快照携带的状态出发，只放“快照版本之后”的剩余事件
 */
export class AccountRepository {
  constructor(
    private readonly pool: Pool,
    private readonly eventStore: EventStore = new EventStore(pool),
    private readonly snapshotStore: SnapshotStore = new SnapshotStore(pool),
  ) {}

  get events(): EventStore {
    return this.eventStore;
  }

  get snapshots(): SnapshotStore {
    return this.snapshotStore;
  }

  /** 常规重建：优先使用最近快照。 */
  async load(aggregateId: string): Promise<RebuiltAccount> {
    const latestVersion = await this.eventStore.currentVersion(aggregateId);
    if (latestVersion === 0) {
      throw new AggregateNotFoundError(aggregateId);
    }

    const snapshot = await this.snapshotStore.latest(aggregateId);
    if (snapshot && snapshot.version <= latestVersion) {
      const remaining = await this.eventStore.readRange(
        aggregateId,
        snapshot.version,
        latestVersion,
      );
      const state = this.foldFromSnapshot(aggregateId, snapshot.state as unknown as AccountState, remaining);
      return { state, events: remaining, usedSnapshot: snapshot };
    }

    // snapshot.version > latestVersion 理论上不该发生，属于明确错误
    if (snapshot && snapshot.version > latestVersion) {
      throw new SnapshotOutOfRangeError(aggregateId, snapshot.version, latestVersion);
    }

    const allEvents = await this.eventStore.readStream(aggregateId);
    const state = this.foldFromEmpty(aggregateId, allEvents);
    return { state, events: allEvents, usedSnapshot: null };
  }

  /** 显式全量重放：忽略所有快照，从第一条事件重建（等价性校验用）。 */
  async rebuildFromScratch(aggregateId: string): Promise<AccountState> {
    const allEvents = await this.eventStore.readStream(aggregateId);
    if (allEvents.length === 0) {
      throw new AggregateNotFoundError(aggregateId);
    }
    return this.foldFromEmpty(aggregateId, allEvents);
  }

  /** 按版本区间取事件（完整/部分重放查看），区间为 1.. 到版本号。 */
  async readRange(aggregateId: string, fromVersion = 0, toVersion?: number): Promise<StoredEvent[]> {
    return this.eventStore.readRange(aggregateId, fromVersion, toVersion);
  }

  async append(
    aggregateId: string,
    expectedVersion: number,
    events: Array<{ eventType: string; payload: Record<string, unknown>; metadata?: Record<string, unknown> }>,
  ): Promise<StoredEvent[]> {
    return this.eventStore.append(aggregateId, AGGREGATE_TYPE, expectedVersion, events);
  }

  /**
   * 在指定版本打快照。默认打在当前最新版本。
   * 快照状态由事件重放计算（不接受外部传入状态，避免与事件流不一致）。
   */
  async createSnapshot(aggregateId: string, atVersion?: number): Promise<Snapshot> {
    const latestVersion = await this.eventStore.currentVersion(aggregateId);
    if (latestVersion === 0) {
      throw new AggregateNotFoundError(aggregateId);
    }
    const targetVersion = atVersion ?? latestVersion;
    if (targetVersion <= 0 || targetVersion > latestVersion) {
      throw new SnapshotOutOfRangeError(aggregateId, targetVersion, latestVersion);
    }

    const state = await this.rebuildUntil(aggregateId, targetVersion);
    return this.snapshotStore.save(aggregateId, AGGREGATE_TYPE, targetVersion, state as unknown as Record<string, unknown>);
  }

  private async rebuildUntil(aggregateId: string, version: number): Promise<AccountState> {
    // 尽量利用已有快照减少回放量，但结果必须与从头播放一致
    const snapshot = await this.snapshotStore.latest(aggregateId);
    if (snapshot && snapshot.version <= version) {
      const remaining = await this.eventStore.readRange(aggregateId, snapshot.version, version);
      return this.foldFromSnapshot(aggregateId, snapshot.state as unknown as AccountState, remaining);
    }
    const events = await this.eventStore.readRange(aggregateId, 0, version);
    return this.foldFromEmpty(aggregateId, events);
  }

  private foldFromEmpty(aggregateId: string, events: StoredEvent[]): AccountState {
    let state = emptyAccount;
    for (const event of events) {
      state = this.foldOne(aggregateId, state, event);
    }
    return state;
  }

  private foldFromSnapshot(aggregateId: string, state: AccountState, events: StoredEvent[]): AccountState {
    let next = state;
    for (const event of events) {
      next = this.foldOne(aggregateId, next, event);
    }
    return next;
  }

  private foldOne(aggregateId: string, state: AccountState, event: StoredEvent): AccountState {
    const payload =
      event.eventType === 'AccountOpened'
        ? { ...event.payload, aggregateId }
        : event.payload;
    return applyAccountEvent(state, event.eventType, payload);
  }
}
