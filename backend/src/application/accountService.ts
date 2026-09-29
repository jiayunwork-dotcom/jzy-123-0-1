import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { AccountRepository } from '../eventstore/accountRepository';
import { Snapshot } from '../eventstore/snapshotStore';
import { AccountCommand, AccountState, decide, emptyAccount } from '../domain/account';
import { StoredEvent } from '../eventstore/eventStore';
import { ConcurrencyError } from '../errors';
import { Projector } from '../readmodel/projector';

const AGGREGATE_TYPE = 'account';

export interface CommandResult {
  aggregateId: string;
  currentVersion: number;
  events: StoredEvent[];
}

/**
 * 应用服务：唯一的命令写入口。
 * 流程固定为：加载当前状态（事件回放）→ 领域 decide（不合法不产生事件）
 *           → 带期望版本追加（并发冲突由事件存储拒绝）→ 驱动读模型增量消费
 */
export class AccountService {
  readonly repository: AccountRepository;
  private readonly projector: Projector;

  constructor(pool: Pool, projector?: Projector) {
    this.repository = new AccountRepository(pool);
    this.projector = projector ?? new Projector(pool);
  }

  async openAccount(input: {
    name: string;
    initialBalance: string;
    aggregateId?: string;
  }): Promise<CommandResult> {
    const aggregateId = input.aggregateId ?? randomUUID();
    // 新聚合的期望版本固定为 0；服务端确认不存在才允许写第一条事件
    return this.execute(
      aggregateId,
      0,
      { kind: 'openAccount', name: input.name, initialBalance: input.initialBalance },
      emptyAccount,
    );
  }

  async deposit(aggregateId: string, expectedVersion: number, amount: string): Promise<CommandResult> {
    return this.execute(aggregateId, expectedVersion, { kind: 'deposit', amount });
  }

  async withdraw(aggregateId: string, expectedVersion: number, amount: string): Promise<CommandResult> {
    return this.execute(aggregateId, expectedVersion, { kind: 'withdraw', amount });
  }

  async createSnapshot(aggregateId: string, atVersion?: number): Promise<Snapshot> {
    return this.repository.createSnapshot(aggregateId, atVersion);
  }

  private async execute(
    aggregateId: string,
    expectedVersion: number,
    command: AccountCommand,
    preloadedState?: AccountState,
  ): Promise<CommandResult> {
    // 新聚合从空状态开始；已有聚合从事件（+快照）重建出当前状态
    let state: AccountState;
    if (preloadedState) {
      state = preloadedState;
    } else {
      const rebuilt = await this.repository.load(aggregateId);
      state = rebuilt.state;
      // 加载后再次核对期望版本，避免回放状态与客户端版本脱节
      if (state.version !== expectedVersion) {
        throw new ConcurrencyError(aggregateId, expectedVersion, state.version);
      }
    }

    // 业务校验全部发生在生成事件之前
    const newEvents = decide(state, command);

    const stored = await this.repository.append(aggregateId, expectedVersion, newEvents);

    // 写成功后立即增量推进读模型；另有定时兜底 catchUp 防止任何滞后
    await this.projector.catchUp();

    return {
      aggregateId,
      currentVersion: expectedVersion + stored.length,
      events: stored,
    };
  }
}

export { AGGREGATE_TYPE };
