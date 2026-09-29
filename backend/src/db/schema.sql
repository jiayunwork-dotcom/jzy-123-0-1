-- ============================================================================
-- 事件溯源记账框架 schema (PostgreSQL 16)
-- event_store : 只追加事件流（数据库触发器层面禁止 UPDATE / DELETE）
-- snapshots   : 聚合快照（同样不可改）
-- accounts_rm : 读模型 —— 账户余额汇总投影（可随时 TRUNCATE 全量重建）
-- projection_checkpoint : 投影消费位点
-- ============================================================================

-- 事件流 ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_store (
  global_seq     BIGSERIAL    PRIMARY KEY,
  aggregate_id   TEXT         NOT NULL,
  aggregate_type TEXT         NOT NULL DEFAULT 'account',
  version        BIGINT       NOT NULL,
  event_type     TEXT         NOT NULL,
  payload        JSONB        NOT NULL,
  metadata       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- 同一聚合内版本号唯一（配合事务内 advisory lock 实现乐观并发提交）
  UNIQUE (aggregate_id, version)
);

CREATE INDEX IF NOT EXISTS idx_event_store_aggregate
  ON event_store (aggregate_id, version);

-- 快照 ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshots (
  aggregate_id   TEXT        NOT NULL,
  aggregate_type TEXT        NOT NULL DEFAULT 'account',
  version        BIGINT      NOT NULL,
  state          JSONB       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_id, version)
);

-- 读模型：账户投影 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts_rm (
  aggregate_id  TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  balance_cents BIGINT      NOT NULL,
  version       BIGINT      NOT NULL,
  event_count   BIGINT      NOT NULL,
  opened_at     TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);

-- 投影位点 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projection_checkpoint (
  projection_name TEXT        PRIMARY KEY,
  last_global_seq BIGINT      NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO projection_checkpoint (projection_name, last_global_seq)
VALUES ('accounts', 0)
ON CONFLICT (projection_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 不可变规则：event_store 与 snapshots 只允许 INSERT，禁止 UPDATE / DELETE。
-- TRUNCATE 不拦截（读模型重建/测试清库需要；它属于 DDL 级操作而非业务改写）。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_reject_row_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '表 % 为只追加存储，% 操作被禁止', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_store_immutable ON event_store;
CREATE TRIGGER trg_event_store_immutable
  BEFORE UPDATE OR DELETE ON event_store
  FOR EACH ROW EXECUTE FUNCTION fn_reject_row_mutation();

DROP TRIGGER IF EXISTS trg_snapshots_immutable ON snapshots;
CREATE TRIGGER trg_snapshots_immutable
  BEFORE UPDATE OR DELETE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION fn_reject_row_mutation();
