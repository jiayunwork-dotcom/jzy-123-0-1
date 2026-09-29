import { StoredEvent } from '../eventstore/eventStore';

/**
 * 读模型行：账户列表/余额汇总视图。
 * 写模型里只有事件，没有这张表对应的“实体”，它完全由投影派生、可随时丢弃重建。
 */
export interface AccountReadRow {
  aggregateId: string;
  name: string;
  balanceCents: number;
  version: number;
  eventCount: number;
  openedAt: Date;
  updatedAt: Date;
}

export class ProjectionOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionOrderingError';
  }
}

/**
 * 投影 fold 函数（纯函数）：给定上一版视图行（或 null）与一条事件，得到新版视图行。
 * 增量消费与全量重放都调用它 —— 两条路径共用同一份计算逻辑，
 * 是“重算结果 == 增量结果”这条最要命不变量的结构性保证。
 */
export function applyProjectionEvent(
  row: AccountReadRow | null,
  event: StoredEvent,
): AccountReadRow {
  switch (event.eventType) {
    case 'AccountOpened': {
      if (row !== null) {
        throw new ProjectionOrderingError(
          `账户 ${event.aggregateId} 重复收到 AccountOpened（已有版本 ${row.version}）`,
        );
      }
      return {
        aggregateId: event.aggregateId,
        name: event.payload.name as string,
        balanceCents: Number(event.payload.initialBalanceCents),
        version: event.version,
        eventCount: 1,
        openedAt: event.occurredAt,
        updatedAt: event.occurredAt,
      };
    }
    case 'Deposited': {
      const prev = requireExisting(row, event);
      return {
        ...prev,
        balanceCents: prev.balanceCents + Number(event.payload.amountCents),
        version: event.version,
        eventCount: prev.eventCount + 1,
        updatedAt: event.occurredAt,
      };
    }
    case 'Withdrawn': {
      const prev = requireExisting(row, event);
      return {
        ...prev,
        balanceCents: prev.balanceCents - Number(event.payload.amountCents),
        version: event.version,
        eventCount: prev.eventCount + 1,
        updatedAt: event.occurredAt,
      };
    }
    default:
      throw new ProjectionOrderingError(
        `投影收到未知事件类型: ${event.eventType}`,
      );
  }
}

function requireExisting(row: AccountReadRow | null, event: StoredEvent): AccountReadRow {
  if (row === null) {
    throw new ProjectionOrderingError(
      `账户 ${event.aggregateId} 在没有 AccountOpened 的情况下收到 ${event.eventType}`,
    );
  }
  if (row.version !== event.version - 1) {
    throw new ProjectionOrderingError(
      `账户 ${event.aggregateId} 投影乱序：行版本 ${row.version}，事件版本 ${event.version}`,
    );
  }
  return row;
}
