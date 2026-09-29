import { BusinessRuleError } from '../errors';
import { Cents, parseMoneyToCents } from './money';

/**
 * 账户聚合 —— 框架里唯一的聚合类型。
 *
 * 事件（不可变、只追加）：
 *   AccountOpened   { name, initialBalanceCents }  v=1
 *   Deposited       { amountCents }                 v>1
 *   Withdrawn       { amountCents }                 v>1
 *
 * 当前状态永远由「初始空状态 + 依次 apply 事件」重建得到，
 * 没有任何“直接改余额”的写路径。
 */

export interface AccountState {
  id: string | null;
  name: string;
  balanceCents: Cents;
  version: number;
}

export const emptyAccount: AccountState = {
  id: null,
  name: '',
  balanceCents: 0,
  version: 0,
};

export type AccountEventData =
  | { type: 'AccountOpened'; name: string; initialBalanceCents: Cents }
  | { type: 'Deposited'; amountCents: Cents }
  | { type: 'Withdrawn'; amountCents: Cents };

/**
 * 纯函数：把一条事件应用到状态上，得到下一状态。
 * 全量重建、快照后增量回放、单元测试都走同一个 apply，
 * 因此“打不打快照、快照打在哪一版”重建结果必然一致。
 */
export function apply(state: AccountState, eventType: string, payload: Record<string, unknown>): AccountState {
  switch (eventType) {
    case 'AccountOpened':
      return {
        id: (payload.aggregateId as string) ?? state.id,
        name: payload.name as string,
        balanceCents: Number(payload.initialBalanceCents),
        version: state.version + 1,
      };
    case 'Deposited':
      return {
        ...state,
        balanceCents: state.balanceCents + Number(payload.amountCents),
        version: state.version + 1,
      };
    case 'Withdrawn':
      return {
        ...state,
        balanceCents: state.balanceCents - Number(payload.amountCents),
        version: state.version + 1,
      };
    default:
      throw new Error(`账户聚合收到未知事件类型: ${eventType}`);
  }
}

/** 从头回放整条事件流重建账户状态。 */
export function replay(events: Array<{ eventType: string; payload: Record<string, unknown>; aggregateId?: string }>): AccountState {
  let state = emptyAccount;
  for (const event of events) {
    const payload =
      event.eventType === 'AccountOpened'
        ? { ...event.payload, aggregateId: event.payload.aggregateId ?? event.aggregateId }
        : event.payload;
    state = apply(state, event.eventType, payload);
  }
  return state;
}

// ---------------------------------------------------------------------------
// 命令：校验在“生成事件之前”完成，不合法就抛 BusinessRuleError，不产生事件。
// ---------------------------------------------------------------------------

export type AccountCommand =
  | { kind: 'openAccount'; name: string; initialBalance: string }
  | { kind: 'deposit'; amount: string }
  | { kind: 'withdraw'; amount: string };

export interface DecidedEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

export function decide(state: AccountState, command: AccountCommand): DecidedEvent[] {
  switch (command.kind) {
    case 'openAccount': {
      if (state.id !== null) {
        throw new BusinessRuleError('账户已开户，不能重复开户', {
          accountId: state.id,
        });
      }
      const name = command.name?.trim();
      if (!name) {
        throw new BusinessRuleError('账户名称不能为空');
      }
      let initialBalanceCents: number;
      try {
        initialBalanceCents = parseMoneyToCents(command.initialBalance ?? '0');
      } catch {
        throw new BusinessRuleError(`初始余额金额非法: ${command.initialBalance}`, {
          field: 'initialBalance',
        });
      }
      if (initialBalanceCents < 0) {
        throw new BusinessRuleError('初始余额不能为负', { field: 'initialBalance' });
      }
      return [
        {
          eventType: 'AccountOpened',
          payload: { name, initialBalanceCents },
        },
      ];
    }

    case 'deposit': {
      assertOpen(state);
      const amountCents = parsePositiveAmount(command.amount, 'deposit');
      return [{ eventType: 'Deposited', payload: { amountCents } }];
    }

    case 'withdraw': {
      assertOpen(state);
      const amountCents = parsePositiveAmount(command.amount, 'withdraw');
      // 核心业务约束：余额不能被取成负数
      if (amountCents > state.balanceCents) {
        throw new BusinessRuleError(
          `余额不足：当前 ${state.balanceCents} 分，试图支取 ${amountCents} 分`,
          {
            balanceCents: state.balanceCents,
            requestedCents: amountCents,
          },
        );
      }
      return [{ eventType: 'Withdrawn', payload: { amountCents } }];
    }
  }
}

function assertOpen(state: AccountState): void {
  if (state.id === null) {
    throw new BusinessRuleError('账户尚未开户');
  }
}

function parsePositiveAmount(amount: string, operation: string): Cents {
  let cents: number;
  try {
    cents = parseMoneyToCents(amount);
  } catch {
    throw new BusinessRuleError(`金额非法: ${amount}`, { field: 'amount' });
  }
  if (cents <= 0) {
    throw new BusinessRuleError(`${operation} 金额必须为正数`, { field: 'amount', amountCents: cents });
  }
  return cents;
}
