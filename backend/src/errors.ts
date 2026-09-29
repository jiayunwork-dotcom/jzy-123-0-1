/**
 * 统一的应用错误。HTTP 层据此映射状态码与结构化错误响应体。
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** 400 版本区间非法 */
export class InvalidVersionRangeError extends AppError {
  constructor(fromVersion: number, toVersion: number) {
    super(400, 'INVALID_VERSION_RANGE', `非法版本区间: ${fromVersion}..${toVersion}`, {
      fromVersion,
      toVersion,
    });
  }
}

/** 400 快照版本超出该聚合已有事件范围 */
export class SnapshotOutOfRangeError extends AppError {
  constructor(aggregateId: string, version: number, latestVersion: number) {
    super(
      400,
      'SNAPSHOT_VERSION_OUT_OF_RANGE',
      `快照版本 ${version} 超出聚合最新版本 ${latestVersion}`,
      { aggregateId, version, latestVersion },
    );
  }
}

/** 400 事件流出现版本空洞（正常追加路径不会发生，用于读/重建校验） */
export class VersionGapError extends AppError {
  constructor(aggregateId: string, expected: number, actual: number) {
    super(
      400,
      'EVENT_VERSION_GAP',
      `聚合 ${aggregateId} 事件版本不连续：期望 ${expected}，实际 ${actual}`,
      { aggregateId, expected, actual },
    );
  }
}

/** 404 聚合不存在 */
export class AggregateNotFoundError extends AppError {
  constructor(aggregateId: string) {
    super(404, 'AGGREGATE_NOT_FOUND', `聚合不存在: ${aggregateId}`, { aggregateId });
  }
}

/** 409 在新聚合（expectedVersion=0）上追加时发现已存在 */
export class AggregateAlreadyExistsError extends AppError {
  constructor(aggregateId: string, actualVersion: number) {
    super(
      409,
      'AGGREGATE_ALREADY_EXISTS',
      `聚合 ${aggregateId} 已存在，当前版本为 ${actualVersion}`,
      { aggregateId, actualVersion, currentVersion: actualVersion },
    );
  }
}

/** 409 乐观并发冲突：客户端版本与服务端最新版本不一致 */
export class ConcurrencyError extends AppError {
  constructor(aggregateId: string, expectedVersion: number, actualVersion: number) {
    super(
      409,
      'VERSION_CONFLICT',
      `并发冲突：客户端期望版本 ${expectedVersion}，服务端最新版本 ${actualVersion}`,
      { aggregateId, expectedVersion, actualVersion, currentVersion: actualVersion },
    );
  }
}

/** 409 同一聚合同一版本的快照已存在 */
export class SnapshotAlreadyExistsError extends AppError {
  constructor(aggregateId: string, version: number) {
    super(
      409,
      'SNAPSHOT_ALREADY_EXISTS',
      `聚合 ${aggregateId} 在版本 ${version} 的快照已存在`,
      { aggregateId, version },
    );
  }
}

/** 422 业务规则校验失败（事件生成之前拦截，不产生任何事件） */
export class BusinessRuleError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(422, 'BUSINESS_RULE_VIOLATION', message, details);
  }
}
